import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  conversationUrlsReferToSameThread,
  DEFAULT_BROWSER_ENDPOINT,
  exportThreadSnapshot,
  fetchJson,
  pickBestThreadTarget,
  type CdpTarget,
} from './chatgpt-thread-lib.mjs';

type BrowserVersionResponse = {
  Browser?: string;
  ['Protocol-Version']?: string;
  ['User-Agent']?: string;
  webSocketDebuggerUrl?: string;
};

type BrowserTargetDiagnostics = {
  id: string;
  isPreferred: boolean;
  score: number;
  title: string;
  type: string;
  url: string;
};

type BrowserTargetRecord = CdpTarget & {
  id?: string;
  title?: string;
};

export type ThreadDiagnosticsResult = {
  outputDir: string;
  statusPath: string;
};

export type ThreadDiagnosticsOptions = {
  browserEndpoint?: string;
  chatUrl: string;
  commandLabel?: string;
  cwd?: string;
  exitCode?: number | null;
  logFilePath?: string;
  outputDir?: string;
  receiptPath?: string;
};

type ThreadDiagnosticsDependencies = {
  exportThreadSnapshot: typeof exportThreadSnapshot;
  fetchJson: typeof fetchJson;
};

const DEFAULT_DIAGNOSTICS_DEPENDENCIES: ThreadDiagnosticsDependencies = {
  exportThreadSnapshot,
  fetchJson,
};

const HOME_DIR = homedir();

function redactLocalPath(value: string): string {
  if (!value) {
    return value;
  }
  if (value === HOME_DIR) {
    return '<HOME_DIR>';
  }
  if (value.startsWith(`${HOME_DIR}/`)) {
    return `<HOME_DIR>${value.slice(HOME_DIR.length)}`;
  }
  return value;
}

function sanitizeText(value: string): string {
  return String(value ?? '').replaceAll(HOME_DIR, '<HOME_DIR>');
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]),
    );
  }
  return value;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/u, '');
  return normalized.length > 0 ? normalized : '/';
}

function scoreThreadTargetUrl(targetUrl: string | undefined, chatUrl: string): number {
  const target = parseUrl(targetUrl ?? '');
  const chat = parseUrl(chatUrl);
  if (!target || !chat || target.origin !== chat.origin) {
    return -1;
  }

  const normalizedTargetPath = normalizePathname(target.pathname);
  const normalizedChatPath = normalizePathname(chat.pathname);
  if (normalizedTargetPath === normalizedChatPath && target.search === chat.search) {
    return 3;
  }

  if (conversationUrlsReferToSameThread(targetUrl ?? '', chatUrl)) {
    return 2;
  }

  return -1;
}

function extractChatId(chatUrl: string): string {
  const pathname = parseUrl(chatUrl)?.pathname ?? '';
  return pathname.split('/').filter(Boolean).at(-1) ?? 'thread';
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug || fallback;
}

function resolveDiagnosticsOutputDir(options: ThreadDiagnosticsOptions): string {
  if (options.outputDir) {
    return path.resolve(options.outputDir);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const timestamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
  const commandLabel = slugify(options.commandLabel ?? 'review-gpt', 'review-gpt');
  const chatId = slugify(extractChatId(options.chatUrl), 'thread');
  return path.join(
    cwd,
    'output-packages',
    'review-gpt-diagnostics',
    `${timestamp}-${commandLabel}-${chatId}-${process.pid}`,
  );
}

function relativeToBase(baseDir: string, targetPath: string): string {
  return redactLocalPath(path.relative(baseDir, targetPath) || '.');
}

async function writeSanitizedJson(targetPath: string, value: unknown): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(sanitizeValue(value), null, 2)}\n`, 'utf8');
}

async function copySanitizedTextFile(sourcePath: string, destinationPath: string): Promise<void> {
  const raw = await readFile(sourcePath, 'utf8');
  await writeFile(destinationPath, sanitizeText(raw), 'utf8');
}

async function copySanitizedJsonFile(sourcePath: string, destinationPath: string): Promise<unknown> {
  const raw = await readFile(sourcePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  await writeSanitizedJson(destinationPath, parsed);
  return parsed;
}

function summarizeMatchingTargets(targets: BrowserTargetRecord[], chatUrl: string): BrowserTargetDiagnostics[] {
  const preferredTarget = pickBestThreadTarget(targets as CdpTarget[], chatUrl);
  return targets
    .filter((target) => target.type === 'page' && scoreThreadTargetUrl(target.url, chatUrl) >= 0)
    .map((target) => ({
      id: String(target.id ?? ''),
      isPreferred:
        String(target.id ?? '') !== '' &&
        String(target.id ?? '') === String((preferredTarget as BrowserTargetRecord | null)?.id ?? ''),
      score: scoreThreadTargetUrl(target.url, chatUrl),
      title: String(target.title ?? ''),
      type: String(target.type ?? ''),
      url: String(target.url ?? ''),
    }));
}

export async function collectThreadDiagnostics(
  options: ThreadDiagnosticsOptions,
  dependencies: ThreadDiagnosticsDependencies = DEFAULT_DIAGNOSTICS_DEPENDENCIES,
): Promise<ThreadDiagnosticsResult> {
  const browserEndpoint = options.browserEndpoint ?? DEFAULT_BROWSER_ENDPOINT;
  const outputDir = resolveDiagnosticsOutputDir(options);
  const statusPath = path.join(outputDir, 'status.json');
  const cwd = path.resolve(options.cwd ?? process.cwd());

  await mkdir(outputDir, { recursive: true });

  let commandLogPath = '';
  if (options.logFilePath && existsSync(options.logFilePath)) {
    commandLogPath = path.join(outputDir, 'command.log');
    await copySanitizedTextFile(options.logFilePath, commandLogPath);
  }

  let receiptPath = '';
  let receiptSummary: {
    nextWakeStatus: string;
    requestedDepth: number;
    reviewDiagnosticsStatus?: string;
    reviewSendStatus: string;
  } | null = null;
  if (options.receiptPath && existsSync(options.receiptPath)) {
    receiptPath = path.join(outputDir, 'receipt.json');
    const receipt = (await copySanitizedJsonFile(options.receiptPath, receiptPath)) as Record<string, unknown>;
    receiptSummary = {
      nextWakeStatus: String(receipt.nextWakeStatus ?? ''),
      requestedDepth: Number(receipt.requestedDepth ?? 0),
      reviewDiagnosticsStatus:
        receipt.reviewDiagnosticsStatus === undefined
          ? undefined
          : String(receipt.reviewDiagnosticsStatus ?? ''),
      reviewSendStatus: String(receipt.reviewSendStatus ?? ''),
    };
  }

  const versionResponse = await dependencies.fetchJson<BrowserVersionResponse>(
    new URL('/json/version', `${browserEndpoint.replace(/\/$/u, '')}/`).toString(),
  );
  const targets = await dependencies.fetchJson<BrowserTargetRecord[]>(
    new URL('/json/list', `${browserEndpoint.replace(/\/$/u, '')}/`).toString(),
  );
  const matchingTargets = summarizeMatchingTargets(targets, options.chatUrl);

  await writeSanitizedJson(path.join(outputDir, 'browser-version.json'), {
    browser: String(versionResponse.Browser ?? ''),
    protocolVersion: String(versionResponse['Protocol-Version'] ?? ''),
    userAgent: String(versionResponse['User-Agent'] ?? ''),
    webSocketDebuggerUrl: String(versionResponse.webSocketDebuggerUrl ?? ''),
  });

  await writeSanitizedJson(path.join(outputDir, 'browser-targets.json'), {
    browserEndpoint,
    matchingTargets,
    matchingThreadTargetCount: matchingTargets.length,
    pageTargetCount: targets.filter((target) => target.type === 'page').length,
    preferredTargetId: matchingTargets.find((target) => target.isPreferred)?.id ?? '',
    preferredTargetUrl: matchingTargets.find((target) => target.isPreferred)?.url ?? '',
    targetCount: targets.length,
  });

  const rawExportPath = path.join(outputDir, 'thread.raw.json');
  const exportPath = path.join(outputDir, 'thread.json');
  const exportLogPath = path.join(outputDir, 'thread-export.log');
  let exportError = '';

  try {
    await dependencies.exportThreadSnapshot(browserEndpoint, options.chatUrl, rawExportPath);
    const rawExport = await readFile(rawExportPath, 'utf8');
    await writeFile(exportPath, sanitizeText(rawExport), 'utf8');
    await writeFile(exportLogPath, 'thread export succeeded\n', 'utf8');
  } catch (error) {
    exportError = error instanceof Error ? error.message : 'Failed to export thread snapshot.';
    await writeFile(exportLogPath, `${sanitizeText(exportError)}\n`, 'utf8');
  } finally {
    await rm(rawExportPath, { force: true });
  }

  await writeSanitizedJson(statusPath, {
    browser: {
      browserEndpoint,
      matchingTargets,
      matchingThreadTargetCount: matchingTargets.length,
      pageTargetCount: targets.filter((target) => target.type === 'page').length,
      preferredTargetId: matchingTargets.find((target) => target.isPreferred)?.id ?? '',
      preferredTargetUrl: matchingTargets.find((target) => target.isPreferred)?.url ?? '',
      targetCount: targets.length,
    },
    chatUrl: options.chatUrl,
    commandLabel: options.commandLabel ?? 'review:gpt',
    commandLogPath: commandLogPath ? relativeToBase(cwd, commandLogPath) : '',
    commandLogSourcePath: options.logFilePath ? redactLocalPath(options.logFilePath) : '',
    exitCode: options.exitCode ?? null,
    export: {
      error: sanitizeText(exportError),
      exportLogPath: relativeToBase(cwd, exportLogPath),
      exportPath: exportError ? '' : relativeToBase(cwd, exportPath),
      status: exportError ? 'failed' : 'succeeded',
    },
    generatedAt: new Date().toISOString(),
    inputReceiptPath: options.receiptPath ? redactLocalPath(options.receiptPath) : '',
    outputDir: relativeToBase(cwd, outputDir),
    receipt: receiptSummary,
    receiptCopyPath: receiptPath ? relativeToBase(cwd, receiptPath) : '',
  });

  return {
    outputDir,
    statusPath,
  };
}
