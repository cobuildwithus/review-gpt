#!/usr/bin/env node

import path from 'node:path';

import { DEFAULT_BROWSER_ENDPOINT } from './chatgpt-thread-lib.mjs';
import { formatCodexHomeForDisplay, formatPathForDisplay } from './codex-session-lib.mjs';
import { chatIdFromUrl, parseWakeDelayToMs, runWakeFlow } from './chatgpt-thread-wake-lib.mjs';

type WakeArgs = {
  browserEndpoint: string;
  chatUrl?: string;
  codexHome?: string;
  delay: string;
  downloadTimeoutMs: number;
  fullAuto: boolean;
  outputDir?: string;
  repoDir: string;
  sessionId?: string;
  skipResume: boolean;
};

const HELP_TEXT = `Usage: cobuild-review-gpt-thread-wake --chat-url <url> [options]

Wait, export a ChatGPT thread, download any patch or diff attachments, then resume a Codex session in the current repo.

Options:
  --delay <duration>          Delay before checking the thread. Default: 70m
  --session-id <id>           Codex session ID to resume. Defaults to CODEX_THREAD_ID
  --codex-home <dir>          Explicit Codex home to use. If omitted, the session owner is discovered across local .codex* homes.
  --repo-dir <dir>            Repo working directory for the resumed Codex process. Default: current working directory
  --output-dir <dir>          Output directory for thread export and downloads
  --browser-endpoint <url>    Remote debugging endpoint. Default: ${DEFAULT_BROWSER_ENDPOINT}
  --download-timeout-ms <ms>  Attachment download timeout. Default: 30000
  --skip-resume               Export and download only; do not resume Codex
  --no-full-auto              Omit --full-auto when running codex exec resume
`;

function buildDefaultOutputDir(repoDir: string, chatUrl: string): string {
  const chatId = chatIdFromUrl(chatUrl);
  const timestamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
  return path.join(repoDir, 'output-packages', 'chatgpt-watch', `${chatId}-${timestamp}`);
}

function parseArgs(argv: string[]): WakeArgs {
  const args: WakeArgs = {
    browserEndpoint: DEFAULT_BROWSER_ENDPOINT,
    delay: '70m',
    downloadTimeoutMs: 30_000,
    fullAuto: true,
    repoDir: process.cwd(),
    sessionId: process.env.CODEX_THREAD_ID,
    skipResume: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--help' || token === '-h') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (token === '--delay') {
      args.delay = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (token.startsWith('--delay=')) {
      args.delay = token.slice('--delay='.length);
      continue;
    }
    if (token === '--chat-url') {
      args.chatUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--chat-url=')) {
      args.chatUrl = token.slice('--chat-url='.length);
      continue;
    }
    if (token === '--session-id') {
      args.sessionId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--session-id=')) {
      args.sessionId = token.slice('--session-id='.length);
      continue;
    }
    if (token === '--codex-home') {
      args.codexHome = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--codex-home=')) {
      args.codexHome = token.slice('--codex-home='.length);
      continue;
    }
    if (token === '--repo-dir') {
      args.repoDir = argv[index + 1] ?? process.cwd();
      index += 1;
      continue;
    }
    if (token.startsWith('--repo-dir=')) {
      args.repoDir = token.slice('--repo-dir='.length);
      continue;
    }
    if (token === '--output-dir') {
      args.outputDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--output-dir=')) {
      args.outputDir = token.slice('--output-dir='.length);
      continue;
    }
    if (token === '--browser-endpoint') {
      args.browserEndpoint = argv[index + 1] ?? DEFAULT_BROWSER_ENDPOINT;
      index += 1;
      continue;
    }
    if (token.startsWith('--browser-endpoint=')) {
      args.browserEndpoint = token.slice('--browser-endpoint='.length);
      continue;
    }
    if (token === '--download-timeout-ms') {
      args.downloadTimeoutMs = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }
    if (token.startsWith('--download-timeout-ms=')) {
      args.downloadTimeoutMs = Number.parseInt(token.slice('--download-timeout-ms='.length), 10);
      continue;
    }
    if (token === '--skip-resume') {
      args.skipResume = true;
      continue;
    }
    if (token === '--no-full-auto') {
      args.fullAuto = false;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.chatUrl) {
    throw new Error('--chat-url is required.');
  }
  if (!args.skipResume && !args.sessionId) {
    throw new Error('--session-id is required unless --skip-resume is set or CODEX_THREAD_ID is available.');
  }
  if (!Number.isFinite(args.downloadTimeoutMs) || args.downloadTimeoutMs <= 0) {
    throw new Error('--download-timeout-ms must be a positive integer.');
  }

  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = path.resolve(args.repoDir);
  const outputDir = path.resolve(args.outputDir ?? buildDefaultOutputDir(repoDir, args.chatUrl as string));
  const result = await runWakeFlow({
    browserEndpoint: args.browserEndpoint,
    chatUrl: args.chatUrl as string,
    codexHome: args.codexHome,
    delayMs: parseWakeDelayToMs(args.delay),
    downloadTimeoutMs: args.downloadTimeoutMs,
    fullAuto: args.fullAuto,
    outputDir,
    repoDir,
    sessionId: args.sessionId,
    skipResume: args.skipResume,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        codexHome: result.codexHome ? formatCodexHomeForDisplay(result.codexHome) : undefined,
        downloadedPatches: result.downloadedPatches.map((filePath) => formatPathForDisplay(filePath, repoDir)),
        exportPath: formatPathForDisplay(result.exportPath, repoDir),
        outputDir: formatPathForDisplay(result.outputDir, repoDir),
        repoDir: formatPathForDisplay(result.repoDir, repoDir),
        resumeOutputPath: result.resumeOutputPath ? formatPathForDisplay(result.resumeOutputPath, repoDir) : undefined,
        sessionId: result.sessionId,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
