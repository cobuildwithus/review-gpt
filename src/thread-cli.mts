import path from 'node:path';

import { Cli, z } from 'incur';

import { DEFAULT_BROWSER_ENDPOINT, downloadThreadAttachment, exportThreadSnapshot } from './chatgpt-thread-lib.mjs';
import { formatCodexHomeForDisplay, formatPathForDisplay } from './codex-session-lib.mjs';
import { chatIdFromUrl, parseWakeDelayToMs, runWakeFlow } from './chatgpt-thread-wake-lib.mjs';

function normalizeConversationUrl(chatUrl: string): string {
  try {
    const parsed = new URL(chatUrl);
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)\/?$/u);
    const chatId = match?.[1];
    if (!chatId) {
      throw new Error('missing-chat-id');
    }
    return `${parsed.origin}/c/${chatId}`;
  } catch {
    throw new Error(
      `Expected a full ChatGPT conversation URL like https://chatgpt.com/c/<thread-id>; received ${chatUrl}`,
    );
  }
}

function defaultWakeOutputDir(chatUrl: string): string {
  const chatId = chatIdFromUrl(chatUrl);
  const timestamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
  return path.join(process.cwd(), 'output-packages', 'chatgpt-watch', `${chatId}-${timestamp}`);
}

export function createThreadCli() {
  const cli = Cli.create('thread', {
    description: 'Export ChatGPT threads, download patch, diff, or zip attachments, and launch delayed Codex follow-up work.',
  });

  cli.command('export', {
    description: 'Export the visible contents of an authenticated ChatGPT thread from the managed browser.',
    options: z.object({
      browserEndpoint: z.string().default(DEFAULT_BROWSER_ENDPOINT).describe('Remote debugging endpoint for the managed browser.'),
      chatUrl: z.string().describe('Full ChatGPT conversation URL (/c/<thread-id>) to export.'),
      output: z.string().describe('Output JSON file path.'),
    }),
    examples: [
      {
        description: 'Export a ChatGPT thread snapshot',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          output: 'output-packages/thread.json',
        },
      },
    ],
    output: z.object({
      exportPath: z.string().describe('Thread export JSON path.'),
    }),
    async run(c) {
      const chatUrl = normalizeConversationUrl(c.options.chatUrl);
      const outputPath = path.resolve(c.options.output);
      await exportThreadSnapshot(c.options.browserEndpoint, chatUrl, outputPath);
      return {
        exportPath: formatPathForDisplay(outputPath),
      };
    },
  });

  cli.command('download', {
    description: 'Download a patch, diff, or zip attachment from an authenticated ChatGPT thread.',
    options: z.object({
      attachmentText: z.string().describe('Attachment button label to click and download.'),
      browserEndpoint: z.string().default(DEFAULT_BROWSER_ENDPOINT).describe('Remote debugging endpoint for the managed browser.'),
      chatUrl: z.string().describe('Full ChatGPT conversation URL (/c/<thread-id>) containing the attachment.'),
      outputDir: z.string().describe('Directory where the download should be written.'),
      timeoutMs: z.number().default(30_000).describe('Attachment download timeout in milliseconds.'),
    }),
    examples: [
      {
        description: 'Download an attachment from a thread',
        options: {
          attachmentText: 'assistant-unified-final-pass-fixes.patch',
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          outputDir: 'output-packages/downloads',
        },
      },
    ],
    output: z.object({
      downloadedFile: z.string().describe('Downloaded attachment path.'),
    }),
    async run(c) {
      const chatUrl = normalizeConversationUrl(c.options.chatUrl);
      const downloadedFile = await downloadThreadAttachment(
        c.options.browserEndpoint,
        chatUrl,
        c.options.attachmentText,
        path.resolve(c.options.outputDir),
        c.options.timeoutMs,
      );
      return {
        downloadedFile: formatPathForDisplay(downloadedFile),
      };
    },
  });

  cli.command('wake', {
    description: 'Wait, export a ChatGPT thread, download any patch, diff, or zip attachments, then launch an interactive Codex session in the owning Codex home.',
    options: z.object({
      browserEndpoint: z.string().default(DEFAULT_BROWSER_ENDPOINT).describe('Remote debugging endpoint for the managed browser.'),
      chatUrl: z.string().describe('Full ChatGPT conversation URL (/c/<thread-id>) to revisit later.'),
      codexHome: z.string().optional().describe('Explicit Codex home to use. If omitted, the session owner is discovered across local .codex* homes.'),
      delay: z.string().default('70m').describe('Delay before checking the thread, for example 70m or 1h30m. The managed browser is not touched until this delay elapses.'),
      downloadTimeoutMs: z.number().default(30_000).describe('Attachment download timeout in milliseconds.'),
      fullAuto: z.boolean().default(false).describe('Pass --full-auto to the launched Codex session. Disabled by default so wake matches a normal interactive launch.'),
      outputDir: z.string().optional().describe('Output directory for thread export, downloads, and Codex output.'),
      pollInterval: z.string().default('1m').describe('When polling is enabled, re-check the thread at this base interval after the initial delay.'),
      pollJitter: z.string().default('1m').describe('Optional extra random delay added after each polling cycle. Defaults to 1m, so the default wake cadence retries after 60-120s and also adds a small startup spread before the first export. Use 0s to disable jitter.'),
      pollTimeout: z.string().optional().describe('Optional overall timeout for polling after the initial delay, for example 20m or 2h.'),
      pollUntilComplete: z.boolean().default(true).describe('Poll until the thread no longer looks busy before downloading or launching the child run. Disable with --no-poll-until-complete for the old one-shot behavior.'),
      repoDir: z.string().default('.').describe('Repo working directory for the spawned Codex child process.'),
      resumePrompt: z.string().optional().describe('Append extra instructions to the spawned Codex child prompt after patch download. Supports {{chat_url}} and {{chat_id}} placeholders for the watched thread.'),
      sessionId: z.string().optional().describe('Origin Codex session ID used to resolve the owning Codex home. Defaults to CODEX_THREAD_ID when set.'),
      skipResume: z.boolean().default(false).describe('Export and download only; do not launch the Codex child process.'),
    }),
    examples: [
      {
        description: 'Wait 70 minutes, then poll/export/download and launch a new child session in the same Codex home',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '70m',
          sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
        },
      },
      {
        description: 'Check right away with the default small startup spread, then poll every minute until the thread finishes before launching the child session',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '0s',
          pollInterval: '1m',
          pollJitter: '1m',
          sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
        },
      },
      {
        description: 'Run the old one-shot export/download path without polling',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '0s',
          pollUntilComplete: false,
          skipResume: true,
        },
      },
      {
        description: 'Append custom follow-up instructions for the launched Codex session',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '0s',
          resumePrompt:
            'After applying the returned patch, run pnpm review:gpt --send --chat-url {{chat_url}} and ask for final bug and simplification feedback.',
          sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
        },
      },
    ],
    output: z.object({
      attemptCount: z.number().describe('Number of export checks performed before download or child launch.'),
      completionStatus: z.enum(['checked-once', 'completed']).describe('Whether the wake flow only checked once or actively waited for the thread to finish.'),
      childSessionId: z.string().optional().describe('Spawned Codex session ID, when available from the underlying launcher.'),
      codexBin: z.string().optional().describe('Resolved Codex binary path label, when the child run launched.'),
      codexHome: z.string().optional().describe('Resolved Codex home label used for the child run.'),
      downloadedPatches: z.array(z.string()).describe('Downloaded patch, diff, or zip files.'),
      eventsPath: z.string().optional().describe('Captured child Codex JSON event stream path, when available from the underlying launcher.'),
      exportPath: z.string().describe('Thread export JSON path.'),
      outputDir: z.string().describe('Directory containing the wake artifacts.'),
      repoDir: z.string().describe('Repo directory used for the spawned Codex child process.'),
      resumeOutputPath: z.string().optional().describe('Captured last Codex message path, when available from the underlying launcher.'),
      sessionId: z.string().optional().describe('Origin Codex session ID used to resolve the owning Codex home.'),
      statusPath: z.string().optional().describe('Wake status JSON path.'),
    }),
    async run(c) {
      const sessionId = c.options.sessionId ?? process.env.CODEX_THREAD_ID;
      if (!c.options.skipResume && !sessionId) {
        throw new Error('thread wake requires --session-id unless --skip-resume is set or CODEX_THREAD_ID is available.');
      }

      const chatUrl = normalizeConversationUrl(c.options.chatUrl);
      const repoDir = path.resolve(c.options.repoDir);
      const outputDir = path.resolve(c.options.outputDir ?? defaultWakeOutputDir(chatUrl));
      const result = await runWakeFlow({
        browserEndpoint: c.options.browserEndpoint,
        chatUrl,
        codexHome: c.options.codexHome,
        delayMs: parseWakeDelayToMs(c.options.delay),
        downloadTimeoutMs: c.options.downloadTimeoutMs,
        fullAuto: c.options.fullAuto,
        outputDir,
        pollJitterMs: parseWakeDelayToMs(c.options.pollJitter),
        pollIntervalMs: parseWakeDelayToMs(c.options.pollInterval),
        pollTimeoutMs: c.options.pollTimeout ? parseWakeDelayToMs(c.options.pollTimeout) : undefined,
        pollUntilComplete: c.options.pollUntilComplete,
        repoDir,
        resumePrompt: c.options.resumePrompt,
        sessionId,
        skipResume: c.options.skipResume,
      });

      return {
        attemptCount: result.attemptCount,
        childSessionId: result.childSessionId,
        completionStatus: result.completionStatus,
        codexBin: result.codexBin ? formatPathForDisplay(result.codexBin, repoDir) : undefined,
        codexHome: result.codexHome ? formatCodexHomeForDisplay(result.codexHome) : undefined,
        downloadedPatches: result.downloadedPatches.map((filePath) => formatPathForDisplay(filePath, repoDir)),
        eventsPath: result.eventsPath ? formatPathForDisplay(result.eventsPath, repoDir) : undefined,
        exportPath: formatPathForDisplay(result.exportPath, repoDir),
        outputDir: formatPathForDisplay(result.outputDir, repoDir),
        repoDir: formatPathForDisplay(result.repoDir, repoDir),
        resumeOutputPath: result.resumeOutputPath ? formatPathForDisplay(result.resumeOutputPath, repoDir) : undefined,
        sessionId: result.sessionId,
        statusPath: result.statusPath ? formatPathForDisplay(result.statusPath, repoDir) : undefined,
      };
    },
  });

  return cli;
}
