#!/usr/bin/env node

import { Cli, z } from 'incur';

import { createDelayCli } from './delay-cli.mjs';
import { runReviewGpt, type CliOptions } from './review-gpt-lib.mjs';
import { createThreadCli } from './thread-cli.mjs';

const pkg = JSON.parse(await readText(new URL('../package.json', import.meta.url))) as {
  description?: string;
  version?: string;
};

const cli = Cli.create('cobuild-review-gpt', {
  description:
    pkg.description ??
    'Packages ZIP review context, stages prompts, and opens ChatGPT in a managed Chromium-family browser.',
  examples: [
    { description: 'Run with repo config and a preset', options: { config: 'scripts/review-gpt.config.sh', preset: ['simplify'] } },
    { description: 'Append inline prompt text', options: { config: 'scripts/review-gpt.config.sh', prompt: ['Focus on behavior regressions and unnecessary complexity'] } },
    { description: 'Wait for a response and write it to a file', options: { config: 'scripts/review-gpt.config.sh', wait: true, responseFile: 'audit-packages/review-response.md' } },
  ],
  outputPolicy: 'agent-only',
  args: z.object({
    preset: z.string().optional().describe('Optional positional preset shorthand for a single preset token.'),
  }),
  options: z.object({
    config: z.string().optional().describe('Optional shell config file for repo-specific defaults and presets.'),
    preset: z.array(z.string()).optional().describe('Preset(s) to include. Repeatable, comma-separated, or passed as bare preset tokens.'),
    prompt: z.array(z.string()).optional().describe('Append custom prompt text inline. Repeatable.'),
    promptFile: z.array(z.string()).optional().describe('Append prompt content from a local file. Repeatable.'),
    model: z.string().optional().describe('Draft model target. gpt-5.6-sol (default) and pro target the current ChatGPT Pro model. Waited concrete-model sends require an explicit matching MODEL_CONFIRMATION response line and compatible response-model metadata.'),
    thinking: z.string().optional().describe('Draft thinking target. Use current for normal Pro runs; xhigh and legacy extended are unsupported and fail closed.'),
    appConnector: z.string().optional().describe('ChatGPT app connector target, such as github. Alias: --connector.'),
    connector: z.string().optional().describe('Alias for --app-connector.'),
    artifacts: z.boolean().optional().describe('Attach repo artifact context. Use --no-artifacts for connector-only review context.'),
    zip: z.boolean().optional().describe('Attach the repo ZIP. Use --no-zip to skip artifacts.'),
    deepResearch: z.boolean().optional().describe('Use the dedicated ChatGPT Deep Research page.'),
    chat: z.string().optional().describe('Target ChatGPT URL or chat ID.'),
    chatUrl: z.string().optional().describe('Alias for --chat with an explicit URL value.'),
    chatId: z.string().optional().describe('Alias for --chat with an explicit chat ID.'),
    send: z.boolean().optional().describe('Auto-submit after staging prompt/files.'),
    submit: z.boolean().optional().describe('Alias for --send.'),
    wait: z.boolean().optional().describe('Auto-submit and stay attached until the assistant finishes or the wait timeout is hit.'),
    waitTimeout: z.string().optional().describe('Response wait timeout (for example 90s, 10m, 1h2m).'),
    timeout: z.string().optional().describe('Overall browser automation timeout (for example 90s, 10m, 1h2m).'),
    idleDraftTimeout: z.string().optional().describe('After this grace period, close an unsent draft tab once it is hidden and inactive (default: 30m; 0 disables cleanup).'),
    minimumMarkedResponseTime: z.string().optional().describe('Minimum elapsed time required when a marked concrete-model response lacks compatible response-model metadata (default: 5m; must be positive).'),
    responseFile: z.string().optional().describe('Write the captured assistant response to a file when --wait is used.'),
    responseMarker: z.string().optional().describe('Only treat a captured response as final when it contains this exact text; fast marked concrete-model reviews still require compatible response-model metadata or the --minimum-marked-response-time fallback (use with --wait).'),
    browserPath: z.string().optional().describe('Override the Chromium-compatible browser binary for this run.'),
    browserBinary: z.boolean().optional().describe('Compatibility flag for --browser-binary; use with --browser-path.'),
    withTests: z.boolean().optional().describe('Include configured test scan paths.'),
    tests: z.boolean().optional().describe('Include configured test scan paths. Use --no-tests to exclude them.'),
    listPresets: z.boolean().optional().describe('Print available preset names and exit.'),
    dryRun: z.boolean().optional().describe('Print the staging plan without launching the browser.'),
    headless: z.boolean().optional().describe('Launch the managed browser without visible UI. Use headful mode once to sign in a fresh profile.'),
  }),
  version: pkg.version ?? '0.0.0',
  async run(c) {
    const positionalPreset = normalizePositionalPreset(c.args.preset);
    const mergedPreset = positionalPreset.length > 0
      ? [...(c.options.preset ?? []), ...positionalPreset]
      : c.options.preset;
    return await runReviewGpt({
      ...(c.options as CliOptions),
      preset: mergedPreset,
    }, {
      cwd: process.cwd(),
    });
  },
});
cli.command(createDelayCli());
cli.command(createThreadCli());

const originalArgv = process.argv.slice(2);
try {
  await cli.serve(originalArgv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

async function readText(url: URL): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(url, 'utf8');
}

function normalizePositionalPreset(value: string | undefined): string[] {
  const normalized = String(value || '').trim();
  if (!normalized) return [];
  if (normalized === 'true' || normalized === 'false') return [];
  return [normalized];
}
