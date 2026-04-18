import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type ShellCommandPart = string | { raw: string };

export type WakeRecursiveInfo = {
  descendantOutputDir: string;
  descendantStatusPath: string;
  descendantWakeLaunchPath: string;
  descendantWakeLogPath: string;
  followupReceiptPath: string;
  followupScriptPath: string;
  nextDepth: number;
  reviewDiagnosticsLaunchPath: string;
  reviewDiagnosticsLogPath: string;
  reviewDiagnosticsOutputDir: string;
  reviewDiagnosticsStatusPath: string;
  requestedDepth: number;
  reviewSendLogPath: string;
  reviewTimeoutMs: number;
};

const DEFAULT_RECURSIVE_REVIEW_SEND_TIMEOUT_MS = 300_000;
const DEFAULT_RECURSIVE_REVIEW_PROMPT =
  'Check my changes around the target area addressed in this thread for bugs/issues before production. Then review the same area thoroughly for architecture simplification. We are greenfield and want the simplest best long-term architecture. Return a .patch or .diff attachment with your changes. Keep the patch scoped to this target area, include any needed tests, and note assumptions briefly.';

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
  return [process.execPath, cliEntryPath, ...args]
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

export function buildRecursiveWakeInstructions(input: {
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
    '- After you apply the downloaded patch and finish the repo-required verification/audit flow for it, run the generated same-thread follow-up helper. It reattaches the normal repo review artifacts automatically.',
    `- Run: bash ${relativeToRepo(input.recursive.followupScriptPath)}`,
    `- That helper uses an explicit ${input.recursive.reviewTimeoutMs}ms send timeout, writes the send log to ${relativeToRepo(input.recursive.reviewSendLogPath)}, and records the overall follow-up result in ${relativeToRepo(input.recursive.followupReceiptPath)}.`,
    `- If that follow-up send fails, the helper also captures managed-browser diagnostics in ${relativeToRepo(input.recursive.reviewDiagnosticsOutputDir)} and writes the bundle status to ${relativeToRepo(input.recursive.reviewDiagnosticsStatusPath)}.`,
    `- When the follow-up send succeeds, the helper arms the next detached wake in ${relativeToRepo(input.recursive.descendantOutputDir)} and captures the launch JSON at ${relativeToRepo(input.recursive.descendantWakeLaunchPath)}.`,
    input.recursive.nextDepth > 0
      ? `- The next wake child will repeat this same-thread review loop ${input.recursive.nextDepth} more time${input.recursive.nextDepth === 1 ? '' : 's'} before stopping.`
      : '- The next wake child should apply the returned review patch, run the repo-required verification/audit flow, and stop without sending another review request.',
    '- If the helper exits non-zero, inspect the receipt and logs before retrying so the recursive chain stays debuggable.',
  ];
}

export function buildRecursiveWakeInfo(input: {
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
    reviewDiagnosticsLaunchPath: path.join(input.outputDir, 'recursive-review-diagnostics-launch.json'),
    reviewDiagnosticsLogPath: path.join(input.outputDir, 'recursive-review-diagnostics.log'),
    reviewDiagnosticsOutputDir: path.join(input.outputDir, 'recursive-review-diagnostics'),
    reviewDiagnosticsStatusPath: path.join(input.outputDir, 'recursive-review-diagnostics', 'status.json'),
    requestedDepth: input.recursiveDepth,
    reviewSendLogPath: path.join(input.outputDir, 'recursive-review-send.log'),
    reviewTimeoutMs: DEFAULT_RECURSIVE_REVIEW_SEND_TIMEOUT_MS,
  };
}

export function buildRecursiveFollowupScript(input: {
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
  const diagnosticsCommand = buildReviewGptShellCommand([
    'thread',
    'diagnose',
    '--chat-url',
    input.chatUrl,
    '--command-label',
    'thread-wake-recursive-followup',
    '--log-file',
    { raw: '"$review_send_log_path"' },
    '--output-dir',
    input.recursive.reviewDiagnosticsOutputDir,
    '--format',
    'json',
    '--filter-output',
    'outputDir',
  ]);
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
    '  reviewDiagnosticsLaunchPath: process.env.REVIEW_DIAGNOSTICS_LAUNCH_PATH || "",',
    '  reviewDiagnosticsLogPath: process.env.REVIEW_DIAGNOSTICS_LOG_PATH || "",',
    '  reviewDiagnosticsOutputDir: process.env.REVIEW_DIAGNOSTICS_OUTPUT_DIR || "",',
    '  reviewDiagnosticsStatus: process.env.REVIEW_DIAGNOSTICS_STATUS || "unknown",',
    '  reviewDiagnosticsStatusPath: process.env.REVIEW_DIAGNOSTICS_STATUS_PATH || "",',
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
    `review_diagnostics_launch_path=${quoteShellArg(input.recursive.reviewDiagnosticsLaunchPath)}`,
    `review_diagnostics_log_path=${quoteShellArg(input.recursive.reviewDiagnosticsLogPath)}`,
    `review_diagnostics_output_dir=${quoteShellArg(input.recursive.reviewDiagnosticsOutputDir)}`,
    `review_diagnostics_status_path=${quoteShellArg(input.recursive.reviewDiagnosticsStatusPath)}`,
    '',
    "review_send_status='failed'",
    "review_diagnostics_status='skipped'",
    "next_wake_status='skipped'",
    '',
    `if ${reviewCommand} >"$review_send_log_path" 2>&1; then`,
    "  review_send_status='succeeded'",
    `  if ${wakeCommand} >"$next_wake_launch_path" 2>"$next_wake_log_path"; then`,
    "    next_wake_status='armed'",
    '  else',
    "    next_wake_status='failed'",
    '  fi',
    'else',
    `  if ${diagnosticsCommand} >"$review_diagnostics_launch_path" 2>"$review_diagnostics_log_path"; then`,
    "    review_diagnostics_status='captured'",
    '  else',
    "    review_diagnostics_status='failed'",
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
      'REVIEW_DIAGNOSTICS_LAUNCH_PATH="$review_diagnostics_launch_path"',
      'REVIEW_DIAGNOSTICS_LOG_PATH="$review_diagnostics_log_path"',
      'REVIEW_DIAGNOSTICS_OUTPUT_DIR="$review_diagnostics_output_dir"',
      'REVIEW_DIAGNOSTICS_STATUS="$review_diagnostics_status"',
      'REVIEW_DIAGNOSTICS_STATUS_PATH="$review_diagnostics_status_path"',
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

export function buildWakeReplayCommands(input: {
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
    "# Refresh the saved thread export without relying on the consumer repo's pnpm workspace state.",
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
