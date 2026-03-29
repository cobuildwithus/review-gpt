#!/usr/bin/env node

import path from 'node:path';

import { downloadThreadAttachment, DEFAULT_BROWSER_ENDPOINT } from './chatgpt-thread-lib.mjs';
import { formatPathForDisplay } from './codex-session-lib.mjs';

type DownloadArgs = {
  attachmentText?: string;
  browserEndpoint: string;
  chatUrl?: string;
  outputDir?: string;
  timeoutMs: number;
};

const HELP_TEXT = `Usage: cobuild-review-gpt-thread-download --chat-url <url> --attachment-text <label> --output-dir <dir> [--browser-endpoint <endpoint>] [--timeout-ms <ms>]

Download a patch or diff attachment from an authenticated ChatGPT thread in the managed browser.
`;

function parseArgs(argv: string[]): DownloadArgs {
  const args: DownloadArgs = {
    browserEndpoint: DEFAULT_BROWSER_ENDPOINT,
    timeoutMs: 30_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--help' || token === '-h') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
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
    if (token === '--attachment-text') {
      args.attachmentText = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--attachment-text=')) {
      args.attachmentText = token.slice('--attachment-text='.length);
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
    if (token === '--timeout-ms') {
      args.timeoutMs = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }
    if (token.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number.parseInt(token.slice('--timeout-ms='.length), 10);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.chatUrl) {
    throw new Error('--chat-url is required.');
  }
  if (!args.attachmentText) {
    throw new Error('--attachment-text is required.');
  }
  if (!args.outputDir) {
    throw new Error('--output-dir is required.');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer.');
  }

  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const downloadedFile = await downloadThreadAttachment(
    args.browserEndpoint,
    args.chatUrl as string,
    args.attachmentText as string,
    path.resolve(args.outputDir as string),
    args.timeoutMs,
  );
  process.stdout.write(`${formatPathForDisplay(downloadedFile)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
