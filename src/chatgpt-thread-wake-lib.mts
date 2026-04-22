import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import {
  DEFAULT_BROWSER_ENDPOINT,
  assistantSnapshotLooksTerminal,
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
import {
  buildRecursiveFollowupScript,
  buildRecursiveWakeInfo,
  buildRecursiveWakeInstructions,
  buildWakeReplayCommands,
  type WakeRecursiveInfo,
} from './chatgpt-thread-wake-recursive-lib.mjs';
export type { WakeRecursiveInfo } from './chatgpt-thread-wake-recursive-lib.mjs';

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

type WakeCandidateKind = 'artifact' | 'terminal-no-artifact' | 'partial' | 'empty';

type WakeState = 'waiting' | 'downloading' | 'spawning' | 'running' | 'succeeded' | 'failed';

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
  bestCandidateKind?: WakeCandidateKind;
  currentCandidateKind?: WakeCandidateKind;
  stallPolls?: number;
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

type WakeCandidate = {
  assistantTurnCount: number;
  finalSignature: string;
  finalText: string;
  kind: WakeCandidateKind;
  textLength: number;
};

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

function classifyWakeCandidate(
  snapshot: ThreadSnapshot,
  downloadTargets: Array<{ href?: string | null; label: string }>,
): WakeCandidate {
  const latestRequestSnapshots = latestAssistantSnapshotsForWake(snapshot);
  const finalAssistantSnapshot = latestRequestSnapshots.at(-1);
  const finalText = String(finalAssistantSnapshot?.text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  const candidateBase = {
    assistantTurnCount: latestRequestSnapshots.length,
    finalSignature: String(finalAssistantSnapshot?.signature ?? ''),
    finalText,
    textLength: finalText.length,
  };

  if (downloadTargets.length > 0) {
    return {
      ...candidateBase,
      kind: 'artifact',
    };
  }

  if (!snapshot.statusBusy && !snapshot.stopVisible && assistantSnapshotLooksTerminal(snapshot)) {
    return {
      ...candidateBase,
      kind: 'terminal-no-artifact',
    };
  }

  if (snapshotIndicatesBusy(snapshot) || finalText.length > 0) {
    return {
      ...candidateBase,
      kind: 'partial',
    };
  }

  return {
    ...candidateBase,
    kind: 'empty',
  };
}

function wakeCandidateRank(kind: WakeCandidateKind): number {
  switch (kind) {
    case 'artifact':
      return 4;
    case 'terminal-no-artifact':
      return 3;
    case 'partial':
      return 2;
    case 'empty':
    default:
      return 1;
  }
}

function compareWakeCandidates(left: WakeCandidate, right: WakeCandidate): number {
  const rankDelta = wakeCandidateRank(left.kind) - wakeCandidateRank(right.kind);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  if (left.assistantTurnCount !== right.assistantTurnCount) {
    return left.assistantTurnCount - right.assistantTurnCount;
  }
  if (left.textLength !== right.textLength) {
    return left.textLength - right.textLength;
  }
  return 0;
}

function wakeCandidatesMatch(left: WakeCandidate, right: WakeCandidate): boolean {
  return (
    left.kind === right.kind &&
    left.assistantTurnCount === right.assistantTurnCount &&
    left.textLength === right.textLength &&
    left.finalSignature === right.finalSignature &&
    left.finalText === right.finalText
  );
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
  let bestCandidate: WakeCandidate | undefined;
  let currentCandidate: WakeCandidate | undefined;
  let stallPolls = 0;
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
      bestCandidateKind: bestCandidate?.kind,
      currentCandidateKind: currentCandidate?.kind,
      stallPolls,
      staleSnapshotPolls: stallPolls,
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
    const pollStartedAt = Date.now();

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
              : `Wake check ${attemptCount}: forcing a same-tab reload before export after stalled or regressed no-artifact snapshots.\n`,
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
      currentCandidate = classifyWakeCandidate(snapshot, downloadTargets);
      const priorBestCandidate = bestCandidate;
      const bestComparison = priorBestCandidate ? compareWakeCandidates(currentCandidate, priorBestCandidate) : 1;
      const bestAdvanced = !priorBestCandidate || bestComparison > 0;
      const regressedSnapshot = Boolean(priorBestCandidate) && bestComparison < 0;

      if (bestAdvanced) {
        bestCandidate = currentCandidate;
        stallPolls = currentCandidate.kind === 'artifact' ? 0 : 1;
      } else {
        stallPolls += 1;
      }

      const stableTerminalPolls =
        currentCandidate.kind === 'terminal-no-artifact' && bestCandidate && wakeCandidatesMatch(currentCandidate, bestCandidate)
          ? stallPolls
          : 0;
      const stableTerminalReady =
        currentCandidate.kind === 'terminal-no-artifact' &&
        stableTerminalPolls >= DEFAULT_STABLE_IDLE_POLLS_REQUIRED;
      const busy = currentCandidate.kind !== 'artifact' && !stableTerminalReady;
      let busyReason: 'assistant-settling' | 'idle' | 'status-busy' | 'stop-visible' =
        busy
          ? snapshotBusyReason(snapshot)
          : 'idle';
      if (busy && (currentCandidate.kind === 'terminal-no-artifact' || currentCandidate.kind === 'empty') && busyReason === 'idle') {
        busyReason = 'assistant-settling';
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
          currentCandidate.kind === 'terminal-no-artifact'
            ? `, stableIdle=${stableTerminalPolls}/${DEFAULT_STABLE_IDLE_POLLS_REQUIRED}`
            : busy && !hasDownloadTargets
              ? `, stall=${stallPolls}/${DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD}`
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
      if (regressedSnapshot && !hasDownloadTargets) {
        forceReloadNextExport = true;
        stallPolls = 0;
        wakeDependencies.log(
          `Wake check ${attemptCount}: current snapshot regressed below prior best evidence without artifacts; forcing a same-tab reload on the next export.\n`,
        );
      } else if (
        !hasDownloadTargets &&
        stallPolls >= DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD
      ) {
        forceReloadNextExport = true;
        stallPolls = 0;
        wakeDependencies.log(
          `Wake check ${attemptCount}: no stronger assistant state appeared for ${DEFAULT_STALE_SNAPSHOT_POLLS_BEFORE_RELOAD} polls without artifacts; forcing a same-tab reload on the next export.\n`,
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
