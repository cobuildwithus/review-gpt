import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BROWSER_ENDPOINT,
  downloadThreadAttachment,
  extractAssistantArtifactLabels,
  extractAssistantDownloadTargets,
  exportThreadSnapshot,
  snapshotBusyReason,
  snapshotIndicatesBusy,
  sleep,
  type ThreadSnapshot,
} from './chatgpt-thread-lib.mjs';
import {
  formatCodexHomeForDisplay,
  formatPathForDisplay,
  homeContainsSession,
  listCodexSessionEvidence,
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
  recursiveDepth?: number;
  recursivePrompt?: string;
  repoDir: string;
  resumePrompt?: string;
  sessionId?: string;
  skipResume?: boolean;
};

export type WakeCompletionStatus = 'checked-once' | 'completed';

export type WakeResult = {
  attemptCount: number;
  childSessionPersistence?: 'pending' | 'verified';
  childSessionId?: string;
  childRolloutPath?: string;
  completionStatus: WakeCompletionStatus;
  codexBin?: string;
  codexHome?: string;
  downloadErrors?: string[];
  downloadedArtifacts?: string[];
  downloadedPatches: string[];
  eventsPath?: string;
  exportPath: string;
  launcherPid?: number;
  outputDir: string;
  recursive?: WakeRecursiveInfo;
  replayCommandsPath?: string;
  repoDir: string;
  stderrPath?: string;
  resumeOutputPath?: string;
  sessionId?: string;
  statusPath?: string;
};

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_CHILD_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_CHILD_SESSION_POLL_MS = 250;
const DEFAULT_INITIAL_POLL_JITTER_CAP_MS = 15_000;
const DEFAULT_MAX_CONSECUTIVE_EXPORT_FAILURES = 3;
const DEFAULT_STABLE_IDLE_POLLS_REQUIRED = 2;
const DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD = 3;
const DEFAULT_POLL_JITTER_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RECURSIVE_REVIEW_SEND_TIMEOUT_MS = 300_000;
const DEFAULT_RECURSIVE_REVIEW_PROMPT =
  'Check my changes around the target area addressed in this thread for bugs/issues before production. Then review the same area thoroughly for architecture simplification. We are greenfield and want the simplest best long-term architecture. Return a .patch or .diff attachment with your changes. Keep the patch scoped to this target area, include any needed tests, and note assumptions briefly.';

type WakeState = 'waiting' | 'downloading' | 'spawning' | 'running' | 'succeeded' | 'failed';

export type WakeRecursiveInfo = {
  descendantOutputDir: string;
  descendantStatusPath: string;
  descendantWakeLaunchPath: string;
  descendantWakeLogPath: string;
  followupReceiptPath: string;
  followupScriptPath: string;
  nextDepth: number;
  requestedDepth: number;
  reviewSendLogPath: string;
  reviewTimeoutMs: number;
};

type WakeStatus = {
  attemptCount: number;
  chatUrl: string;
  childSessionPersistence?: 'pending' | 'verified';
  childSessionId?: string;
  childRolloutPath?: string;
  codexBin?: string;
  codexHome?: string;
  completionStatus?: WakeCompletionStatus;
  downloadErrors?: string[];
  downloadedArtifacts?: string[];
  downloadedPatches: string[];
  eventsPath?: string;
  exportPath: string;
  launcherPid?: number;
  lastError?: string;
  lastArtifactLabels?: string[];
  lastAssistantPreview?: string;
  lastBusyReason?: string;
  lastPatchLabels?: string[];
  lastSnapshotSummary?: string;
  forceReloadNextExport?: boolean;
  forcedReloadCount?: number;
  outputDir: string;
  recursive?: WakeRecursiveInfo;
  replayCommandsPath?: string;
  repoDir: string;
  stderrPath?: string;
  sessionId?: string;
  staleSnapshotPolls?: number;
  staleSnapshotThreshold?: number;
  state: WakeState;
  resumeOutputPath?: string;
  updatedAt: string;
};

type CodexChildSessionLaunch = {
  childSessionPersistence?: 'pending' | 'verified';
  childSessionId?: string;
  childRolloutPath?: string;
  eventsPath?: string;
  launcherPid?: number;
  resumeOutputPath?: string;
  stderrPath?: string;
};

type WakeDependencies = {
  downloadThreadAttachment: typeof downloadThreadAttachment;
  exportThreadSnapshot: typeof exportThreadSnapshot;
  log: (message: string) => void;
  mkdir: typeof mkdir;
  random: () => number;
  resolveCodexBin: typeof resolveCodexBin;
  resolveCodexHomeForSession: typeof resolveCodexHomeForSession;
  runCodexChildSession: typeof runCodexChildSession;
  sleep: typeof sleep;
  writeFile: typeof writeFile;
};

type ShellCommandPart = string | { raw: string };

function resolveChildSessionPersistence(codexHome: string, childSessionId: string): {
  childRolloutPath?: string;
  childSessionPersistence: 'pending' | 'verified';
} {
  const childRolloutPath = listCodexSessionEvidence(codexHome).find(
    (record) =>
      record.sessionId === childSessionId &&
      record.source === 'session-log' &&
      typeof record.filePath === 'string',
  )?.filePath;

  return {
    childRolloutPath,
    childSessionPersistence: homeContainsSession(codexHome, childSessionId) ? 'verified' : 'pending',
  };
}

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
  runCodexChildSession,
  sleep,
  writeFile,
};

function runCodexChildSession(
  command: string,
  args: string[],
  options: {
    codexHome: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    eventsPath?: string;
    resumeOutputPath?: string;
    stderrPath?: string;
  },
): Promise<CodexChildSessionLaunch> {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd ?? process.cwd();
    const eventsPath = options.eventsPath ?? path.join(cwd, 'child-events.jsonl');
    const stderrPath = options.stderrPath ?? path.join(cwd, 'child-stderr.log');
    const eventFd = openSync(eventsPath, 'a');
    const stderrFd = openSync(stderrPath, 'a');
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', eventFd, stderrFd],
    });
    const launchStartedAt = Date.now();
    let settled = false;
    let sessionDiscoveryTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      closeSync(eventFd);
      closeSync(stderrFd);
      if (sessionDiscoveryTimer) {
        clearTimeout(sessionDiscoveryTimer);
        sessionDiscoveryTimer = undefined;
      }
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = (launch: CodexChildSessionLaunch) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.unref();
      resolve(launch);
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail =
        code !== null
          ? `code ${code}`
          : signal
            ? `signal ${signal}`
            : 'an unknown status';
      fail(new Error(`codex-exec ${command} exited before handoff with ${detail}`));
    };

    const readJsonlEvents = (): unknown[] => {
      if (!existsSync(eventsPath)) {
        return [];
      }

      try {
        const raw = readFileSync(eventsPath, 'utf8');
        return raw
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
      } catch {
        return [];
      }
    };

    const summarizeRecentEvents = (events: unknown[]): string => {
      const summaries = events
        .slice(-4)
        .map((event) => {
          if (!event || typeof event !== 'object') {
            return null;
          }
          const type = typeof (event as { type?: unknown }).type === 'string' ? (event as { type: string }).type : 'unknown';
          const message =
            typeof (event as { message?: unknown }).message === 'string'
              ? (event as { message: string }).message
              : typeof (event as { thread_id?: unknown }).thread_id === 'string'
                ? `thread=${(event as { thread_id: string }).thread_id}`
                : undefined;
          return message ? `${type}:${message}` : type;
        })
        .filter(Boolean);
      return summaries.length > 0 ? summaries.join(' | ') : 'no recent events';
    };

    const readRecentStderr = (): string => {
      if (!existsSync(stderrPath)) {
        return '';
      }
      try {
        const raw = readFileSync(stderrPath, 'utf8').trim();
        if (!raw) {
          return '';
        }
        return raw.split(/\r?\n/u).slice(-4).join(' | ');
      } catch {
        return '';
      }
    };

    const waitForLaunchEvidence = () => {
      if (settled) {
        return;
      }
      const events = readJsonlEvents();
      const threadStarted = events.find((event) => {
        if (!event || typeof event !== 'object') {
          return false;
        }
        return (event as { type?: unknown }).type === 'thread.started' && typeof (event as { thread_id?: unknown }).thread_id === 'string';
      }) as { thread_id?: string } | undefined;
      const childSessionId = typeof threadStarted?.thread_id === 'string' ? threadStarted.thread_id : undefined;
      const sawTurnStarted = events.some((event) => event && typeof event === 'object' && (event as { type?: unknown }).type === 'turn.started');

      if (childSessionId && sawTurnStarted) {
        const { childRolloutPath, childSessionPersistence } = resolveChildSessionPersistence(options.codexHome, childSessionId);
        succeed({
          childSessionPersistence,
          childSessionId,
          childRolloutPath,
          eventsPath,
          launcherPid: child.pid ?? undefined,
          resumeOutputPath: options.resumeOutputPath,
          stderrPath,
        });
        return;
      }

      if (Date.now() - launchStartedAt >= DEFAULT_CHILD_LAUNCH_TIMEOUT_MS) {
        const eventSummary = summarizeRecentEvents(events);
        const stderrSummary = readRecentStderr();
        fail(
          new Error(
            `codex-exec ${command} did not produce launch events within ${DEFAULT_CHILD_LAUNCH_TIMEOUT_MS}ms (events: ${eventSummary}${stderrSummary ? `; stderr: ${stderrSummary}` : ''}; eventsPath: ${eventsPath}; stderrPath: ${stderrPath})`,
          ),
        );
        return;
      }

      sessionDiscoveryTimer = setTimeout(waitForLaunchEvidence, DEFAULT_CHILD_SESSION_POLL_MS);
      sessionDiscoveryTimer.unref?.();
    };

    child.on('error', onError);
    child.on('exit', onExit);
    waitForLaunchEvidence();
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

export function formatWakePollSummary(
  snapshot: ThreadSnapshot,
  downloadTargetCount: number,
  options: {
    busy?: boolean;
    busyReason?: string;
  } = {},
): string {
  const statusSummary =
    snapshot.statusTexts
      .map((value) => value.trim())
      .find((value) => value.length > 0 && value.toLowerCase() !== 'deep research') ?? 'none';
  const lastAssistantPreview = summarizeAssistantPreview(snapshot);
  const busyReason = options.busyReason ?? snapshotBusyReason(snapshot);
  const busy = options.busy ?? snapshotIndicatesBusy(snapshot);
  return [
    `busy=${busy ? 'yes' : 'no'}`,
    `attachments=${downloadTargetCount}`,
    `assistantTurns=${snapshot.assistantSnapshots.length}`,
    `status=${JSON.stringify(statusSummary)}`,
    `reason=${JSON.stringify(busyReason)}`,
    `lastAssistant=${JSON.stringify(lastAssistantPreview)}`,
  ].join(', ');
}

function latestAssistantSnapshotsForWake(snapshot: Pick<ThreadSnapshot, 'assistantSnapshots'>): ThreadSnapshot['assistantSnapshots'] {
  return snapshot.assistantSnapshots.some((assistantSnapshot) => typeof assistantSnapshot.afterLastUserMessage === 'boolean')
    ? snapshot.assistantSnapshots.filter((assistantSnapshot) => assistantSnapshot.afterLastUserMessage === true)
    : snapshot.assistantSnapshots;
}

function summarizeAssistantPreview(snapshot: Pick<ThreadSnapshot, 'assistantSnapshots'>): string {
  const latestRequestSnapshots = latestAssistantSnapshotsForWake(snapshot);
  const value = String(latestRequestSnapshots.at(-1)?.text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (value.length === 0) {
    return 'none';
  }
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

function latestAssistantHasCopyButton(snapshot: Pick<ThreadSnapshot, 'assistantSnapshots'>): boolean {
  const latestRequestSnapshots = latestAssistantSnapshotsForWake(snapshot);
  return latestRequestSnapshots.at(-1)?.hasCopyButton === true;
}

function buildWakeSnapshotFingerprint(
  snapshot: ThreadSnapshot,
  input: {
    artifactLabels: string[];
    downloadTargets: Array<{ href?: string | null; label: string }>;
  },
): string {
  const latestRequestSnapshots = latestAssistantSnapshotsForWake(snapshot);
  return JSON.stringify({
    artifactLabels: input.artifactLabels,
    downloadTargets: input.downloadTargets.map((target) => ({
      href: target.href ?? null,
      label: target.label,
    })),
    patchMarkers: snapshot.patchMarkers,
    statusTexts: snapshot.statusTexts,
    stopVisible: snapshot.stopVisible,
    summaries: latestRequestSnapshots.map((assistantSnapshot) => ({
      hasCopyButton: assistantSnapshot.hasCopyButton,
      signature: assistantSnapshot.signature,
    })),
  });
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
  artifactLabels?: string[];
  chatUrl: string;
  downloadErrors?: string[];
  downloadedArtifacts: string[];
  exportPath: string;
  replayCommandsPath?: string;
  recursive?: WakeRecursiveInfo;
  resumePrompt?: string;
  repoDir: string;
}): string {
  const relativeToRepo = (targetPath: string) => path.relative(input.repoDir, targetPath) || '.';
  const lines = [
    'Wake-up task:',
    `- The watched ChatGPT thread URL is ${input.chatUrl}.`,
    `- Read the exported ChatGPT thread JSON at ${relativeToRepo(input.exportPath)}.`,
    input.downloadedArtifacts.length > 0
      ? `- Inspect the downloaded assistant artifacts already on disk at: ${input.downloadedArtifacts.map((filePath) => relativeToRepo(filePath)).join(', ')}.`
      : '- No assistant artifacts were downloaded; inspect the thread export and attachment labels to determine why.',
    input.artifactLabels && input.artifactLabels.length > 0
      ? `- The latest assistant artifact labels were: ${input.artifactLabels.join(', ')}.`
      : '- No assistant artifact labels were detected in the latest request.',
    input.downloadErrors && input.downloadErrors.length > 0
      ? `- Some artifact downloads failed: ${input.downloadErrors.join(' | ')}.`
      : '- No artifact download errors were recorded.',
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
  lines.push(
    ...buildRecursiveWakeInstructions({
      recursive: input.recursive,
      repoDir: input.repoDir,
    }),
  );
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

function formatCliDurationArg(valueMs: number | undefined): string | undefined {
  if (valueMs === undefined) {
    return undefined;
  }
  return `${valueMs}ms`;
}

function buildReviewGptShellCommand(args: readonly ShellCommandPart[]): string {
  const cliEntryPath = fileURLToPath(new URL('./bin.mjs', import.meta.url));
  return [
    process.execPath,
    cliEntryPath,
    ...args,
  ]
    .map((part) => (typeof part === 'string' ? quoteShellArg(part) : part.raw))
    .join(' ');
}

function buildRecursiveReviewSendCommand(input: {
  chatUrl: string;
  prompt?: string;
  timeoutMs: number;
}): string {
  return buildReviewGptShellCommand([
    '--send',
    '--timeout',
    formatCliDurationArg(input.timeoutMs) ?? `${input.timeoutMs}ms`,
    '--chat-url',
    input.chatUrl,
    '--prompt',
    input.prompt?.trim() || DEFAULT_RECURSIVE_REVIEW_PROMPT,
  ]);
}

function buildRecursiveWakeCommand(input: {
  chatUrl: string;
  fullAuto?: boolean;
  nextDepth: number;
  outputDir: string;
  pollIntervalMs?: number;
  pollJitterMs?: number;
  recursivePrompt?: string;
  pollTimeoutMs?: number;
  pollUntilComplete?: boolean;
  repoDir: string;
}): string {
  const args: ShellCommandPart[] = [
    'thread',
    'wake',
    '--detach',
    '--delay',
    '0s',
    '--chat-url',
    input.chatUrl,
    '--output-dir',
    input.outputDir,
    '--repo-dir',
    input.repoDir,
    '--session-id',
    { raw: '"$CODEX_THREAD_ID"' },
    '--recursive-depth',
    String(input.nextDepth),
  ];
  const pollInterval = formatCliDurationArg(input.pollIntervalMs);
  const pollJitter = formatCliDurationArg(input.pollJitterMs);
  const pollTimeout = formatCliDurationArg(input.pollTimeoutMs);
  if (pollInterval) {
    args.push('--poll-interval', pollInterval);
  }
  if (pollJitter) {
    args.push('--poll-jitter', pollJitter);
  }
  if (pollTimeout) {
    args.push('--poll-timeout', pollTimeout);
  }
  if (input.pollUntilComplete === false) {
    args.push('--no-poll-until-complete');
  }
  if (input.recursivePrompt?.trim()) {
    args.push('--recursive-prompt', input.recursivePrompt.trim());
  }
  if (input.fullAuto === true) {
    args.push('--full-auto');
  }
  return buildReviewGptShellCommand(args);
}

function buildRecursiveWakeInstructions(input: {
  recursive?: WakeRecursiveInfo;
  repoDir: string;
}): string[] {
  if (!input.recursive) {
    return [];
  }
  const relativeToRepo = (targetPath: string) => path.relative(input.repoDir, targetPath) || '.';
  return [
    '',
    'Recursive same-thread review flow:',
    `- Recursive depth remaining after this wake handoff: ${input.recursive.requestedDepth}.`,
    '- After you apply the downloaded patch and finish the repo-required verification/audit flow for it, run the generated same-thread follow-up helper. Do not use --prompt-only.',
    `- Run: bash ${relativeToRepo(input.recursive.followupScriptPath)}`,
    `- That helper uses an explicit ${input.recursive.reviewTimeoutMs}ms send timeout, writes the send log to ${relativeToRepo(input.recursive.reviewSendLogPath)}, and records the overall follow-up result in ${relativeToRepo(input.recursive.followupReceiptPath)}.`,
    `- When the follow-up send succeeds, the helper arms the next detached wake in ${relativeToRepo(input.recursive.descendantOutputDir)} and captures the launch JSON at ${relativeToRepo(input.recursive.descendantWakeLaunchPath)}.`,
    input.recursive.nextDepth > 0
      ? `- The next wake child will repeat this same-thread review loop ${input.recursive.nextDepth} more time${input.recursive.nextDepth === 1 ? '' : 's'} before stopping.`
      : '- The next wake child should apply the returned review patch, run the repo-required verification/audit flow, and stop without sending another review request.',
    '- If the helper exits non-zero, inspect the receipt and logs before retrying so the recursive chain stays debuggable.',
  ];
}

function buildRecursiveWakeInfo(input: {
  outputDir: string;
  recursiveDepth: number;
}): WakeRecursiveInfo | undefined {
  if (input.recursiveDepth <= 0) {
    return undefined;
  }
  const nextDepth = Math.max(0, input.recursiveDepth - 1);
  const descendantOutputDir = path.join(input.outputDir, `recursive-depth-${nextDepth}`);
  return {
    descendantOutputDir,
    descendantStatusPath: path.join(descendantOutputDir, 'status.json'),
    descendantWakeLaunchPath: path.join(input.outputDir, 'recursive-next-wake-launch.json'),
    descendantWakeLogPath: path.join(input.outputDir, 'recursive-next-wake.log'),
    followupReceiptPath: path.join(input.outputDir, 'recursive-followup.json'),
    followupScriptPath: path.join(input.outputDir, 'recursive-followup.sh'),
    nextDepth,
    requestedDepth: input.recursiveDepth,
    reviewSendLogPath: path.join(input.outputDir, 'recursive-review-send.log'),
    reviewTimeoutMs: DEFAULT_RECURSIVE_REVIEW_SEND_TIMEOUT_MS,
  };
}

function buildRecursiveFollowupScript(input: {
  chatUrl: string;
  fullAuto?: boolean;
  pollIntervalMs?: number;
  pollJitterMs?: number;
  recursivePrompt?: string;
  pollTimeoutMs?: number;
  pollUntilComplete?: boolean;
  recursive: WakeRecursiveInfo;
  repoDir: string;
}): string {
  const reviewCommand = buildRecursiveReviewSendCommand({
    chatUrl: input.chatUrl,
    prompt: input.recursivePrompt,
    timeoutMs: input.recursive.reviewTimeoutMs,
  });
  const wakeCommand = buildRecursiveWakeCommand({
    chatUrl: input.chatUrl,
    fullAuto: input.fullAuto,
    nextDepth: input.recursive.nextDepth,
    outputDir: input.recursive.descendantOutputDir,
    pollIntervalMs: input.pollIntervalMs,
    pollJitterMs: input.pollJitterMs,
    recursivePrompt: input.recursivePrompt,
    pollTimeoutMs: input.pollTimeoutMs,
    pollUntilComplete: input.pollUntilComplete,
    repoDir: input.repoDir,
  });
  const writeReceiptProgram = [
    "const fs = require('node:fs');",
    'const receipt = {',
    '  generatedAt: new Date().toISOString(),',
    '  requestedDepth: Number(process.env.REQUESTED_DEPTH || 0),',
    '  nextDepth: Number(process.env.NEXT_DEPTH || 0),',
    '  reviewTimeoutMs: Number(process.env.REVIEW_TIMEOUT_MS || 0),',
    '  reviewSendStatus: process.env.REVIEW_SEND_STATUS || "unknown",',
    '  reviewSendLogPath: process.env.REVIEW_SEND_LOG_PATH || "",',
    '  nextWakeStatus: process.env.NEXT_WAKE_STATUS || "unknown",',
    '  nextWakeLaunchPath: process.env.NEXT_WAKE_LAUNCH_PATH || "",',
    '  nextWakeLogPath: process.env.NEXT_WAKE_LOG_PATH || "",',
    '  nextWakeOutputDir: process.env.NEXT_WAKE_OUTPUT_DIR || "",',
    '  nextWakeStatusPath: process.env.NEXT_WAKE_STATUS_PATH || "",',
    '};',
    'fs.writeFileSync(process.env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\\n`, "utf8");',
  ].join(' ');

  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    '',
    `receipt_path=${quoteShellArg(input.recursive.followupReceiptPath)}`,
    `review_send_log_path=${quoteShellArg(input.recursive.reviewSendLogPath)}`,
    `next_wake_launch_path=${quoteShellArg(input.recursive.descendantWakeLaunchPath)}`,
    `next_wake_log_path=${quoteShellArg(input.recursive.descendantWakeLogPath)}`,
    `next_wake_output_dir=${quoteShellArg(input.recursive.descendantOutputDir)}`,
    `next_wake_status_path=${quoteShellArg(input.recursive.descendantStatusPath)}`,
    '',
    "review_send_status='failed'",
    "next_wake_status='skipped'",
    '',
    `if ${reviewCommand} >"$review_send_log_path" 2>&1; then`,
    "  review_send_status='succeeded'",
    `  if ${wakeCommand} >"$next_wake_launch_path" 2>"$next_wake_log_path"; then`,
    "    next_wake_status='armed'",
    '  else',
    "    next_wake_status='failed'",
    '  fi',
    'fi',
    '',
    [
      'RECEIPT_PATH="$receipt_path"',
      `REQUESTED_DEPTH=${quoteShellArg(String(input.recursive.requestedDepth))}`,
      `NEXT_DEPTH=${quoteShellArg(String(input.recursive.nextDepth))}`,
      `REVIEW_TIMEOUT_MS=${quoteShellArg(String(input.recursive.reviewTimeoutMs))}`,
      'REVIEW_SEND_STATUS="$review_send_status"',
      'REVIEW_SEND_LOG_PATH="$review_send_log_path"',
      'NEXT_WAKE_STATUS="$next_wake_status"',
      'NEXT_WAKE_LAUNCH_PATH="$next_wake_launch_path"',
      'NEXT_WAKE_LOG_PATH="$next_wake_log_path"',
      'NEXT_WAKE_OUTPUT_DIR="$next_wake_output_dir"',
      'NEXT_WAKE_STATUS_PATH="$next_wake_status_path"',
      `${quoteShellArg(process.execPath)} -e ${quoteShellArg(writeReceiptProgram)}`,
    ].join(' '),
    '',
    'if [[ "$review_send_status" != "succeeded" || "$next_wake_status" == "failed" ]]; then',
    '  exit 1',
    'fi',
    '',
  ].join('\n');
}

function buildWakeReplayCommands(input: {
  downloadTargets: Array<{
    artifactIndex: number;
    href?: string | null;
    label: string;
  }>;
  browserEndpoint: string;
  chatUrl: string;
  downloadDir: string;
  exportPath: string;
}): string {
  const baseArgs = ['--browser-endpoint', input.browserEndpoint, '--chat-url', input.chatUrl];
  const exportCommand = buildReviewGptShellCommand([
    'thread',
    'export',
    ...baseArgs,
    '--output',
    input.exportPath,
  ]);
  const explicitDownloadCommands = input.downloadTargets.map((target) => ({
    command: buildReviewGptShellCommand([
      'thread',
      'download',
      ...baseArgs,
      '--artifact-index',
      String(target.artifactIndex),
      '--output-dir',
      input.downloadDir,
    ]),
    label: target.label,
    artifactIndex: target.artifactIndex,
  }));
  const placeholderDownloadCommand = buildReviewGptShellCommand([
    'thread',
    'download',
    ...baseArgs,
    '--artifact-index',
    '<artifact-index>',
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
    '# Re-download the current assistant artifacts into the wake downloads directory.',
  ];

  if (explicitDownloadCommands.length > 0) {
    lines.push(
      ...explicitDownloadCommands.flatMap(({ artifactIndex, command, label }) => [
        `# artifact ${artifactIndex}: ${label || '(unlabeled)'}`,
        command,
      ]),
    );
  } else {
    lines.push('# No assistant download targets were present in the latest export.');
  }

  lines.push(
    '',
    '# Replace <artifact-index> with an assistant artifact index from thread.json when needed.',
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
  const recursive = options.skipResume
    ? undefined
    : buildRecursiveWakeInfo({
        outputDir: resolvedOutputDir,
        recursiveDepth: options.recursiveDepth ?? 0,
      });
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
  let childSessionPersistence: 'pending' | 'verified' | undefined;
  let childSessionId: string | undefined;
  let childRolloutPath: string | undefined;
  let eventsPath: string | undefined;
  let launcherPid: number | undefined;
  let resumeOutputPath: string | undefined;
  let stderrPath: string | undefined;
  let consecutiveExportFailures = 0;
  let attemptCount = 0;
  let completionStatus: WakeCompletionStatus = 'checked-once';
  const downloadErrors: string[] = [];
  const downloadedArtifacts: string[] = [];
  const downloadedPatches: string[] = [];
  let lastSuccessfulSnapshot: ThreadSnapshot | undefined;
  let lastSuccessfulArtifactLabels: string[] = [];
  let lastSuccessfulDownloadTargetCount = 0;
  let stableIdleFingerprint: string | undefined;
  let stableIdlePolls = 0;
  let stableCopyableFingerprint: string | undefined;
  let stableCopyablePolls = 0;
  let staleSnapshotFingerprint: string | undefined;
  let staleSnapshotPolls = 0;
  let forceReloadNextExport = false;
  let forcedReloadCount = 0;
  let lastAssistantPreview: string | undefined;
  let lastBusyReason: string | undefined;
  let lastSnapshotSummary: string | undefined;

  const writeWakeStatus = async (state: WakeState, extra: Partial<WakeStatus> = {}) => {
    const status: WakeStatus = {
      attemptCount,
      chatUrl: options.chatUrl,
      childSessionPersistence,
      childSessionId,
      childRolloutPath,
      codexBin: resolvedCodexBin,
      codexHome: resolvedCodexHome?.homePath,
      completionStatus,
      downloadErrors,
      downloadedArtifacts,
      downloadedPatches,
      eventsPath,
      exportPath,
      launcherPid,
      lastAssistantPreview,
      lastArtifactLabels: lastSuccessfulArtifactLabels,
      lastBusyReason,
      outputDir: resolvedOutputDir,
      lastPatchLabels: lastSuccessfulArtifactLabels,
      replayCommandsPath,
      recursive,
      repoDir: resolvedRepoDir,
      resumeOutputPath,
      sessionId: options.sessionId,
      stderrPath,
      staleSnapshotPolls,
      staleSnapshotThreshold: DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD,
      forceReloadNextExport,
      forcedReloadCount,
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
  let artifactLabels: string[] = [];
  let downloadTargets: Array<{
    artifactIndex: number;
    href?: string | null;
    label: string;
  }> = [];
  const pollStartedAt = Date.now();
  try {
    if (!options.skipResume) {
      resolvedCodexBin = wakeDependencies.resolveCodexBin();
      resolvedCodexHome = resolveWakeCodexHome(options, wakeDependencies);
      await writeWakeStatus('waiting');
    }

    wakeDependencies.log(
      [
        `Sleeping for ${options.delayMs}ms before checking ${options.chatUrl}.`,
        `Repo dir: ${formatPathForDisplay(resolvedRepoDir, resolvedRepoDir)}`,
        `Output dir: ${formatPathForDisplay(resolvedOutputDir, resolvedRepoDir)}`,
        resolvedCodexBin ? `Codex bin: ${formatPathForDisplay(resolvedCodexBin, resolvedRepoDir)}` : 'Codex bin: skipped',
        resolvedCodexHome ? `Codex home: ${formatCodexHomeForDisplay(resolvedCodexHome.homePath)} (${resolvedCodexHome.resolution})` : 'Codex resume: skipped',
        options.skipResume ? 'Child launch mode: skipped' : 'Child launch mode: codex exec --json',
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
      const forceReloadCurrentExport = attemptCount === 1 || forceReloadNextExport;
      forceReloadNextExport = false;
      try {
        if (forceReloadCurrentExport) {
          forcedReloadCount += 1;
          wakeDependencies.log(
            attemptCount === 1
              ? `Wake check ${attemptCount}: forcing a same-tab reload before the first export to avoid stale hydrated thread state.\n`
              : `Wake check ${attemptCount}: forcing a same-tab reload before export after repeated identical no-artifact snapshots.\n`,
          );
        }
        snapshot = await wakeDependencies.exportThreadSnapshot(browserEndpoint, options.chatUrl, exportPath, {
          forceReload: forceReloadCurrentExport,
        });
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
            `Preserving the last successful snapshot while export is flaky. Last good export: ${formatWakePollSummary(lastSuccessfulSnapshot, lastSuccessfulDownloadTargetCount)}.\n`,
          );
        }
        wakeDependencies.log(
          `Thread export failed; polling again in ${formatWakePollDelay(nextDelayMs, pollIntervalMs, pollJitterMs)}.\n`,
        );
        await wakeDependencies.sleep(nextDelayMs);
        continue;
      }
      consecutiveExportFailures = 0;
      downloadTargets = extractAssistantDownloadTargets(snapshot);
      artifactLabels = extractAssistantArtifactLabels(snapshot);
      lastSuccessfulSnapshot = snapshot;
      lastSuccessfulArtifactLabels = artifactLabels;
      lastSuccessfulDownloadTargetCount = downloadTargets.length;
      const hasDownloadTargets = downloadTargets.length > 0;
      let busy = snapshotIndicatesBusy(snapshot);
      let busyReason = snapshotBusyReason(snapshot);
      const snapshotFingerprint = buildWakeSnapshotFingerprint(snapshot, {
        artifactLabels,
        downloadTargets,
      });

      if (busy) {
        stableIdleFingerprint = undefined;
        stableIdlePolls = 0;
      } else if (!hasDownloadTargets) {
        stableIdlePolls =
          snapshotFingerprint === stableIdleFingerprint
            ? stableIdlePolls + 1
            : 1;
        stableIdleFingerprint = snapshotFingerprint;
        if (stableIdlePolls < DEFAULT_STABLE_IDLE_POLLS_REQUIRED) {
          busy = true;
          busyReason = 'assistant-settling';
        }
      } else {
        stableIdleFingerprint = undefined;
        stableIdlePolls = 0;
      }

      if (!hasDownloadTargets && !snapshot.statusBusy && !snapshot.stopVisible && latestAssistantHasCopyButton(snapshot)) {
        stableCopyablePolls =
          snapshotFingerprint === stableCopyableFingerprint
            ? stableCopyablePolls + 1
            : 1;
        stableCopyableFingerprint = snapshotFingerprint;
        if (busy && busyReason === 'assistant-settling' && stableCopyablePolls >= DEFAULT_STABLE_IDLE_POLLS_REQUIRED) {
          busy = false;
          busyReason = 'idle';
        }
      } else {
        stableCopyableFingerprint = undefined;
        stableCopyablePolls = 0;
      }

      if (busy && !hasDownloadTargets && busyReason === 'assistant-settling') {
        staleSnapshotPolls =
          snapshotFingerprint === staleSnapshotFingerprint
            ? staleSnapshotPolls + 1
            : 1;
        staleSnapshotFingerprint = snapshotFingerprint;
      } else {
        staleSnapshotFingerprint = undefined;
        staleSnapshotPolls = 0;
      }

      lastAssistantPreview = summarizeAssistantPreview(snapshot);
      lastBusyReason = busyReason;
      lastSnapshotSummary = formatWakePollSummary(snapshot, downloadTargets.length, {
        busy,
        busyReason,
      });
      await writeWakeStatus('waiting');

      wakeDependencies.log(
        `Wake check ${attemptCount}: ${lastSnapshotSummary}${
          !busy && !hasDownloadTargets
            ? `, stableIdle=${stableIdlePolls}/${DEFAULT_STABLE_IDLE_POLLS_REQUIRED}`
            : busyReason === 'assistant-settling' && !hasDownloadTargets
              ? `, staleSnapshot=${staleSnapshotPolls}/${DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD}`
              : ''
        }.\n`,
      );
      if (downloadTargets.length > 0) {
        const displayLabels = downloadTargets.map((target) => target.label).filter((label) => label.length > 0);
        wakeDependencies.log(`Wake check ${attemptCount}: assistant download targets: ${displayLabels.join(' | ')}.\n`);
      }

      if (!pollUntilComplete) {
        break;
      }
      if (!busy) {
        completionStatus = 'completed';
        break;
      }
      if (
        busyReason === 'assistant-settling' &&
        !hasDownloadTargets &&
        staleSnapshotPolls >= DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD
      ) {
        forceReloadNextExport = true;
        staleSnapshotFingerprint = undefined;
        staleSnapshotPolls = 0;
        wakeDependencies.log(
          `Wake check ${attemptCount}: identical assistant-settling snapshot repeated ${DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD} times without artifacts; forcing a same-tab reload on the next export.\n`,
        );
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
    for (const target of downloadTargets) {
      try {
        const downloadedFile = await wakeDependencies.downloadThreadAttachment(
          browserEndpoint,
          options.chatUrl,
          target.label,
          downloadDir,
          downloadTimeoutMs,
          {
            artifactIndex: target.artifactIndex,
            href: target.href,
          },
        );
        downloadedArtifacts.push(downloadedFile);
        downloadedPatches.push(downloadedFile);
        wakeDependencies.log(
          `Downloaded assistant artifact ${JSON.stringify(target.label || `artifact #${target.artifactIndex}`)} to ${formatPathForDisplay(downloadedFile, resolvedRepoDir)}.\n`,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const targetLabel = target.label || `artifact #${target.artifactIndex}`;
        downloadErrors.push(`${targetLabel}: ${errorMessage}`);
        wakeDependencies.log(`Assistant artifact download failed for ${JSON.stringify(targetLabel)}: ${errorMessage}.\n`);
      }
      await writeWakeStatus('downloading');
    }

    await wakeDependencies.writeFile(
      replayCommandsPath,
      buildWakeReplayCommands({
        downloadTargets,
        browserEndpoint,
        chatUrl: options.chatUrl,
        downloadDir,
        exportPath,
      }),
      'utf8',
    );
    if (recursive) {
      await wakeDependencies.writeFile(
        recursive.followupScriptPath,
        buildRecursiveFollowupScript({
          chatUrl: options.chatUrl,
          fullAuto: options.fullAuto,
          pollIntervalMs,
          pollJitterMs,
          recursivePrompt: options.recursivePrompt,
          pollTimeoutMs,
          pollUntilComplete,
          recursive,
          repoDir: resolvedRepoDir,
        }),
        'utf8',
      );
    }

    if (options.skipResume) {
      await writeWakeStatus('succeeded');
      return {
        attemptCount,
        childRolloutPath,
        completionStatus,
        codexBin: resolvedCodexBin,
        downloadErrors,
        downloadedArtifacts,
        downloadedPatches,
        exportPath,
        launcherPid,
        outputDir: resolvedOutputDir,
        recursive,
        replayCommandsPath,
        repoDir: resolvedRepoDir,
        statusPath,
      };
    }

    if (!resolvedCodexHome || !options.sessionId) {
      throw new Error('Resolved Codex home and session ID are required before starting the child Codex run.');
    }

    eventsPath = path.join(resolvedOutputDir, 'child-events.jsonl');
    resumeOutputPath = path.join(resolvedOutputDir, 'child-last-message.txt');
    stderrPath = path.join(resolvedOutputDir, 'child-stderr.log');
    const childArgs = ['exec', '--json', '--output-last-message', resumeOutputPath, '-C', resolvedRepoDir];
    if (options.fullAuto === true) {
      childArgs.push('--full-auto');
    }
    const followupPrompt = buildWakeFollowupPrompt({
      artifactLabels,
      chatUrl: options.chatUrl,
      downloadErrors,
      downloadedArtifacts,
      exportPath,
      replayCommandsPath,
      recursive,
      resumePrompt: options.resumePrompt,
      repoDir: resolvedRepoDir,
    });
    childArgs.push(followupPrompt);

    await writeWakeStatus('spawning');
    await writeWakeStatus('running');
    const childLaunch =
      (await wakeDependencies.runCodexChildSession(
        resolvedCodexBin ?? 'codex',
        childArgs,
        {
          codexHome: resolvedCodexHome.homePath,
          cwd: resolvedRepoDir,
          env: {
            ...process.env,
            CODEX_HOME: resolvedCodexHome.homePath,
          },
          eventsPath,
          resumeOutputPath,
          stderrPath,
        },
      )) ?? {};
    childSessionPersistence = childLaunch.childSessionPersistence;
    childSessionId = childLaunch.childSessionId;
    childRolloutPath = childLaunch.childRolloutPath;
    eventsPath = childLaunch.eventsPath ?? eventsPath;
    launcherPid = childLaunch.launcherPid;
    resumeOutputPath = childLaunch.resumeOutputPath ?? resumeOutputPath;
    stderrPath = childLaunch.stderrPath ?? stderrPath;
    wakeDependencies.log(
      `Wake child launch verified${childSessionId ? ` with child session ${childSessionId}` : ''}${launcherPid ? ` (launcher pid ${launcherPid})` : ''}${eventsPath ? `, events at ${formatPathForDisplay(eventsPath, resolvedRepoDir)}` : ''}${stderrPath ? `, stderr at ${formatPathForDisplay(stderrPath, resolvedRepoDir)}` : ''}.\n`,
    );
    if (childSessionId && childSessionPersistence === 'pending') {
      wakeDependencies.log(
        `Wake child session ${childSessionId} started before session-home evidence was discoverable; persistence is still pending.\n`,
      );
    }
    await writeWakeStatus('succeeded');

    return {
      attemptCount,
      childSessionPersistence,
      childSessionId,
      childRolloutPath,
      completionStatus,
      codexBin: resolvedCodexBin,
      codexHome: resolvedCodexHome.homePath,
      downloadErrors,
      downloadedArtifacts,
      downloadedPatches,
      eventsPath,
      exportPath,
      launcherPid,
      outputDir: resolvedOutputDir,
      recursive,
      replayCommandsPath,
      repoDir: resolvedRepoDir,
      resumeOutputPath,
      sessionId: options.sessionId,
      stderrPath,
      statusPath,
    };
  } catch (error) {
    await writeWakeStatus('failed', {
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
