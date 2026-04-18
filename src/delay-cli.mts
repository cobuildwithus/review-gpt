import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cli, z } from 'incur';

import { formatPathForDisplay } from './codex-session-lib.mjs';
import type { CliOptions } from './review-gpt-lib.mjs';
import { parseWakeDelayToMs } from './chatgpt-thread-wake-lib.mjs';

const cliEntryPath = fileURLToPath(new URL('./bin.mjs', import.meta.url));

const DEFAULT_DELAY = '50m';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY = '90s';
const DEFAULT_DELAY_FOLLOWUP_PROMPT = 'Check whether the requested implementation has been returned in this chat. If it has, restate the implementation clearly in markdown and summarize the concrete changes inline. Do not request or rely on any patch or diff attachment. If it has not arrived yet, say that it is still pending.';

type DelayCliOptions = CliOptions & {
  delay?: string;
  label?: string;
  retryAttempts?: number;
  retryDelay?: string;
};

type DelayStatusState = 'scheduled' | 'running' | 'retrying' | 'succeeded' | 'failed';

type DelayStatusPayload = {
  attemptCount: number;
  chatTarget: string;
  delayedBy: string;
  lastError: string;
  logFile: string;
  responseFile: string;
  retryAttempts: number;
  retryDelay: string;
  runDir: string;
  scheduledAt: string;
  state: DelayStatusState;
  threadUrl: string;
  remainingSeconds?: number;
};

function normalizePositionalPreset(value: string | undefined): string[] {
  const normalized = String(value || '').trim();
  if (!normalized) return [];
  if (normalized === 'true' || normalized === 'false') return [];
  return [normalized];
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : undefined;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function slugify(value: string): string {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug || 'scheduled-review-gpt';
}

function extractChatTarget(options: DelayCliOptions): string | undefined {
  return trimOptional(options.chat) ?? trimOptional(options.chatUrl) ?? trimOptional(options.chatId);
}

function delayArgsForBooleanOption(flag: string, value: boolean | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return [flag, value ? 'true' : 'false'];
}

function buildDelayedReviewArgs(input: {
  options: DelayCliOptions;
  positionalPreset?: string;
}): string[] {
  const mergedPresets = [
    ...(input.options.preset ?? []),
    ...normalizePositionalPreset(input.positionalPreset),
  ];
  const args = [cliEntryPath];

  if (input.options.config) {
    args.push('--config', input.options.config);
  }
  for (const preset of mergedPresets) {
    args.push('--preset', preset);
  }
  for (const promptFile of input.options.promptFile ?? []) {
    args.push('--prompt-file', promptFile);
  }
  for (const prompt of input.options.prompt ?? []) {
    args.push('--prompt', prompt);
  }
  if (input.options.model) {
    args.push('--model', input.options.model);
  }
  if (input.options.thinking) {
    args.push('--thinking', input.options.thinking);
  }
  if (input.options.deepResearch) {
    args.push('--deep-research');
  }
  const chatTarget = extractChatTarget(input.options);
  if (chatTarget) {
    args.push('--chat', chatTarget);
  }
  args.push(...delayArgsForBooleanOption('--send', input.options.send));
  args.push(...delayArgsForBooleanOption('--wait', input.options.wait));
  if (input.options.timeout) {
    args.push('--timeout', input.options.timeout);
  }
  if (input.options.waitTimeout) {
    args.push('--wait-timeout', input.options.waitTimeout);
  }
  if (input.options.responseFile) {
    args.push('--response-file', input.options.responseFile);
  }
  if (input.options.browserPath) {
    args.push('--browser-path', input.options.browserPath);
  }
  if (input.options.browserBinary) {
    args.push('--browser-binary', 'true');
  }
  if (input.options.withTests) {
    args.push('--with-tests');
  }
  if (input.options.noTests) {
    args.push('--no-tests');
  }
  if (input.options.dryRun) {
    args.push('--dry-run');
  }

  return args;
}

async function writeDelayStatus(
  statusPath: string,
  payload: DelayStatusPayload,
): Promise<void> {
  await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function waitForScheduledStart(input: {
  chatTarget: string;
  delayLabel: string;
  delayMs: number;
  logPath: string;
  responseFile: string;
  retryAttempts: number;
  retryDelayLabel: string;
  runDir: string;
  statusPath: string;
}): Promise<void> {
  const targetEpoch = Date.now() + input.delayMs;
  for (;;) {
    const remainingMs = targetEpoch - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    await writeDelayStatus(input.statusPath, {
      attemptCount: 0,
      chatTarget: input.chatTarget,
      delayedBy: input.delayLabel,
      lastError: '',
      logFile: input.logPath,
      responseFile: input.responseFile,
      retryAttempts: input.retryAttempts,
      retryDelay: input.retryDelayLabel,
      runDir: input.runDir,
      scheduledAt: new Date().toISOString(),
      state: 'scheduled',
      threadUrl: '',
      remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1_000)),
    });
    await sleep(Math.min(remainingMs, 60_000));
  }
}

async function runLoggedReviewProcess(input: {
  args: string[];
  cwd: string;
  logPath: string;
}): Promise<number> {
  await mkdir(path.dirname(input.logPath), { recursive: true });
  const logStream = createWriteStream(input.logPath, {
    flags: 'a',
  });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      logStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      logStream.write(chunk);
    });
    child.on('error', (error) => {
      logStream.end(() => reject(error));
    });
    child.on('close', (code) => {
      logStream.end(() => resolve(code ?? 1));
    });
  });
}

async function appendAttemptBanner(logPath: string, attempt: number, retryAttempts: number): Promise<void> {
  await writeFile(
    logPath,
    `[${new Date().toISOString()}] starting attempt ${attempt}/${retryAttempts}\n`,
    {
      encoding: 'utf8',
      flag: 'a',
    },
  );
}

async function extractThreadUrl(logPath: string): Promise<string | undefined> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  const matches = [...raw.matchAll(/https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/gu)];
  return matches.at(-1)?.[0];
}

function prepareDelayOptions(input: {
  chatTarget: string | undefined;
  options: DelayCliOptions;
  positionalPreset?: string;
  responseFile: string | undefined;
}): DelayCliOptions {
  const hasInlinePromptOverride = (input.options.prompt?.length ?? 0) > 0;
  const hasReviewInput =
    normalizePositionalPreset(input.positionalPreset).length > 0 ||
    (input.options.preset?.length ?? 0) > 0 ||
    (input.options.prompt?.length ?? 0) > 0 ||
    (input.options.promptFile?.length ?? 0) > 0;

  if (!hasInlinePromptOverride && input.chatTarget) {
    return {
      ...input.options,
      prompt: [...(input.options.prompt ?? []), DEFAULT_DELAY_FOLLOWUP_PROMPT],
      responseFile: input.responseFile,
      send: input.options.send ?? true,
      wait: input.options.wait ?? true,
    };
  }

  if (!input.chatTarget && !hasReviewInput) {
    throw new Error('Error: for a delayed new send, pass --prompt, --prompt-file, or a preset.');
  }

  return {
    ...input.options,
    responseFile: input.responseFile,
    send: input.options.send ?? true,
    wait: input.options.wait,
  };
}

export function createDelayCli() {
  const cli = Cli.create('delay', {
    description: 'Schedule a delayed top-level review-gpt run, then execute the normal attached-file review flow after the delay elapses.',
    examples: [
      {
        description: 'Schedule a delayed preset review run',
        options: {
          config: 'scripts/review-gpt.config.sh',
          delay: '50m',
          preset: ['simplify'],
        },
      },
      {
        description: 'Re-check an existing ChatGPT thread later with the default delayed follow-up prompt',
        options: {
          config: 'scripts/review-gpt.config.sh',
          chatUrl: 'https://chatgpt.com/c/69a86c41-cca8-8327-975a-1716caa599cf',
          delay: '50m',
        },
      },
    ],
    args: z.object({
      preset: z.string().optional().describe('Optional positional preset shorthand for a single preset token.'),
    }),
    options: z.object({
      config: z.string().optional().describe('Optional shell config file for repo-specific defaults and presets.'),
      preset: z.array(z.string()).optional().describe('Preset(s) to include. Repeatable, comma-separated, or passed as bare preset tokens.'),
      prompt: z.array(z.string()).optional().describe('Append custom prompt text inline. Repeatable. When following up on an existing chat, any inline prompt overrides the built-in delayed follow-up prompt.'),
      promptFile: z.array(z.string()).optional().describe('Append prompt content from a local file. Repeatable.'),
      model: z.string().optional().describe('Draft model target. Versioned aliases like gpt-5.2-thinking still map to the current ChatGPT picker rows.'),
      thinking: z.string().optional().describe('Draft thinking target.'),
      deepResearch: z.boolean().optional().describe('Use the dedicated ChatGPT Deep Research page.'),
      chat: z.string().optional().describe('Target ChatGPT URL or chat ID.'),
      chatUrl: z.string().optional().describe('Alias for --chat with an explicit URL value.'),
      chatId: z.string().optional().describe('Alias for --chat with an explicit chat ID.'),
      send: z.boolean().optional().describe('Override auto-submit after staging prompt/files. Defaults to true for delayed runs.'),
      submit: z.boolean().optional().describe('Alias for --send.'),
      wait: z.boolean().optional().describe('Override wait behavior after auto-submit. Existing-thread follow-ups default to waiting for the response.'),
      waitTimeout: z.string().optional().describe('Response wait timeout (for example 90s, 10m, 1h2m).'),
      timeout: z.string().optional().describe('Overall browser automation timeout (for example 90s, 10m, 1h2m).'),
      responseFile: z.string().optional().describe('Write the captured assistant response to a file when --wait is used. Existing-thread follow-ups default to a response file inside the scheduled output directory.'),
      browserPath: z.string().optional().describe('Override the Chromium-compatible browser binary for this run.'),
      browserBinary: z.boolean().optional().describe('Compatibility flag for --browser-binary; use with --browser-path.'),
      withTests: z.boolean().optional().describe('Include configured test scan paths.'),
      noTests: z.boolean().optional().describe('Exclude configured test scan paths.'),
      dryRun: z.boolean().optional().describe('Print the staging plan without launching the browser once the delayed run starts.'),
      delay: z.string().default(DEFAULT_DELAY).describe('Delay before starting the normal review-gpt run, for example 50m or 1h30m.'),
      label: z.string().optional().describe('Optional label used to name the delayed output directory.'),
      retryAttempts: z.number().int().min(1).default(DEFAULT_RETRY_ATTEMPTS).describe('How many times to retry the delayed review-gpt run if it exits non-zero.'),
      retryDelay: z.string().default(DEFAULT_RETRY_DELAY).describe('Delay between retries after a failed delayed review-gpt attempt.'),
    }),
    output: z.object({
      attemptCount: z.number().describe('How many delayed review-gpt attempts were needed.'),
      logFile: z.string().describe('Delayed run log file.'),
      outputDir: z.string().describe('Delayed run output directory.'),
      responseFile: z.string().optional().describe('Captured response file path when one is configured.'),
      statusPath: z.string().describe('Delayed run status JSON path.'),
      threadUrl: z.string().optional().describe('Final ChatGPT thread URL when the delayed run printed one.'),
    }),
    async run(c) {
      const delayMs = parseWakeDelayToMs(c.options.delay);
      const retryDelayMs = parseWakeDelayToMs(c.options.retryDelay);
      const retryAttempts = c.options.retryAttempts;
      const chatTarget = extractChatTarget(c.options);
      const timestamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
      const slug = slugify(c.options.label ?? chatTarget ?? 'scheduled-review-gpt');
      const runDir = path.join(process.cwd(), 'output-packages', 'review-gpt-delay', `${timestamp}-${slug}-${process.pid}`);
      const logPath = path.join(runDir, 'run.log');
      const statusPath = path.join(runDir, 'status.json');
      const autoResponseFile = chatTarget && !trimOptional(c.options.responseFile)
        ? path.join(runDir, 'response.md')
        : trimOptional(c.options.responseFile);
      const preparedOptions = prepareDelayOptions({
        chatTarget,
        options: {
          ...c.options,
          send: c.options.submit === true ? true : c.options.send,
        },
        positionalPreset: c.args.preset,
        responseFile: autoResponseFile,
      });
      const childArgs = buildDelayedReviewArgs({
        options: preparedOptions,
        positionalPreset: c.args.preset,
      });

      await mkdir(runDir, { recursive: true });
      process.stderr.write(`Scheduling review:gpt run in ${c.options.delay} (${delayMs / 1000}s).\n`);
      process.stderr.write(`Mode: ${chatTarget ? 'delayed follow-up' : 'delayed new send'}\n`);
      process.stderr.write(`Run dir: ${formatPathForDisplay(runDir)}\n`);
      process.stderr.write(`Log file: ${formatPathForDisplay(logPath)}\n`);
      if (preparedOptions.responseFile) {
        process.stderr.write(`Response file: ${formatPathForDisplay(path.resolve(preparedOptions.responseFile))}\n`);
      }

      await waitForScheduledStart({
        chatTarget: chatTarget ?? '',
        delayLabel: c.options.delay,
        delayMs,
        logPath,
        responseFile: preparedOptions.responseFile ? path.resolve(preparedOptions.responseFile) : '',
        retryAttempts,
        retryDelayLabel: c.options.retryDelay,
        runDir,
        statusPath,
      });

      let attemptCount = 0;
      while (attemptCount < retryAttempts) {
        attemptCount += 1;
        await writeDelayStatus(statusPath, {
          attemptCount,
          chatTarget: chatTarget ?? '',
          delayedBy: c.options.delay,
          lastError: '',
          logFile: logPath,
          responseFile: preparedOptions.responseFile ? path.resolve(preparedOptions.responseFile) : '',
          retryAttempts,
          retryDelay: c.options.retryDelay,
          runDir,
          scheduledAt: new Date().toISOString(),
          state: 'running',
          threadUrl: '',
          remainingSeconds: 0,
        });
        await appendAttemptBanner(logPath, attemptCount, retryAttempts);
        const exitCode = await runLoggedReviewProcess({
          args: childArgs,
          cwd: process.cwd(),
          logPath,
        });
        if (exitCode === 0) {
          const threadUrl = await extractThreadUrl(logPath);
          await writeDelayStatus(statusPath, {
            attemptCount,
            chatTarget: chatTarget ?? '',
            delayedBy: c.options.delay,
            lastError: '',
            logFile: logPath,
            responseFile: preparedOptions.responseFile ? path.resolve(preparedOptions.responseFile) : '',
            retryAttempts,
            retryDelay: c.options.retryDelay,
            runDir,
            scheduledAt: new Date().toISOString(),
            state: 'succeeded',
            threadUrl: threadUrl ?? '',
            remainingSeconds: 0,
          });
          process.stderr.write(`Delayed review:gpt run completed on attempt ${attemptCount}.\n`);
          if (threadUrl) {
            process.stderr.write(`Thread URL: ${threadUrl}\n`);
          }
          return {
            attemptCount,
            logFile: formatPathForDisplay(logPath),
            outputDir: formatPathForDisplay(runDir),
            responseFile: preparedOptions.responseFile
              ? formatPathForDisplay(path.resolve(preparedOptions.responseFile))
              : undefined,
            statusPath: formatPathForDisplay(statusPath),
            threadUrl,
          };
        }

        const lastError = `review:gpt exited non-zero on attempt ${attemptCount}`;
        if (attemptCount >= retryAttempts) {
          await writeDelayStatus(statusPath, {
            attemptCount,
            chatTarget: chatTarget ?? '',
            delayedBy: c.options.delay,
            lastError,
            logFile: logPath,
            responseFile: preparedOptions.responseFile ? path.resolve(preparedOptions.responseFile) : '',
            retryAttempts,
            retryDelay: c.options.retryDelay,
            runDir,
            scheduledAt: new Date().toISOString(),
            state: 'failed',
            threadUrl: '',
            remainingSeconds: 0,
          });
          throw new Error(`Delayed review:gpt run failed after ${attemptCount} attempt(s). See ${formatPathForDisplay(logPath)}.`);
        }

        await writeDelayStatus(statusPath, {
          attemptCount,
          chatTarget: chatTarget ?? '',
          delayedBy: c.options.delay,
          lastError,
          logFile: logPath,
          responseFile: preparedOptions.responseFile ? path.resolve(preparedOptions.responseFile) : '',
          retryAttempts,
          retryDelay: c.options.retryDelay,
          runDir,
          scheduledAt: new Date().toISOString(),
          state: 'retrying',
          threadUrl: '',
          remainingSeconds: Math.ceil(retryDelayMs / 1_000),
        });
        await sleep(retryDelayMs);
      }

      throw new Error(`Delayed review:gpt run failed after ${attemptCount} attempt(s). See ${formatPathForDisplay(logPath)}.`);
    },
  });

  return cli;
}
