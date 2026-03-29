#!/usr/bin/env node

import { Cli, z } from 'incur';

import { preprocessArgv, runReviewGpt, type CliOptions } from './review-gpt-lib.mjs';
import { createThreadCli } from './thread-cli.mjs';

const pkg = JSON.parse(await readText(new URL('../package.json', import.meta.url))) as {
  description?: string;
  version?: string;
};

const cli = Cli.create('cobuild-review-gpt', {
  description:
    pkg.description ??
    'Packages audit context, stages prompts, and opens ChatGPT in a managed Chromium-family browser.',
  examples: [
    { description: 'Run with repo config and a preset', options: { config: 'scripts/review-gpt.config.sh', preset: ['simplify'] } },
    { description: 'Append inline prompt text', options: { config: 'scripts/review-gpt.config.sh', prompt: ['Focus on behavior regressions and unnecessary complexity'] } },
    { description: 'Wait for a response and write it to a file', options: { config: 'scripts/review-gpt.config.sh', wait: true, responseFile: 'audit-packages/review-response.md' } },
  ],
  outputPolicy: 'agent-only',
  options: z.object({
    config: z.string().optional().describe('Optional shell config file for repo-specific defaults and presets.'),
    preset: z.array(z.string()).optional().describe('Preset(s) to include. Repeatable or comma-separated.'),
    prompt: z.array(z.string()).optional().describe('Append custom prompt text inline. Repeatable.'),
    promptFile: z.array(z.string()).optional().describe('Append prompt content from a local file. Repeatable.'),
    model: z.string().optional().describe('Draft model target.'),
    thinking: z.string().optional().describe('Draft thinking target.'),
    deepResearch: z.boolean().optional().describe('Use the dedicated ChatGPT Deep Research page.'),
    chat: z.string().optional().describe('Target ChatGPT URL or chat ID.'),
    chatUrl: z.string().optional().describe('Alias for --chat with an explicit URL value.'),
    chatId: z.string().optional().describe('Alias for --chat with an explicit chat ID.'),
    send: z.boolean().optional().describe('Auto-submit after staging prompt/files.'),
    submit: z.boolean().optional().describe('Alias for --send.'),
    wait: z.boolean().optional().describe('Auto-submit and stay attached until the assistant finishes or the wait timeout is hit.'),
    waitTimeout: z.string().optional().describe('Response wait timeout (for example 90s, 10m, 1h2m).'),
    timeout: z.string().optional().describe('Overall browser automation timeout (for example 90s, 10m, 1h2m).'),
    responseFile: z.string().optional().describe('Write the captured assistant response to a file when --wait is used.'),
    browserPath: z.string().optional().describe('Override the Chromium-compatible browser binary for this run.'),
    browserBinary: z.boolean().optional().describe('Compatibility flag for --browser-binary; use with --browser-path.'),
    noZip: z.boolean().optional().describe('Skip ZIP packaging and stage a prompt-only draft.'),
    listPresets: z.boolean().optional().describe('Print available preset names and exit.'),
    dryRun: z.boolean().optional().describe('Print the staging plan without launching the browser.'),
  }),
  version: pkg.version ?? '0.0.0',
  async run(c) {
    await runReviewGpt(c.options as CliOptions, {
      cwd: process.cwd(),
      rawArgv: originalArgv,
      repoRoot: process.cwd(),
    });
  },
});
cli.command(createThreadCli());

const originalArgv = process.argv.slice(2);
try {
  await cli.serve(preprocessArgv(originalArgv));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

async function readText(url: URL): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(url, 'utf8');
}
