import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
  DEFAULT_BROWSER_ENDPOINT,
  downloadThreadAttachment,
  extractPatchAttachmentLabels,
  exportThreadSnapshot,
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
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  pollUntilComplete?: boolean;
  repoDir: string;
  sessionId?: string;
  skipResume?: boolean;
};

export type WakeCompletionStatus = 'checked-once' | 'completed';

export type WakeResult = {
  attemptCount: number;
  completionStatus: WakeCompletionStatus;
  codexBin?: string;
  codexHome?: string;
  downloadedPatches: string[];
  exportPath: string;
  outputDir: string;
  repoDir: string;
  resumeOutputPath?: string;
  sessionId?: string;
};

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

type WakeDependencies = {
  downloadThreadAttachment: typeof downloadThreadAttachment;
  exportThreadSnapshot: typeof exportThreadSnapshot;
  log: (message: string) => void;
  mkdir: typeof mkdir;
  resolveCodexBin: typeof resolveCodexBin;
  resolveCodexHomeForSession: typeof resolveCodexHomeForSession;
  runCommand: typeof runCommand;
  sleep: typeof sleep;
};

const DEFAULT_WAKE_DEPENDENCIES: WakeDependencies = {
  downloadThreadAttachment,
  exportThreadSnapshot,
  log: (message) => {
    process.stderr.write(message);
  },
  mkdir,
  resolveCodexBin,
  resolveCodexHomeForSession,
  runCommand,
  sleep,
};

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'ignore';
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'null'}`));
    });
  });
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

function formatWakePollSummary(snapshot: ThreadSnapshot, patchLabels: string[]): string {
  const statusSummary = snapshot.statusTexts[0]?.trim() || 'none';
  return [
    `busy=${snapshotIndicatesBusy(snapshot) ? 'yes' : 'no'}`,
    `attachments=${patchLabels.length}`,
    `assistantTurns=${snapshot.assistantSnapshots.length}`,
    `status=${JSON.stringify(statusSummary)}`,
  ].join(', ');
}

export function buildWakeResumePrompt(input: {
  downloadedPatches: string[];
  exportPath: string;
  repoDir: string;
}): string {
  const relativeToRepo = (targetPath: string) => path.relative(input.repoDir, targetPath) || '.';
  const lines = [
    'Wake-up task:',
    `- Read the exported ChatGPT thread JSON at ${relativeToRepo(input.exportPath)}.`,
    input.downloadedPatches.length > 0
      ? `- Inspect the downloaded patch, diff, or zip files: ${input.downloadedPatches.map((filePath) => relativeToRepo(filePath)).join(', ')}.`
      : '- No patch, diff, or zip files were downloaded; inspect the thread export and attachment labels to determine why.',
    '- Implement the returned changes in this repository if they are applicable.',
    '- Run the repo-required verification commands and report any unrelated blockers separately.',
    '- Keep changes scoped to what the downloaded artifacts actually require.',
  ];
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
  const exportPath = path.join(resolvedOutputDir, 'thread.json');
  const resumeOutputPath = path.join(resolvedOutputDir, 'codex-last-message.md');
  const downloadDir = path.join(resolvedOutputDir, 'downloads');
  const browserEndpoint = options.browserEndpoint ?? DEFAULT_BROWSER_ENDPOINT;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const pollIntervalMs = requirePositiveDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'Poll interval') ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = requirePositiveDuration(options.pollTimeoutMs, 'Poll timeout');
  const pollUntilComplete = options.pollUntilComplete === true;
  const resolvedCodexBin = options.skipResume ? undefined : wakeDependencies.resolveCodexBin();
  const resolvedCodexHome = resolveWakeCodexHome(options, wakeDependencies);

  await wakeDependencies.mkdir(downloadDir, { recursive: true });

  wakeDependencies.log(
    [
      `Sleeping for ${options.delayMs}ms before checking ${options.chatUrl}.`,
      `Repo dir: ${formatPathForDisplay(resolvedRepoDir, resolvedRepoDir)}`,
      `Output dir: ${formatPathForDisplay(resolvedOutputDir, resolvedRepoDir)}`,
      resolvedCodexBin ? `Codex bin: ${formatPathForDisplay(resolvedCodexBin, resolvedRepoDir)}` : 'Codex bin: skipped',
      resolvedCodexHome ? `Codex home: ${formatCodexHomeForDisplay(resolvedCodexHome.homePath)} (${resolvedCodexHome.resolution})` : 'Codex resume: skipped',
      options.sessionId ? `Session ID: ${options.sessionId}` : 'Session ID: (none)',
      pollUntilComplete ? `Polling: enabled (${pollIntervalMs}ms interval${pollTimeoutMs ? `, ${pollTimeoutMs}ms timeout` : ''})` : 'Polling: disabled',
    ].join('\n') + '\n',
  );

  await wakeDependencies.sleep(options.delayMs);

  let attemptCount = 0;
  let completionStatus: WakeCompletionStatus = 'checked-once';
  let snapshot!: ThreadSnapshot;
  let patchLabels: string[] = [];
  const pollStartedAt = Date.now();

  for (;;) {
    attemptCount += 1;
    snapshot = await wakeDependencies.exportThreadSnapshot(browserEndpoint, options.chatUrl, exportPath);
    patchLabels = extractPatchAttachmentLabels(snapshot);
    const busy = snapshotIndicatesBusy(snapshot);

    wakeDependencies.log(
      `Wake check ${attemptCount}: ${formatWakePollSummary(snapshot, patchLabels)}.\n`,
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
    wakeDependencies.log(`Thread still looks busy; polling again in ${pollIntervalMs}ms.\n`);
    await wakeDependencies.sleep(pollIntervalMs);
  }

  const downloadedPatches: string[] = [];

  for (const label of patchLabels) {
    const downloadedFile = await wakeDependencies.downloadThreadAttachment(
      browserEndpoint,
      options.chatUrl,
      label,
      downloadDir,
      downloadTimeoutMs,
    );
    downloadedPatches.push(downloadedFile);
  }

  if (options.skipResume) {
    return {
      attemptCount,
      completionStatus,
      downloadedPatches,
      codexBin: resolvedCodexBin,
      exportPath,
      outputDir: resolvedOutputDir,
      repoDir: resolvedRepoDir,
    };
  }

  if (!resolvedCodexHome || !options.sessionId) {
    throw new Error('Resolved Codex home and session ID are required before resume.');
  }

  const resumeArgs = [
    'exec',
    'resume',
    options.sessionId,
    buildWakeResumePrompt({
      downloadedPatches,
      exportPath,
      repoDir: resolvedRepoDir,
    }),
    '--output-last-message',
    resumeOutputPath,
  ];
  if (options.fullAuto !== false) {
    resumeArgs.push('--full-auto');
  }

  await wakeDependencies.runCommand(resolvedCodexBin ?? 'codex', resumeArgs, {
    cwd: resolvedRepoDir,
    env: {
      ...process.env,
      CODEX_HOME: resolvedCodexHome.homePath,
    },
  });

  return {
    attemptCount,
    completionStatus,
    codexBin: resolvedCodexBin,
    codexHome: resolvedCodexHome.homePath,
    downloadedPatches,
    exportPath,
    outputDir: resolvedOutputDir,
    repoDir: resolvedRepoDir,
    resumeOutputPath,
    sessionId: options.sessionId,
  };
}
