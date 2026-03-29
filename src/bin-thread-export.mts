#!/usr/bin/env node

import path from 'node:path';

import { exportThreadSnapshot, DEFAULT_BROWSER_ENDPOINT } from './chatgpt-thread-lib.mjs';
import { formatPathForDisplay } from './codex-session-lib.mjs';

type ExportArgs = {
  browserEndpoint: string;
  chatUrl?: string;
  output?: string;
};

const HELP_TEXT = `Usage: cobuild-review-gpt-thread-export --chat-url <url> --output <file> [--browser-endpoint <endpoint>]

Export the visible contents of an authenticated ChatGPT thread from the managed browser.
`;

function parseArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = {
    browserEndpoint: DEFAULT_BROWSER_ENDPOINT,
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
    if (token === '--output') {
      args.output = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--output=')) {
      args.output = token.slice('--output='.length);
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
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.chatUrl) {
    throw new Error('--chat-url is required.');
  }
  if (!args.output) {
    throw new Error('--output is required.');
  }

  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(args.output as string);
  await exportThreadSnapshot(args.browserEndpoint, args.chatUrl as string, outputPath);
  process.stdout.write(`${formatPathForDisplay(outputPath)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
