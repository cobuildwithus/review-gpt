import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assistantSnapshotLooksIncomplete,
  DEFAULT_BROWSER_ENDPOINT,
  downloadThreadAttachment,
  extractPatchAttachmentLabels,
  exportThreadSnapshot,
  snapshotBusyReason,
  snapshotIndicatesBusy,
  sleep,
  type ThreadSnapshot,
} from './chatgpt-thread-lib.mjs';
import {
  formatCodexHomeForDisplay,
  formatPathForDisplay,
  resolveCodexBin,
  type ResolvedCodexHome,
  resolveCodexHomeForSession,
} from './codex-session-lib.mjs';

export type WakeOptions = {
  browserEndpoint?: string;
  chatUrl: string;
  codexHome?: string;
  delayMs: number;
  downloadTimeoutMs?: number;
  fullAuto?: boolean;
  outputDir: string;
  pollJitterMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  pollUntilComplete?: boolean;
  repoDir: string;
  resumePrompt?: string;
  sessionId?: string;
  skipResume?: boolean;
};

export type WakeCompletionStatus = 'checked-once' | 'completed';

export type WakeResult = {
  attemptCount: number;
  childSessionId?: string;
  completionStatus: WakeCompletionStatus;
  codexBin?: string;
  codexHome?: string;
  downloadedPatches: string[];
  eventsPath?: string;
  exportPath: string;
  outputDir: string;
  replayCommandsPath?: string;
  repoDir: string;
  resumeOutputPath?: string;
  sessionId?: string;
  statusPath?: string;
};

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_HANDOFF_GRACE_MS = 1_500;
const DEFAULT_INITIAL_POLL_JITTER_CAP_MS = 15_000;
const DEFAULT_MAX_CONSECUTIVE_EXPORT_FAILURES = 3;
const DEFAULT_POLL_JITTER_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

type WakeState = 'waiting' | 'downloading' | 'spawning' | 'running' | 'succeeded' | 'failed';

type WakeStatus = {
  attemptCount: number;
  chatUrl: string;
  childSessionId?: string;
  codexBin?: string;
  codexHome?: string;
  completionStatus?: WakeCompletionStatus;
  downloadedPatches: string[];
  exportPath: string;
  lastError?: string;
  lastAssistantPreview?: string;
  lastBusyReason?: string;
  lastPatchLabels?: string[];
  lastSnapshotSummary?: string;
  outputDir: string;
  replayCommandsPath?: string;
  repoDir: string;
  sessionId?: string;
  state: WakeState;
  updatedAt: string;
};

type CodexChildSessionLaunch = {
  launcherPid?: number;
};

type WakeDependencies = {
  downloadThreadAttachment: typeof downloadThreadAttachment;
  exportThreadSnapshot: typeof exportThreadSnapshot;
  log: (message: string) => void;
  mkdir: typeof mkdir;
  random: () => number;
  resolveCodexBin: typeof resolveCodexBin;
  resolveCodexHomeForSession: typeof resolveCodexHomeForSession;
  resolveExpectBin: typeof resolveExpectBin;
  runCodexChildSession: typeof runCodexChildSession;
  sleep: typeof sleep;
  writeFile: typeof writeFile;
};

const DEFAULT_WAKE_DEPENDENCIES: WakeDependencies = {
  downloadThreadAttachment,
  exportThreadSnapshot,
  log: (message) => {
    process.stderr.write(message);
  },
  mkdir,
  random: Math.random,
  resolveCodexBin,
  resolveCodexHomeForSession,
  resolveExpectBin,
  runCodexChildSession,
  sleep,
  writeFile,
};

function runCodexChildSession(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    expectBin?: string;
  },
): Promise<CodexChildSessionLaunch> {
  return new Promise((resolve, reject) => {
    const expectBin = resolveExpectBin({
      expectBin: options.expectBin,
      envExpectBin: options.env?.EXPECT_BIN,
      envPath: options.env?.PATH,
    });
    const expectScript = [
      'log_user 1',
      'set timeout -1',
      'spawn -noecho {*}$argv',
      'after 750',
      'send -- "\\r"',
      'expect eof',
      'catch wait result',
      'set exitCode [lindex $result 3]',
      'if {$exitCode eq ""} {',
      '  set exitCode 0',
      '}',
      'exit $exitCode',
      '',
    ].join('\n');
    const child = spawn(expectBin, ['-f', '-', '--', command, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    let settled = false;
    let handoffTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (handoffTimer) {
        clearTimeout(handoffTimer);
        handoffTimer = undefined;
      }
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('spawn', onSpawn);
      child.stdin?.removeListener('error', onStdinError);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.unref();
      resolve({
        launcherPid: child.pid ?? undefined,
      });
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onStdinError = (error: Error) => {
      fail(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail =
        code !== null
          ? `code ${code}`
          : signal
            ? `signal ${signal}`
            : 'an unknown status';
      fail(new Error(`expect-launched ${command} exited before handoff with ${detail}`));
    };

    const onSpawn = () => {
      child.stdin?.end(expectScript);
      handoffTimer = setTimeout(succeed, DEFAULT_HANDOFF_GRACE_MS);
      handoffTimer.unref?.();
    };

    child.on('error', onError);
    child.stdin?.on('error', onStdinError);
    child.on('exit', onExit);
    child.on('spawn', onSpawn);
  });
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function listDefaultExpectBins(
  envPath = process.env.PATH,
  envExpectBin = process.env.EXPECT_BIN,
): string[] {
  const seen = new Set<string>();
  const bins: string[] = [];
  const addCandidate = (candidate: string | undefined) => {
    const trimmed = String(candidate ?? '').trim();
    if (!trimmed) {
      return;
    }
    const resolved = path.resolve(trimmed);
    if (!isExecutableFile(resolved) || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    bins.push(resolved);
  };

  addCandidate(envExpectBin);

  for (const entry of String(envPath ?? '').split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    addCandidate(path.join(entry, 'expect'));
  }

  addCandidate('/opt/homebrew/bin/expect');
  addCandidate('/usr/local/bin/expect');
  addCandidate('/usr/bin/expect');
  return bins;
}

export function resolveExpectBin(
  options: {
    candidateBins?: string[];
    envExpectBin?: string;
    envPath?: string;
    expectBin?: string;
  } = {},
): string {
  if (options.expectBin) {
    const explicit = path.resolve(options.expectBin);
    if (!isExecutableFile(explicit)) {
      throw new Error(`Configured expect binary is not executable: ${explicit}`);
    }
    return explicit;
  }

  const candidates =
    options.candidateBins ??
    listDefaultExpectBins(options.envPath ?? process.env.PATH, options.envExpectBin ?? process.env.EXPECT_BIN);
  if (candidates.length > 0) {
    return candidates[0] as string;
  }

  throw new Error(
    'Could not find an executable expect launcher. Install expect, expose it in PATH, or set EXPECT_BIN before using thread wake resume.',
  );
}

export function chatIdFromUrl(chatUrl: string): string {
  const lastSegment = new URL(chatUrl).pathname.split('/').filter(Boolean).at(-1);
  return lastSegment ?? 'chat';
}

export function parseWakeDelayToMs(rawValue: string): number {
  const normalized = rawValue.trim();
  const compact = normalized.replace(/\s+/gu, '');
  if (!compact) {
    throw new Error('Delay cannot be empty.');
  }

  if (/^\d+$/u.test(compact)) {
    return Number.parseInt(compact, 10);
  }

  const matches = [...compact.matchAll(/(\d+)(ms|s|m|h|d)/giu)];
  if (matches.length === 0 || matches.map((match) => match[0]).join('') !== compact) {
    throw new Error('Unsupported delay format. Use values like 300s, 70m, 1h, or 1h30m.');
  }

  const unitMs: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    ms: 1,
    s: 1_000,
  };

  const totalMs = matches.reduce((sum, match) => {
    const value = Number.parseInt(match[1] ?? '0', 10);
    const unit = String(match[2] ?? '').toLowerCase();
    return sum + value * (unitMs[unit] ?? 0);
  }, 0);

  if (!Number.isFinite(totalMs) || totalMs < 0) {
    throw new Error('Delay must resolve to a non-negative duration.');
  }

  return totalMs;
}

function requirePositiveDuration(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must resolve to a positive duration.`);
  }
  return value;
}

function requireNonNegativeDuration(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must resolve to a non-negative duration.`);
  }
  return value;
}

function computeWakePollDelay(
  pollIntervalMs: number,
  pollJitterMs: number,
  random: () => number,
): number {
  if (pollJitterMs <= 0) {
    return pollIntervalMs;
  }
  const randomValue = random();
  const jitterFactor = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
  return pollIntervalMs + Math.floor(jitterFactor * pollJitterMs);
}

function computeWakeStartupJitterDelay(
  pollUntilComplete: boolean,
  pollJitterMs: number,
  random: () => number,
): number {
  if (!pollUntilComplete || pollJitterMs <= 0) {
    return 0;
  }
  const startupJitterCapMs = Math.min(pollJitterMs, DEFAULT_INITIAL_POLL_JITTER_CAP_MS);
  if (startupJitterCapMs <= 0) {
    return 0;
  }
  const randomValue = random();
  const jitterFactor = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
  return Math.floor(jitterFactor * startupJitterCapMs);
}

function formatWakePollDelay(
  delayMs: number,
  pollIntervalMs: number,
  pollJitterMs: number,
): string {
  if (pollJitterMs <= 0) {
    return `${delayMs}ms`;
  }
  return `${delayMs}ms (${pollIntervalMs}ms base + up to ${pollJitterMs}ms jitter)`;
}

export function formatWakePollSummary(snapshot: ThreadSnapshot, patchLabels: string[]): string {
  const statusSummary =
    snapshot.statusTexts
      .map((value) => value.trim())
      .find((value) => value.length > 0 && value.toLowerCase() !== 'deep research') ?? 'none';
  const lastAssistantPreview = summarizeAssistantPreview(snapshot);
  const busyReason = snapshotBusyReason(snapshot);
  return [
    `busy=${snapshotIndicatesBusy(snapshot) ? 'yes' : 'no'}`,
    `attachments=${patchLabels.length}`,
    `assistantTurns=${snapshot.assistantSnapshots.length}`,
    `status=${JSON.stringify(statusSummary)}`,
    `reason=${JSON.stringify(busyReason)}`,
    `lastAssistant=${JSON.stringify(lastAssistantPreview)}`,
  ].join(', ');
}

function summarizeAssistantPreview(snapshot: Pick<ThreadSnapshot, 'assistantSnapshots'>): string {
  const latestRequestSnapshots = snapshot.assistantSnapshots.some((assistantSnapshot) => typeof assistantSnapshot.afterLastUserMessage === 'boolean')
    ? snapshot.assistantSnapshots.filter((assistantSnapshot) => assistantSnapshot.afterLastUserMessage === true)
    : snapshot.assistantSnapshots;
  const value = String(latestRequestSnapshots.at(-1)?.text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (value.length === 0) {
    return 'none';
  }
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

function expandResumePromptTemplate(
  template: string,
  input: {
    chatUrl: string;
  },
): string {
  return template
    .replaceAll('{{chat_url}}', input.chatUrl)
    .replaceAll('{{chat_id}}', chatIdFromUrl(input.chatUrl));
}

export function buildWakeFollowupPrompt(input: {
  chatUrl: string;
  downloadedPatches: string[];
  exportPath: string;
  replayCommandsPath?: string;
  resumePrompt?: string;
  repoDir: string;
}): string {
  const relativeToRepo = (targetPath: string) => path.relative(input.repoDir, targetPath) || '.';
  const lines = [
    'Wake-up task:',
    `- The watched ChatGPT thread URL is ${input.chatUrl}.`,
    `- Read the exported ChatGPT thread JSON at ${relativeToRepo(input.exportPath)}.`,
    input.downloadedPatches.length > 0
      ? `- Inspect the downloaded patch, diff, or zip files already on disk at: ${input.downloadedPatches.map((filePath) => relativeToRepo(filePath)).join(', ')}.`
      : '- No patch, diff, or zip files were downloaded; inspect the thread export and attachment labels to determine why.',
    input.replayCommandsPath
      ? `- If you need to refresh the thread export or re-download an attachment, run bash ${relativeToRepo(input.replayCommandsPath)} instead of pnpm exec so stale workspace installs do not block you.`
      : '- If you need to refresh the thread export or re-download an attachment, invoke the review-gpt CLI directly instead of relying on pnpm exec in the consumer repo.',
    '- Implement the returned changes in this repository if they are applicable.',
    '- Run the repo-required verification commands and report any unrelated blockers separately.',
    '- Keep changes scoped to what the downloaded artifacts actually require.',
  ];
  const extraPrompt = input.resumePrompt?.trim();
  if (extraPrompt) {
    lines.push(
      '',
      'Additional instructions:',
      expandResumePromptTemplate(extraPrompt, {
        chatUrl: input.chatUrl,
      }),
    );
  }
  return lines.join('\n');
}

function resolveWakeCodexHome(
  options: WakeOptions,
  dependencies: Pick<WakeDependencies, 'resolveCodexHomeForSession'>,
): ResolvedCodexHome | undefined {
  if (options.skipResume) {
    return undefined;
  }
  if (!options.sessionId) {
    throw new Error('Session ID is required unless --skip-resume is set.');
  }
  return dependencies.resolveCodexHomeForSession(options.sessionId, {
    codexHome: options.codexHome,
  });
}

function quoteShellArg(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function directReviewGptCommand(args: string[]): string {
  const cliEntryPath = fileURLToPath(new URL('./bin.mjs', import.meta.url));
  return [process.execPath, cliEntryPath, ...args].map(quoteShellArg).join(' ');
}

function buildWakeReplayCommands(input: {
  browserEndpoint: string;
  chatUrl: string;
  downloadDir: string;
  exportPath: string;
  patchLabels: string[];
}): string {
  const baseArgs = ['--browser-endpoint', input.browserEndpoint, '--chat-url', input.chatUrl];
  const exportCommand = directReviewGptCommand([
    'thread',
    'export',
    ...baseArgs,
    '--output',
    input.exportPath,
  ]);
  const explicitDownloadCommands = input.patchLabels.map((label) =>
    directReviewGptCommand([
      'thread',
      'download',
      ...baseArgs,
      '--attachment-text',
      label,
      '--output-dir',
      input.downloadDir,
    ]),
  );
  const placeholderDownloadCommand = directReviewGptCommand([
    'thread',
    'download',
    ...baseArgs,
    '--attachment-text',
    '<attachment-label>',
    '--output-dir',
    input.downloadDir,
  ]);

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Refresh the saved thread export without relying on the consumer repo\'s pnpm workspace state.',
    exportCommand,
    '',
    '# Re-download the current assistant attachment labels into the wake downloads directory.',
  ];

  if (explicitDownloadCommands.length > 0) {
    lines.push(...explicitDownloadCommands);
  } else {
    lines.push('# No patch/diff labels were present in the latest export.');
  }

  lines.push(
    '',
    '# Replace <attachment-label> with any visible attachment button text from thread.json when needed.',
    placeholderDownloadCommand,
    '',
  );
  return lines.join('\n');
}

export async function runWakeFlow(
  options: WakeOptions,
  dependencies: Partial<WakeDependencies> = {},
): Promise<WakeResult> {
  const wakeDependencies: WakeDependencies = {
    ...DEFAULT_WAKE_DEPENDENCIES,
    ...dependencies,
  };
  const resolvedRepoDir = path.resolve(options.repoDir);
  const resolvedOutputDir = path.resolve(options.outputDir);
  const statusPath = path.join(resolvedOutputDir, 'status.json');
  const exportPath = path.join(resolvedOutputDir, 'thread.json');
  const downloadDir = path.join(resolvedOutputDir, 'downloads');
  const replayCommandsPath = path.join(resolvedOutputDir, 'wake-commands.sh');
  const browserEndpoint = options.browserEndpoint ?? DEFAULT_BROWSER_ENDPOINT;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const pollJitterMs =
    requireNonNegativeDuration(options.pollJitterMs ?? DEFAULT_POLL_JITTER_MS, 'Poll jitter') ?? DEFAULT_POLL_JITTER_MS;
  const pollIntervalMs = requirePositiveDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'Poll interval') ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = requirePositiveDuration(options.pollTimeoutMs, 'Poll timeout');
  const pollUntilComplete = options.pollUntilComplete !== false;
  const startupJitterCapMs = pollUntilComplete ? Math.min(pollJitterMs, DEFAULT_INITIAL_POLL_JITTER_CAP_MS) : 0;
  let resolvedCodexBin: string | undefined;
  let resolvedCodexHome: ResolvedCodexHome | undefined;
  let resolvedExpectBin: string | undefined;
  let childSessionId: string | undefined;
  let consecutiveExportFailures = 0;
  let attemptCount = 0;
  let completionStatus: WakeCompletionStatus = 'checked-once';
  const downloadedPatches: string[] = [];
  let lastSuccessfulSnapshot: ThreadSnapshot | undefined;
  let lastSuccessfulPatchLabels: string[] = [];
  let lastAssistantPreview: string | undefined;
  let lastBusyReason: string | undefined;
  let lastSnapshotSummary: string | undefined;

  const writeWakeStatus = async (state: WakeState, extra: Partial<WakeStatus> = {}) => {
    const status: WakeStatus = {
      attemptCount,
      chatUrl: options.chatUrl,
      childSessionId,
      codexBin: resolvedCodexBin,
      codexHome: resolvedCodexHome?.homePath,
      completionStatus,
      downloadedPatches,
      exportPath,
      lastAssistantPreview,
      lastBusyReason,
      outputDir: resolvedOutputDir,
      lastPatchLabels: lastSuccessfulPatchLabels,
      replayCommandsPath,
      repoDir: resolvedRepoDir,
      sessionId: options.sessionId,
      lastSnapshotSummary,
      state,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    await wakeDependencies.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  };

  await wakeDependencies.mkdir(downloadDir, { recursive: true });
  await writeWakeStatus('waiting');

  let snapshot!: ThreadSnapshot;
  let patchLabels: string[] = [];
  const pollStartedAt = Date.now();
  try {
    if (!options.skipResume) {
      resolvedCodexBin = wakeDependencies.resolveCodexBin();
      resolvedCodexHome = resolveWakeCodexHome(options, wakeDependencies);
      resolvedExpectBin = wakeDependencies.resolveExpectBin();
      await writeWakeStatus('waiting');
    }

    wakeDependencies.log(
      [
        `Sleeping for ${options.delayMs}ms before checking ${options.chatUrl}.`,
        `Repo dir: ${formatPathForDisplay(resolvedRepoDir, resolvedRepoDir)}`,
        `Output dir: ${formatPathForDisplay(resolvedOutputDir, resolvedRepoDir)}`,
        resolvedCodexBin ? `Codex bin: ${formatPathForDisplay(resolvedCodexBin, resolvedRepoDir)}` : 'Codex bin: skipped',
        resolvedCodexHome ? `Codex home: ${formatCodexHomeForDisplay(resolvedCodexHome.homePath)} (${resolvedCodexHome.resolution})` : 'Codex resume: skipped',
        resolvedExpectBin ? `Expect bin: ${formatPathForDisplay(resolvedExpectBin, resolvedRepoDir)}` : 'Expect bin: skipped',
        options.sessionId ? `Session ID: ${options.sessionId}` : 'Session ID: (none)',
        pollUntilComplete
          ? `Polling: enabled (${pollIntervalMs}ms interval${pollJitterMs > 0 ? `, +0-${pollJitterMs}ms jitter` : ''}${startupJitterCapMs > 0 ? `, +0-${startupJitterCapMs}ms startup spread` : ''}${pollTimeoutMs ? `, ${pollTimeoutMs}ms timeout` : ''}, ${DEFAULT_MAX_CONSECUTIVE_EXPORT_FAILURES} transient export retries)`
          : 'Polling: disabled',
      ].join('\n') + '\n',
    );

    await wakeDependencies.sleep(options.delayMs);
    const startupJitterDelayMs = computeWakeStartupJitterDelay(pollUntilComplete, pollJitterMs, wakeDependencies.random);
    if (startupJitterDelayMs > 0) {
      wakeDependencies.log(
        `Applying ${startupJitterDelayMs}ms startup jitter before the first thread export so simultaneous wake runs spread out.\n`,
      );
      await wakeDependencies.sleep(startupJitterDelayMs);
    }

    for (;;) {
      attemptCount += 1;
      try {
        snapshot = await wakeDependencies.exportThreadSnapshot(browserEndpoint, options.chatUrl, exportPath);
      } catch (error) {
        if (!pollUntilComplete) {
          throw error;
        }
        consecutiveExportFailures += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (pollTimeoutMs !== undefined && Date.now() - pollStartedAt >= pollTimeoutMs) {
          throw new Error(
            `Timed out waiting for ${options.chatUrl} to finish after ${attemptCount} checks because thread export kept failing. Last error: ${errorMessage}`,
          );
        }
        if (!lastSuccessfulSnapshot && consecutiveExportFailures >= DEFAULT_MAX_CONSECUTIVE_EXPORT_FAILURES) {
          throw new Error(
            `Failed to export ${options.chatUrl} after ${consecutiveExportFailures} consecutive polling errors. Last error: ${errorMessage}`,
          );
        }
        const nextDelayMs = computeWakePollDelay(pollIntervalMs, pollJitterMs, wakeDependencies.random);
        wakeDependencies.log(
          `Wake check ${attemptCount}: export failed (${consecutiveExportFailures}/${DEFAULT_MAX_CONSECUTIVE_EXPORT_FAILURES} transient retries used): ${errorMessage}.\n`,
        );
        if (lastSuccessfulSnapshot) {
          wakeDependencies.log(
            `Preserving the last successful snapshot while export is flaky. Last good export: ${formatWakePollSummary(lastSuccessfulSnapshot, lastSuccessfulPatchLabels)}.\n`,
          );
        }
        wakeDependencies.log(
          `Thread export failed; polling again in ${formatWakePollDelay(nextDelayMs, pollIntervalMs, pollJitterMs)}.\n`,
        );
        await wakeDependencies.sleep(nextDelayMs);
        continue;
      }
      consecutiveExportFailures = 0;
      patchLabels = extractPatchAttachmentLabels(snapshot);
      lastSuccessfulSnapshot = snapshot;
      lastSuccessfulPatchLabels = patchLabels;
      let busy = snapshotIndicatesBusy(snapshot);
      let busyReason = snapshotBusyReason(snapshot);
      let forcedReload = false;

      if (busyReason === 'assistant-fragment' && patchLabels.length === 0 && assistantSnapshotLooksIncomplete(snapshot)) {
        forcedReload = true;
        wakeDependencies.log(
          `Wake check ${attemptCount}: saw an idle-looking assistant fragment (${JSON.stringify(summarizeAssistantPreview(snapshot))}); forcing one immediate refresh before deciding the thread is complete.\n`,
        );
        snapshot = await wakeDependencies.exportThreadSnapshot(browserEndpoint, options.chatUrl, exportPath, {
          forceReload: true,
        });
        patchLabels = extractPatchAttachmentLabels(snapshot);
        lastSuccessfulSnapshot = snapshot;
        lastSuccessfulPatchLabels = patchLabels;
        busy = snapshotIndicatesBusy(snapshot);
        busyReason = snapshotBusyReason(snapshot);
      }

      lastAssistantPreview = summarizeAssistantPreview(snapshot);
      lastBusyReason = busyReason;
      lastSnapshotSummary = formatWakePollSummary(snapshot, patchLabels);
      await writeWakeStatus('waiting');

      wakeDependencies.log(
        `Wake check ${attemptCount}: ${lastSnapshotSummary}${forcedReload ? ' (after forced refresh)' : ''}.\n`,
      );

      if (!pollUntilComplete) {
        break;
      }
      if (!busy) {
        completionStatus = 'completed';
        break;
      }
      if (pollTimeoutMs !== undefined && Date.now() - pollStartedAt >= pollTimeoutMs) {
        throw new Error(
          `Timed out waiting for ${options.chatUrl} to finish after ${attemptCount} checks. Last export: ${formatPathForDisplay(exportPath, resolvedRepoDir)}`,
        );
      }
      const nextDelayMs = computeWakePollDelay(pollIntervalMs, pollJitterMs, wakeDependencies.random);
      wakeDependencies.log(
        `Thread still looks busy; polling again in ${formatWakePollDelay(nextDelayMs, pollIntervalMs, pollJitterMs)}.\n`,
      );
      await wakeDependencies.sleep(nextDelayMs);
    }

    await writeWakeStatus('downloading');
    for (const label of patchLabels) {
      const downloadedFile = await wakeDependencies.downloadThreadAttachment(
        browserEndpoint,
        options.chatUrl,
        label,
        downloadDir,
        downloadTimeoutMs,
      );
      downloadedPatches.push(downloadedFile);
      await writeWakeStatus('downloading');
    }

    await wakeDependencies.writeFile(
      replayCommandsPath,
      buildWakeReplayCommands({
        browserEndpoint,
        chatUrl: options.chatUrl,
        downloadDir,
        exportPath,
        patchLabels,
      }),
      'utf8',
    );

    if (options.skipResume) {
      await writeWakeStatus('succeeded');
      return {
        attemptCount,
        completionStatus,
        codexBin: resolvedCodexBin,
        downloadedPatches,
        exportPath,
        outputDir: resolvedOutputDir,
        replayCommandsPath,
        repoDir: resolvedRepoDir,
        statusPath,
      };
    }

    if (!resolvedCodexHome || !options.sessionId) {
      throw new Error('Resolved Codex home and session ID are required before starting the child Codex run.');
    }

    const childArgs = ['-C', resolvedRepoDir];
    if (options.fullAuto === true) {
      childArgs.push('--full-auto');
    }
    childArgs.push(
      buildWakeFollowupPrompt({
        chatUrl: options.chatUrl,
        downloadedPatches,
        exportPath,
        replayCommandsPath,
        resumePrompt: options.resumePrompt,
        repoDir: resolvedRepoDir,
      }),
    );

    await writeWakeStatus('spawning');
    await writeWakeStatus('running');
    await wakeDependencies.runCodexChildSession(
      resolvedCodexBin ?? 'codex',
      childArgs,
      {
        cwd: resolvedRepoDir,
        env: {
          ...process.env,
          CODEX_HOME: resolvedCodexHome.homePath,
        },
        expectBin: resolvedExpectBin,
      },
    );
    await writeWakeStatus('succeeded');

    return {
      attemptCount,
      childSessionId,
      completionStatus,
      codexBin: resolvedCodexBin,
      codexHome: resolvedCodexHome.homePath,
      downloadedPatches,
      exportPath,
      outputDir: resolvedOutputDir,
      replayCommandsPath,
      repoDir: resolvedRepoDir,
      sessionId: options.sessionId,
      statusPath,
    };
  } catch (error) {
    await writeWakeStatus('failed', {
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
