import path from 'node:path';

import { Cli, z } from 'incur';

import { DEFAULT_BROWSER_ENDPOINT, downloadThreadAttachment, exportThreadSnapshot } from './chatgpt-thread-lib.mjs';
import { formatCodexHomeForDisplay, formatPathForDisplay } from './codex-session-lib.mjs';
import { chatIdFromUrl, parseWakeDelayToMs, runWakeFlow } from './chatgpt-thread-wake-lib.mjs';

function defaultWakeOutputDir(chatUrl: string): string {
  const chatId = chatIdFromUrl(chatUrl);
  const timestamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
  return path.join(process.cwd(), 'output-packages', 'chatgpt-watch', `${chatId}-${timestamp}`);
}

export function createThreadCli() {
  const cli = Cli.create('thread', {
    description: 'Export ChatGPT threads, download patch, diff, or zip attachments, and resume delayed Codex follow-up work.',
  });

  cli.command('export', {
    description: 'Export the visible contents of an authenticated ChatGPT thread from the managed browser.',
    options: z.object({
      browserEndpoint: z.string().default(DEFAULT_BROWSER_ENDPOINT).describe('Remote debugging endpoint for the managed browser.'),
      chatUrl: z.string().describe('Full ChatGPT conversation URL to export.'),
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
      const outputPath = path.resolve(c.options.output);
      await exportThreadSnapshot(c.options.browserEndpoint, c.options.chatUrl, outputPath);
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
      chatUrl: z.string().describe('Full ChatGPT conversation URL containing the attachment.'),
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
      const downloadedFile = await downloadThreadAttachment(
        c.options.browserEndpoint,
        c.options.chatUrl,
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
    description: 'Wait, export a ChatGPT thread, download any patch, diff, or zip attachments, then resume the owning Codex session in this repo.',
    options: z.object({
      browserEndpoint: z.string().default(DEFAULT_BROWSER_ENDPOINT).describe('Remote debugging endpoint for the managed browser.'),
      chatUrl: z.string().describe('Full ChatGPT conversation URL to revisit later.'),
      codexHome: z.string().optional().describe('Explicit Codex home to use. If omitted, the session owner is discovered across local .codex* homes.'),
      delay: z.string().default('70m').describe('Delay before checking the thread, for example 70m or 1h30m. The managed browser is not touched until this delay elapses.'),
      downloadTimeoutMs: z.number().default(30_000).describe('Attachment download timeout in milliseconds.'),
      fullAuto: z.boolean().default(true).describe('Pass --full-auto to codex exec resume.'),
      outputDir: z.string().optional().describe('Output directory for thread export, downloads, and Codex output.'),
      pollInterval: z.string().default('1m').describe('When polling is enabled, re-check the thread at this interval after the initial delay.'),
      pollTimeout: z.string().optional().describe('Optional overall timeout for polling after the initial delay, for example 20m or 2h.'),
      pollUntilComplete: z.boolean().default(false).describe('After the initial delay, keep polling until the thread no longer looks busy before downloading or resuming.'),
      repoDir: z.string().default('.').describe('Repo working directory for the resumed Codex process.'),
      sessionId: z.string().optional().describe('Codex session ID to resume. Defaults to CODEX_THREAD_ID when set.'),
      skipResume: z.boolean().default(false).describe('Export and download only; do not resume Codex.'),
    }),
    examples: [
      {
        description: 'Wait 70 minutes, then export/download and resume the current session',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '70m',
          sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
        },
      },
      {
        description: 'Check immediately, then poll every minute until the thread finishes',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '0s',
          pollInterval: '1m',
          pollUntilComplete: true,
          sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
        },
      },
      {
        description: 'Export and download only, without resuming Codex',
        options: {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delay: '0s',
          skipResume: true,
        },
      },
    ],
    output: z.object({
      attemptCount: z.number().describe('Number of export checks performed before download/resume.'),
      completionStatus: z.enum(['checked-once', 'completed']).describe('Whether the wake flow only checked once or actively waited for the thread to finish.'),
      codexBin: z.string().optional().describe('Resolved Codex binary path label, when resume ran.'),
      codexHome: z.string().optional().describe('Resolved Codex home label, when resume ran.'),
      downloadedPatches: z.array(z.string()).describe('Downloaded patch, diff, or zip files.'),
      exportPath: z.string().describe('Thread export JSON path.'),
      outputDir: z.string().describe('Directory containing the wake artifacts.'),
      repoDir: z.string().describe('Repo directory used for the resumed Codex process.'),
      resumeOutputPath: z.string().optional().describe('Captured last Codex message path, when resume ran.'),
      sessionId: z.string().optional().describe('Resumed Codex session ID.'),
    }),
    async run(c) {
      const sessionId = c.options.sessionId ?? process.env.CODEX_THREAD_ID;
      if (!c.options.skipResume && !sessionId) {
        throw new Error('thread wake requires --session-id unless --skip-resume is set or CODEX_THREAD_ID is available.');
      }

      const repoDir = path.resolve(c.options.repoDir);
      const outputDir = path.resolve(c.options.outputDir ?? defaultWakeOutputDir(c.options.chatUrl));
      const result = await runWakeFlow({
        browserEndpoint: c.options.browserEndpoint,
        chatUrl: c.options.chatUrl,
        codexHome: c.options.codexHome,
        delayMs: parseWakeDelayToMs(c.options.delay),
        downloadTimeoutMs: c.options.downloadTimeoutMs,
        fullAuto: c.options.fullAuto,
        outputDir,
        pollIntervalMs: parseWakeDelayToMs(c.options.pollInterval),
        pollTimeoutMs: c.options.pollTimeout ? parseWakeDelayToMs(c.options.pollTimeout) : undefined,
        pollUntilComplete: c.options.pollUntilComplete,
        repoDir,
        sessionId,
        skipResume: c.options.skipResume,
      });

      return {
        attemptCount: result.attemptCount,
        completionStatus: result.completionStatus,
        codexBin: result.codexBin ? formatPathForDisplay(result.codexBin, repoDir) : undefined,
        codexHome: result.codexHome ? formatCodexHomeForDisplay(result.codexHome) : undefined,
        downloadedPatches: result.downloadedPatches.map((filePath) => formatPathForDisplay(filePath, repoDir)),
        exportPath: formatPathForDisplay(result.exportPath, repoDir),
        outputDir: formatPathForDisplay(result.outputDir, repoDir),
        repoDir: formatPathForDisplay(result.repoDir, repoDir),
        resumeOutputPath: result.resumeOutputPath ? formatPathForDisplay(result.resumeOutputPath, repoDir) : undefined,
        sessionId: result.sessionId,
      };
    },
  });

  return cli;
}
