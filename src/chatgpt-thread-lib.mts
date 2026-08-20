import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  buildCaptureThreadSnapshotExpression,
  completeThreadCaptureIdentity,
  isCaptureIdentityDigest,
  deriveAttachmentLabel,
  extractAssistantArtifactButtons,
  extractAssistantDownloadButtons,
  hasThreadPayload,
  isPatchArtifactAttachment,
  mergeDeepResearchReportSnapshot,
  normalizeThreadSnapshot,
  normalizeAttachmentValue,
  scopeThreadSnapshotToCaptureIdentity,
  type ExportedThreadSnapshot,
  type ThreadAssistantDownloadButton,
  type ThreadCaptureIdentity,
  type ThreadSnapshot,
} from './chatgpt-thread-snapshot-lib.mjs';
export {
  assistantSnapshotLooksIncomplete,
  assistantSnapshotLooksTerminal,
  completeThreadCaptureIdentity,
  extractAssistantArtifactLabels,
  hasThreadPayload,
  isCaptureIdentityDigest,
  normalizeThreadSnapshot,
  parseThreadCaptureIdentity,
  scopeThreadSnapshotToCaptureIdentity,
  snapshotBusyReason,
  snapshotHasAssistantArtifacts,
  snapshotHasPatchArtifacts,
  snapshotIndicatesBusy,
  threadStatusTextIndicatesComplete,
  threadStatusTextIndicatesBusy,
} from './chatgpt-thread-snapshot-lib.mjs';
export type {
  ExportedThreadSnapshot,
  ThreadCaptureIdentity,
  ThreadAssistantSnapshot,
  ThreadAttachmentButton,
  ThreadSnapshot,
} from './chatgpt-thread-snapshot-lib.mjs';

const require = createRequire(import.meta.url);
const {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  buildDeepResearchResponseInspectionSource,
  canonicalizeChatGptTurnNodes,
} = require('./chatgpt-dom-snapshot-shared.js') as typeof import('./chatgpt-dom-snapshot-shared.js');

export const DEFAULT_BROWSER_ENDPOINT = 'http://127.0.0.1:9222';
const BROWSER_ENDPOINT_REQUEST_TIMEOUT_MS = 10_000;
const TARGET_READY_TIMEOUT_MS = 60_000;
const TARGET_READY_POLL_MS = 750;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const NATIVE_DOWNLOAD_GRACE_MS = 1_500;
const LATE_NATIVE_DOWNLOAD_GRACE_MS = 1_000;
const SNAPSHOT_SETTLE_TIMEOUT_MS = 20_000;
const SNAPSHOT_SETTLE_POLL_MS = 500;

export type ExportThreadSnapshotOptions = {
  captureIdentity?: ThreadCaptureIdentity;
  forceReload?: boolean;
  onTargetLease?: (lease: CdpTargetLease) => void;
  targetLifecycle?: ThreadTargetLifecycle;
};

type CdpPending = {
  reject: (error?: unknown) => void;
  resolve: (value: unknown) => void;
};

type CdpCloseListener = (error: Error) => void;

type CdpEvaluateOptions = {
  awaitPromise?: boolean;
  returnByValue?: boolean;
};

type CdpNetworkResponse = {
  headers?: Record<string, string | undefined>;
  status?: number;
  url?: string;
};

type CdpPayload = {
  error?: unknown;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

export type CdpEvent = {
  method?: string;
  params?: Record<string, unknown>;
};

export type CdpTarget = {
  id?: string;
  parentId?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl: string;
};

export type ThreadTargetLifecycle = 'keep' | 'close-created';

export type CdpTargetLease = {
  created: boolean;
  rehydrated?: boolean;
  target: CdpTarget;
};

export type ThreadContentState = {
  articleCount: number;
  attachmentButtonCount: number;
  bodyLength: number;
  href: string;
  messageCount: number;
  readyState: string;
  title: string;
};

export type ThreadAttachmentDownloadSelector = {
  artifactIndex?: number;
  artifactIndexInAssistantTurn?: number;
  assistantTurnId?: string;
  assistantTurnIndex?: number;
  href?: string | null;
};

function normalizeError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
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

function extractChatId(pathname: string): string | null {
  const match = normalizePathname(pathname).match(/^\/c\/([^/?#]+)$/u);
  return match?.[1] ?? null;
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

export function conversationUrlsReferToSameThread(candidateUrl: string, chatUrl: string): boolean {
  const candidate = parseUrl(candidateUrl);
  const chat = parseUrl(chatUrl);
  if (!candidate || !chat || candidate.origin !== chat.origin) {
    return false;
  }

  const candidateChatId = extractChatId(candidate.pathname);
  const chatId = extractChatId(chat.pathname);
  return candidateChatId !== null && chatId !== null && candidateChatId === chatId;
}

export function pickBestThreadTarget(targets: CdpTarget[], chatUrl: string): CdpTarget | null {
  let bestScore = -1;
  let bestTarget: CdpTarget | null = null;

  for (const target of targets) {
    if (target.type !== 'page' || !target.webSocketDebuggerUrl) {
      continue;
    }

    const score = scoreThreadTargetUrl(target.url, chatUrl);
    if (score < 0) {
      continue;
    }

    if (score >= bestScore) {
      bestScore = score;
      bestTarget = target;
    }
  }

  return bestTarget;
}

function getNetworkResponse(event: CdpEvent): CdpNetworkResponse {
  return (event.params?.response as CdpNetworkResponse | undefined) ?? {};
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  if (await exists(filePath)) {
    await rm(filePath, { force: true });
  }
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

async function listDownloadDirectoryFiles(dirPath: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(dirPath, entry.name);
    const size = await fileSize(filePath);
    if (size !== null) {
      files.set(filePath, size);
    }
  }

  return files;
}

async function removeEmptyDownloadFilesCreatedSince(dirPath: string, beforeFiles: Map<string, number>): Promise<void> {
  const afterFiles = await listDownloadDirectoryFiles(dirPath);
  await Promise.all(
    [...afterFiles.entries()]
      .filter(([filePath, size]) => size === 0 && beforeFiles.get(filePath) !== 0)
      .map(([filePath]) => rm(filePath, { force: true })),
  );
}

export async function fetchJson<T>(
  url: string,
  options: {
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? BROWSER_ENDPOINT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Browser endpoint request timeout must be a positive integer.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
    ) {
      throw new Error(`Timed out fetching ${url} after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class CdpClient {
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();

  private readonly closeListeners = new Set<CdpCloseListener>();

  private nextId = 1;

  private readonly pending = new Map<number, CdpPending>();

  private terminalError: Error | null = null;

  readonly ready: Promise<void>;

  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      let opened = false;
      this.ws.addEventListener(
        'open',
        () => {
          opened = true;
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        'error',
        () => {
          const error = new Error(opened ? 'CDP socket errored unexpectedly.' : 'CDP socket failed to open.');
          if (!opened) {
            reject(error);
          }
          this.failPending(error);
        },
        { once: true },
      );
      this.ws.addEventListener(
        'close',
        () => {
          const error = new Error(opened ? 'CDP socket closed unexpectedly.' : 'CDP socket closed before opening.');
          if (!opened) {
            reject(error);
          }
          this.failPending(error);
        },
        { once: true },
      );
    });
    this.ws.addEventListener('message', (event) => {
      let payload: CdpPayload;
      try {
        payload = JSON.parse(String(event.data)) as CdpPayload;
      } catch (error) {
        this.failPending(normalizeError(error, 'Failed to parse a CDP websocket payload.'));
        return;
      }

      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) {
          return;
        }
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(JSON.stringify(payload.error)));
          return;
        }
        pending.resolve(payload.result);
        return;
      }

      const message: CdpEvent = {
        method: payload.method,
        params: payload.params,
      };
      for (const listener of this.eventListeners) {
        listener(message);
      }
    });
  }

  private failPending(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      listener(error);
    }
    this.closeListeners.clear();
  }

  private onTerminalError(listener: CdpCloseListener): () => void {
    if (this.terminalError) {
      listener(this.terminalError);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    this.failPending(new Error('CDP client closed.'));
    this.ws.close();
  }

  async evaluate<T>(expression: string, options: CdpEvaluateOptions = {}): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      awaitPromise: options.awaitPromise ?? false,
      expression,
      returnByValue: options.returnByValue ?? true,
    })) as {
      exceptionDetails?: {
        exception?: { description?: string };
        text?: string;
      };
      result?: {
        value?: T;
      };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'CDP Runtime.evaluate failed.',
      );
    }
    return result.result?.value as T;
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    if (this.terminalError) {
      throw this.terminalError;
    }
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<T>((resolve, reject) => {
      const removeTerminalListener = this.onTerminalError((error) => {
        this.pending.delete(id);
        reject(error);
      });
      this.pending.set(id, {
        reject: (error) => {
          removeTerminalListener();
          reject(error);
        },
        resolve: (value) => {
          removeTerminalListener();
          resolve(value as T);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        removeTerminalListener();
        reject(normalizeError(error, `Failed to send CDP command ${method}.`));
      }
    });
  }

  waitForEvent(predicate: (event: CdpEvent) => boolean, timeoutMs = TARGET_READY_TIMEOUT_MS): Promise<CdpEvent> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    return new Promise((resolve, reject) => {
      let removeTerminalListener = () => {};
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.eventListeners.delete(handleEvent);
        removeTerminalListener();
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for matching CDP event after ${timeoutMs}ms`));
      }, timeoutMs);

      const handleEvent = (event: CdpEvent) => {
        if (!predicate(event)) {
          return;
        }
        cleanup();
        resolve(event);
      };

      removeTerminalListener = this.onTerminalError((error) => {
        cleanup();
        reject(error);
      });
      this.eventListeners.add(handleEvent);
    });
  }
}

async function createTarget(browserEndpoint: string, chatUrl: string): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl: string }>(`${browserEndpoint}/json/version`);
  const browser = new CdpClient(version.webSocketDebuggerUrl);
  try {
    const result = await browser.send<{ targetId?: string }>('Target.createTarget', { url: chatUrl, background: true });
    const targetId = String(result.targetId ?? '');
    if (!targetId) {
      throw new Error('Browser created a thread target without returning its target id.');
    }
    return targetId;
  } finally {
    browser.close();
  }
}

export async function closeTarget(browserEndpoint: string, targetId: string): Promise<void> {
  if (!targetId) {
    return;
  }
  const version = await fetchJson<{ webSocketDebuggerUrl: string }>(`${browserEndpoint}/json/version`);
  const browser = new CdpClient(version.webSocketDebuggerUrl);
  try {
    await browser.send('Target.closeTarget', { targetId });
  } finally {
    browser.close();
  }
}

async function findMatchingTarget(browserEndpoint: string, chatUrl: string): Promise<CdpTarget | null> {
  const targets = await fetchJson<CdpTarget[]>(`${browserEndpoint}/json/list`);
  return pickBestThreadTarget(targets, chatUrl);
}

async function findTargetById(browserEndpoint: string, targetId: string): Promise<CdpTarget | null> {
  const targets = await fetchJson<CdpTarget[]>(`${browserEndpoint}/json/list`);
  return targets.find(
    (target) =>
      target.id === targetId &&
      target.type === 'page' &&
      Boolean(target.webSocketDebuggerUrl),
  ) ?? null;
}

export async function closeThreadTarget(
  browserEndpoint: string,
  chatUrl: string,
  exactTargetId?: string,
): Promise<boolean> {
  const target = exactTargetId
    ? (await fetchJson<CdpTarget[]>(`${browserEndpoint}/json/list`)).find(
        (candidate) =>
          candidate.type === 'page' &&
          candidate.id === exactTargetId &&
          conversationUrlsReferToSameThread(candidate.url ?? '', chatUrl),
      ) ?? null
    : await findMatchingTarget(browserEndpoint, chatUrl);
  if (!target?.id) {
    return false;
  }
  await closeTarget(browserEndpoint, target.id);
  return true;
}

async function readThreadContentState(client: CdpClient): Promise<ThreadContentState> {
  return await client.evaluate<ThreadContentState>(`(() => ({
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    bodyLength: (document.querySelector('main') ?? document.body)?.innerText?.length ?? 0,
    articleCount: (document.querySelector('main') ?? document).querySelectorAll('article').length,
    messageCount: (document.querySelector('main') ?? document).querySelectorAll('[data-message-author-role]').length,
    attachmentButtonCount: (() => {
      const root = document.querySelector('main') ?? document.body;
      if (!root) return 0;
      const deriveHrefLabel = (href) => {
        if (!href) return '';
        try {
          return decodeURIComponent(new URL(href, location.href).pathname.split('/').filter(Boolean).at(-1) || '');
        } catch {
          return decodeURIComponent(String(href).split('/').filter(Boolean).at(-1) || '');
        }
      };
      const isConversationHref = (href) => {
        if (!href) return false;
        try {
          return /^\\/c\\/[^/]+$/u.test(new URL(href, location.href).pathname);
        } catch {
          return /^\\/?c\\/[^/]+$/u.test(String(href));
        }
      };
      return Array.from(root.querySelectorAll('button, a')).filter((element) => {
        const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
        const href = element.href || '';
        const hrefLabel = deriveHrefLabel(href);
        if (isConversationHref(href)) return false;
        if (element.hasAttribute('download')) return true;
        if (element.classList?.contains('behavior-btn') && /\\b(?:patch|diff)\\b/i.test(text)) return true;
        return (
          /\\.(patch|diff|zip|txt|json|md|patched)\\b/i.test(text) ||
          /\\.(patch|diff|zip|txt|json|md|patched)\\b/i.test(href) ||
          /\\.(patch|diff|zip|txt|json|md|patched)\\b/i.test(hrefLabel) ||
          /\\b(?:patch|diff|archive|zip|file|download|attachment)\\b/i.test(text)
        );
      }).length;
    })(),
  }))()`);
}

function parseContentDispositionFilename(value: string | null | undefined): string | null {
  const raw = normalizeAttachmentValue(value);
  if (raw.length === 0) {
    return null;
  }

  const utf8Match = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1] ?? '');
  }

  const quotedMatch = raw.match(/filename\s*=\s*"([^"]+)"/iu);
  if (quotedMatch) {
    return quotedMatch[1] ?? null;
  }

  const bareMatch = raw.match(/filename\s*=\s*([^;]+)/iu);
  if (bareMatch) {
    return bareMatch[1]?.trim() ?? null;
  }

  return null;
}

function sanitizeDownloadFilename(value: string | null | undefined, fallback = 'downloaded-artifact'): string {
  const raw = normalizeAttachmentValue(value);
  const normalized = raw.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).trim();
  if (basename.length === 0 || basename === '.' || basename === '..') {
    return fallback;
  }
  return basename;
}

async function findAttachmentClickTarget(client: CdpClient, attachmentText: string): Promise<{
  availableButtons?: string[];
  centerX?: number;
  centerY?: number;
  found: boolean;
  href?: string | null;
  hrefLabel?: string;
  text?: string;
}> {
  return await findAttachmentClickTargetWithSelector(client, attachmentText, {});
}

async function findAttachmentClickTargetWithSelector(
  client: CdpClient,
  attachmentText: string,
  selector: ThreadAttachmentDownloadSelector,
): Promise<{
  availableButtons?: string[];
  centerX?: number;
  centerY?: number;
  found: boolean;
  href?: string | null;
  hrefLabel?: string;
  identityError?: string;
  text?: string;
}> {
  const assistantTurnSelectorLiteral = JSON.stringify(CHATGPT_ASSISTANT_TURN_SELECTOR);
  const userTurnSelectorLiteral = JSON.stringify(CHATGPT_USER_TURN_SELECTOR);
  const canonicalizeChatGptTurnNodesSource = canonicalizeChatGptTurnNodes.toString();
  const artifactIndex = Number.isInteger(selector.artifactIndex) && Number(selector.artifactIndex) >= 0
    ? Number(selector.artifactIndex)
    : -1;
  const artifactIndexInAssistantTurn = Number.isInteger(selector.artifactIndexInAssistantTurn) && Number(selector.artifactIndexInAssistantTurn) >= 0
    ? Number(selector.artifactIndexInAssistantTurn)
    : -1;
  const assistantTurnId = String(selector.assistantTurnId ?? '');
  const assistantTurnIndex = Number.isInteger(selector.assistantTurnIndex) && Number(selector.assistantTurnIndex) >= 0
    ? Number(selector.assistantTurnIndex)
    : -1;
  const exactCaptureSelection = Boolean(assistantTurnId) && assistantTurnIndex >= 0 && artifactIndexInAssistantTurn >= 0;
  const expectedHrefSpecified = Object.prototype.hasOwnProperty.call(selector, 'href');
  return await client.evaluate(`(() => {
    const root = document.querySelector('main') ?? document.body;
    const deriveHrefLabel = (href) => {
      if (!href) return '';
      try {
        return decodeURIComponent(new URL(href, location.href).pathname.split('/').filter(Boolean).at(-1) || '');
      } catch {
        return decodeURIComponent(String(href).split('/').filter(Boolean).at(-1) || '');
      }
    };
    const hasDownloadableHref = (href) => {
      if (!href) return false;
      const normalizedHref = String(href).trim();
      if (!normalizedHref) return false;
      if (normalizedHref.startsWith('sandbox:/mnt/data/')) return true;
      try {
        const url = new URL(normalizedHref, location.href);
        return url.protocol === 'blob:' || url.protocol === 'data:';
      } catch {
        return false;
      }
    };
    const assistantTurnSelector = ${assistantTurnSelectorLiteral};
    const userTurnSelector = ${userTurnSelectorLiteral};
    const canonicalizeChatGptTurnNodes = ${canonicalizeChatGptTurnNodesSource};
    const assistantTurnGroups = canonicalizeChatGptTurnNodes(
      Array.from(root.querySelectorAll(assistantTurnSelector)),
    );
    const assistantNodes = assistantTurnGroups.map((group) => group.node);
    const assistantTurnGroupFor = (node) =>
      assistantTurnGroups.find((group) => group.aliases.includes(node)) || null;
    const userNodes = canonicalizeChatGptTurnNodes(
      Array.from(root.querySelectorAll(userTurnSelector)),
    ).map((group) => group.node);
    const lastUserNode = userNodes.at(-1) || null;
    const isAfterLastUserNode = (node) => {
      if (!lastUserNode) return true;
      if (!node || node === lastUserNode || typeof lastUserNode.compareDocumentPosition !== 'function') return false;
      return Boolean(lastUserNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const assistantNodesAfterLastUser = assistantNodes.filter((node) => isAfterLastUserNode(node));
    const assistantNodesAfterLastUserSet = new Set(assistantNodesAfterLastUser);
    const finalAssistantNode = assistantNodesAfterLastUser.at(-1) || (!lastUserNode ? assistantNodes.at(-1) || null : null);
    const turnIdentity = (node, role, index, signature) => {
      for (const attribute of ['data-message-id', 'data-turn-id', 'data-testid', 'id']) {
        const value = String(node?.getAttribute?.(attribute) || '').trim();
        if (value) return attribute + ':' + value;
      }
      return role + ':index:' + index + ':signature:' + signature;
    };
    const sanitizedTurnIdentity = (value) => {
      const raw = String(value || '');
      const marker = ':signature:';
      const markerIndex = raw.indexOf(marker);
      if (markerIndex < 0) return raw;
      let hash = 0x811c9dc5;
      for (const character of raw.slice(markerIndex + marker.length)) {
        hash ^= character.codePointAt(0) || 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return raw.slice(0, markerIndex) + ':hash32:' + hash.toString(16).padStart(8, '0');
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const capturedAssistantNodes = assistantNodes.filter((node, index) => {
      const signature = normalize(node?.innerText || node?.textContent || '').slice(0, 320);
      const liveTurnId = turnIdentity(node, 'assistant', index, signature);
      const idMatches = !${JSON.stringify(assistantTurnId)} || liveTurnId === ${JSON.stringify(assistantTurnId)} || sanitizedTurnIdentity(liveTurnId) === ${JSON.stringify(assistantTurnId)};
      const indexMatches = ${assistantTurnIndex} < 0 || index === ${assistantTurnIndex};
      return idMatches && indexMatches;
    });
    if ((${JSON.stringify(assistantTurnId)} || ${assistantTurnIndex} >= 0) && capturedAssistantNodes.length !== 1) {
      return {
        found: false,
        identityError: 'Captured assistant turn resolved to ' + capturedAssistantNodes.length + ' DOM nodes.',
      };
    }
    const capturedAssistantNode = capturedAssistantNodes[0] || null;
    const controls = Array.from(root.querySelectorAll('button, a'));
    const candidates = controls.filter((element) => {
      const rawAssistantContainer = element.closest(assistantTurnSelector);
      const assistantContainer = assistantTurnGroupFor(rawAssistantContainer)?.node || rawAssistantContainer;
      if (!assistantContainer) return false;
      if (capturedAssistantNode && assistantContainer !== capturedAssistantNode) return false;
      if (!capturedAssistantNode && !assistantNodesAfterLastUserSet.has(assistantContainer)) return false;
      if (!(element.hasAttribute('download') || element.classList?.contains('behavior-btn') || hasDownloadableHref(element.href || ''))) {
        return false;
      }
      if (capturedAssistantNode) return true;
      if (finalAssistantNode && finalAssistantNode.contains(element)) return true;
      return !assistantNodesAfterLastUser.some((node) => node !== assistantContainer && finalAssistantNode && finalAssistantNode.contains(node));
    });
    const matchesAttachment = (element) => {
      const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
      return (
        text === ${JSON.stringify(attachmentText)} ||
        deriveHrefLabel(element.href || '') === ${JSON.stringify(attachmentText)} ||
        (String(element.href || '') && String(element.href || '') === ${JSON.stringify(selector.href ?? '')})
      );
    };
    const exactArtifactIndex = ${artifactIndexInAssistantTurn} >= 0 ? ${artifactIndexInAssistantTurn} : ${artifactIndex};
    const indexedButton = exactArtifactIndex >= 0 ? candidates[exactArtifactIndex] || null : null;
    const exactHrefMatches = (element) =>
      !${expectedHrefSpecified} || String(element?.href || '') === ${JSON.stringify(selector.href ?? '')};
    const exactLabelMatches = (element) => !${JSON.stringify(attachmentText)} || matchesAttachment(element);
    if (${exactCaptureSelection} && indexedButton && (!exactHrefMatches(indexedButton) || !exactLabelMatches(indexedButton))) {
      return {
        found: false,
        identityError: 'Captured assistant artifact index no longer matches its exact href and label identity.',
      };
    }
    const button = ${exactCaptureSelection}
      ? indexedButton && exactHrefMatches(indexedButton) && exactLabelMatches(indexedButton)
        ? indexedButton
        : null
      : indexedButton || candidates.find((element) => matchesAttachment(element)) || null;
    if (!button || typeof button.getBoundingClientRect !== 'function') {
      return {
        found: false,
        availableButtons: candidates
          .map((element, index) => {
            const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
            const hrefLabel = deriveHrefLabel(element.href || '');
            return [index, text || hrefLabel || '(unlabeled)'].join(':');
          })
          .slice(-80),
      };
    }
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    return {
      found: true,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      href: button.href || null,
      hrefLabel: deriveHrefLabel(button.href || ''),
      text: (button.innerText || button.getAttribute('aria-label') || '').trim(),
    };
  })()`);
}

async function clickAttachment(client: CdpClient, attachmentText: string, timeoutMs: number): Promise<{
  availableButtons?: string[];
  found: boolean;
  href?: string | null;
  hrefLabel?: string;
  text?: string;
}> {
  return await clickAttachmentWithSelector(client, attachmentText, timeoutMs, {});
}

async function clickAttachmentWithSelector(
  client: CdpClient,
  attachmentText: string,
  timeoutMs: number,
  selector: ThreadAttachmentDownloadSelector,
): Promise<{
  availableButtons?: string[];
  found: boolean;
  href?: string | null;
  hrefLabel?: string;
  identityError?: string;
  text?: string;
}> {
  const startedAt = Date.now();
  let target = await findAttachmentClickTargetWithSelector(client, attachmentText, selector);
  while (!target.found && !target.identityError && Date.now() - startedAt <= timeoutMs) {
    await sleep(250);
    target = await findAttachmentClickTargetWithSelector(client, attachmentText, selector);
  }
  if (!target.found || target.centerX === undefined || target.centerY === undefined) {
    return target;
  }

  const assistantTurnSelectorLiteral = JSON.stringify(CHATGPT_ASSISTANT_TURN_SELECTOR);
  const userTurnSelectorLiteral = JSON.stringify(CHATGPT_USER_TURN_SELECTOR);
  const canonicalizeChatGptTurnNodesSource = canonicalizeChatGptTurnNodes.toString();
  const artifactIndex = Number.isInteger(selector.artifactIndex) && Number(selector.artifactIndex) >= 0
    ? Number(selector.artifactIndex)
    : -1;
  const artifactIndexInAssistantTurn = Number.isInteger(selector.artifactIndexInAssistantTurn) && Number(selector.artifactIndexInAssistantTurn) >= 0
    ? Number(selector.artifactIndexInAssistantTurn)
    : -1;
  const assistantTurnId = String(selector.assistantTurnId ?? '');
  const assistantTurnIndex = Number.isInteger(selector.assistantTurnIndex) && Number(selector.assistantTurnIndex) >= 0
    ? Number(selector.assistantTurnIndex)
    : -1;
  const exactCaptureSelection = Boolean(assistantTurnId) && assistantTurnIndex >= 0 && artifactIndexInAssistantTurn >= 0;
  const expectedHrefSpecified = Object.prototype.hasOwnProperty.call(selector, 'href');
  const activated = await client.evaluate<boolean>(`(() => {
    const root = document.querySelector('main') ?? document.body;
    const deriveHrefLabel = (href) => {
      if (!href) return '';
      try {
        return decodeURIComponent(new URL(href, location.href).pathname.split('/').filter(Boolean).at(-1) || '');
      } catch {
        return decodeURIComponent(String(href).split('/').filter(Boolean).at(-1) || '');
      }
    };
    const hasDownloadableHref = (href) => {
      if (!href) return false;
      const normalizedHref = String(href).trim();
      if (!normalizedHref) return false;
      if (normalizedHref.startsWith('sandbox:/mnt/data/')) return true;
      try {
        const url = new URL(normalizedHref, location.href);
        return url.protocol === 'blob:' || url.protocol === 'data:';
      } catch {
        return false;
      }
    };
    const assistantTurnSelector = ${assistantTurnSelectorLiteral};
    const userTurnSelector = ${userTurnSelectorLiteral};
    const canonicalizeChatGptTurnNodes = ${canonicalizeChatGptTurnNodesSource};
    const assistantTurnGroups = canonicalizeChatGptTurnNodes(
      Array.from(root.querySelectorAll(assistantTurnSelector)),
    );
    const assistantNodes = assistantTurnGroups.map((group) => group.node);
    const assistantTurnGroupFor = (node) =>
      assistantTurnGroups.find((group) => group.aliases.includes(node)) || null;
    const userNodes = canonicalizeChatGptTurnNodes(
      Array.from(root.querySelectorAll(userTurnSelector)),
    ).map((group) => group.node);
    const lastUserNode = userNodes.at(-1) || null;
    const isAfterLastUserNode = (node) => {
      if (!lastUserNode) return true;
      if (!node || node === lastUserNode || typeof lastUserNode.compareDocumentPosition !== 'function') return false;
      return Boolean(lastUserNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const assistantNodesAfterLastUser = assistantNodes.filter((node) => isAfterLastUserNode(node));
    const assistantNodesAfterLastUserSet = new Set(assistantNodesAfterLastUser);
    const finalAssistantNode = assistantNodesAfterLastUser.at(-1) || (!lastUserNode ? assistantNodes.at(-1) || null : null);
    const turnIdentity = (node, role, index, signature) => {
      for (const attribute of ['data-message-id', 'data-turn-id', 'data-testid', 'id']) {
        const value = String(node?.getAttribute?.(attribute) || '').trim();
        if (value) return attribute + ':' + value;
      }
      return role + ':index:' + index + ':signature:' + signature;
    };
    const sanitizedTurnIdentity = (value) => {
      const raw = String(value || '');
      const marker = ':signature:';
      const markerIndex = raw.indexOf(marker);
      if (markerIndex < 0) return raw;
      let hash = 0x811c9dc5;
      for (const character of raw.slice(markerIndex + marker.length)) {
        hash ^= character.codePointAt(0) || 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return raw.slice(0, markerIndex) + ':hash32:' + hash.toString(16).padStart(8, '0');
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const capturedAssistantNodes = assistantNodes.filter((node, index) => {
      const signature = normalize(node?.innerText || node?.textContent || '').slice(0, 320);
      const liveTurnId = turnIdentity(node, 'assistant', index, signature);
      const idMatches = !${JSON.stringify(assistantTurnId)} || liveTurnId === ${JSON.stringify(assistantTurnId)} || sanitizedTurnIdentity(liveTurnId) === ${JSON.stringify(assistantTurnId)};
      const indexMatches = ${assistantTurnIndex} < 0 || index === ${assistantTurnIndex};
      return idMatches && indexMatches;
    });
    if ((${JSON.stringify(assistantTurnId)} || ${assistantTurnIndex} >= 0) && capturedAssistantNodes.length !== 1) {
      return false;
    }
    const capturedAssistantNode = capturedAssistantNodes[0] || null;
    const dispatchClickSequence = (node) => {
      if (!node || typeof node.dispatchEvent !== 'function') return false;
      const ownerView =
        (node.ownerDocument && node.ownerDocument.defaultView) ||
        (typeof window === 'object' ? window : null);
      if (!ownerView) return false;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const common = { bubbles: true, cancelable: true, view: ownerView };
        let event;
        if (type.startsWith('pointer') && 'PointerEvent' in ownerView) {
          event = new ownerView.PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
        } else {
          event = new ownerView.MouseEvent(type, common);
        }
        node.dispatchEvent(event);
      }
      return true;
    };
    const controls = Array.from(root.querySelectorAll('button, a'));
    const candidates = controls.filter((element) => {
      const rawAssistantContainer = element.closest(assistantTurnSelector);
      const assistantContainer = assistantTurnGroupFor(rawAssistantContainer)?.node || rawAssistantContainer;
      if (!assistantContainer) return false;
      if (capturedAssistantNode && assistantContainer !== capturedAssistantNode) return false;
      if (!capturedAssistantNode && !assistantNodesAfterLastUserSet.has(assistantContainer)) return false;
      if (!(element.hasAttribute('download') || element.classList?.contains('behavior-btn') || hasDownloadableHref(element.href || ''))) {
        return false;
      }
      if (capturedAssistantNode) return true;
      if (finalAssistantNode && finalAssistantNode.contains(element)) return true;
      return !assistantNodesAfterLastUser.some((node) => node !== assistantContainer && finalAssistantNode && finalAssistantNode.contains(node));
    });
    const matchesAttachment = (element) => {
      const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
      return (
        text === ${JSON.stringify(attachmentText)} ||
        deriveHrefLabel(element.href || '') === ${JSON.stringify(attachmentText)} ||
        (String(element.href || '') && String(element.href || '') === ${JSON.stringify(selector.href ?? '')})
      );
    };
    const exactArtifactIndex = ${artifactIndexInAssistantTurn} >= 0 ? ${artifactIndexInAssistantTurn} : ${artifactIndex};
    const indexedNode = exactArtifactIndex >= 0 ? candidates[exactArtifactIndex] || null : null;
    const exactHrefMatches = (element) =>
      !${expectedHrefSpecified} || String(element?.href || '') === ${JSON.stringify(selector.href ?? '')};
    const exactLabelMatches = (element) => !${JSON.stringify(attachmentText)} || matchesAttachment(element);
    const node = ${exactCaptureSelection}
      ? indexedNode && exactHrefMatches(indexedNode) && exactLabelMatches(indexedNode)
        ? indexedNode
        : null
      : indexedNode || candidates.find((element) => matchesAttachment(element)) || null;
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    node.scrollIntoView({ block: 'center' });
    if (typeof node.click === 'function') {
      node.click();
      return true;
    }
    return dispatchClickSequence(node);
  })()`, { awaitPromise: true });
  if (activated) {
    return target;
  }

  if (exactCaptureSelection) {
    const revalidatedTarget = await findAttachmentClickTargetWithSelector(client, attachmentText, selector);
    if (
      !revalidatedTarget.found ||
      revalidatedTarget.centerX === undefined ||
      revalidatedTarget.centerY === undefined
    ) {
      return revalidatedTarget;
    }
    target = revalidatedTarget;
  }

  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.centerX,
    y: target.centerY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.centerX,
    y: target.centerY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.centerX,
    y: target.centerY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return target;
}

async function waitForDownloadedFile(filePath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const size = await fileSize(filePath);
    if (size !== null && size > 0) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        size === 0
          ? `Downloaded file stayed empty after ${timeoutMs}ms: ${filePath}`
          : `Timed out waiting for downloaded file ${filePath}`,
      );
    }
    await sleep(250);
  }
}

export async function verifyDownloadedArtifact(
  downloadedFile: string,
  expectedContentSha256 = '',
): Promise<void> {
  const downloadedStat = await stat(downloadedFile);
  if (!downloadedStat.isFile() || downloadedStat.size <= 0) {
    await removeIfPresent(downloadedFile);
    throw new Error('Attachment download did not produce a non-empty file.');
  }
  if (!expectedContentSha256) return;
  const actualContentSha256 = createHash('sha256')
    .update(await readFile(downloadedFile))
    .digest('hex');
  if (actualContentSha256 !== expectedContentSha256) {
    await removeIfPresent(downloadedFile);
    throw new Error(
      `Downloaded artifact SHA-256 ${actualContentSha256} did not match the assistant-declared SHA-256 ${expectedContentSha256}.`,
    );
  }
}

async function createTargetLease(
  browserEndpoint: string,
  chatUrl: string,
  rehydrated = false,
): Promise<CdpTargetLease> {
  const createdTargetId = await createTarget(browserEndpoint, chatUrl);
  const startedAt = Date.now();
  try {
    for (;;) {
      const target = await findTargetById(browserEndpoint, createdTargetId);
      if (target) {
        return {
          created: true,
          ...(rehydrated ? { rehydrated: true } : {}),
          target,
        };
      }
      if (Date.now() - startedAt > TARGET_READY_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for a browser tab for ${chatUrl}`);
      }
      await sleep(TARGET_READY_POLL_MS);
    }
  } catch (error) {
    try {
      await closeTarget(browserEndpoint, createdTargetId);
    } catch (cleanupError) {
      throw new Error(
        `${normalizeError(error, 'Thread target setup failed.').message} Cleanup also failed: ${normalizeError(cleanupError, 'Unknown cleanup error.').message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function ensureTargetLease(
  browserEndpoint: string,
  chatUrl: string,
  exactTargetId?: string,
  rehydrateMissingExactTarget = false,
): Promise<CdpTargetLease> {
  if (exactTargetId) {
    const targets = await fetchJson<CdpTarget[]>(`${browserEndpoint}/json/list`);
    const exactTargets = targets.filter(
      (target) =>
        target.type === 'page' &&
        target.id === exactTargetId &&
        Boolean(target.webSocketDebuggerUrl) &&
        conversationUrlsReferToSameThread(target.url ?? '', chatUrl),
    );
    if (exactTargets.length === 0 && rehydrateMissingExactTarget) {
      return await createTargetLease(browserEndpoint, chatUrl, true);
    }
    if (exactTargets.length !== 1) {
      throw new Error(
        `Exact captured browser target resolved to ${exactTargets.length} tabs; refusing to navigate, create, or select another target.`,
      );
    }
    return {
      created: false,
      target: exactTargets[0]!,
    };
  }
  const existingTarget = await findMatchingTarget(browserEndpoint, chatUrl);
  if (existingTarget) {
    return {
      created: false,
      target: existingTarget,
    };
  }

  return await createTargetLease(browserEndpoint, chatUrl);
}

export async function ensureTarget(browserEndpoint: string, chatUrl: string): Promise<CdpTarget> {
  return (await ensureTargetLease(browserEndpoint, chatUrl)).target;
}

async function closeTargetLeaseIfRequested(
  browserEndpoint: string,
  lease: CdpTargetLease,
  lifecycle: ThreadTargetLifecycle | undefined,
): Promise<void> {
  if (lifecycle !== 'close-created' || !lease.created) {
    return;
  }
  try {
    await closeTarget(browserEndpoint, lease.target.id ?? '');
  } catch {
    // Best-effort cleanup must not turn a successful export/download into a failed wake.
  }
}

export function threadContentHasMeaningfulSignals(state: Pick<ThreadContentState, 'articleCount' | 'attachmentButtonCount' | 'bodyLength' | 'messageCount'>): boolean {
  return state.bodyLength > 500 || state.articleCount > 0 || state.messageCount > 0 || state.attachmentButtonCount > 0;
}

export function threadContentLooksReady(state: ThreadContentState, chatUrl: string): boolean {
  return conversationUrlsReferToSameThread(state.href, chatUrl) && state.readyState === 'complete' && threadContentHasMeaningfulSignals(state);
}

export async function waitForTargetContent(client: CdpClient, chatUrl: string): Promise<ThreadContentState> {
  const startedAt = Date.now();
  for (;;) {
    const state = await readThreadContentState(client);
    if (threadContentLooksReady(state, chatUrl)) {
      return state;
    }
    if (Date.now() - startedAt > TARGET_READY_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for ChatGPT thread content for ${chatUrl}`);
    }
    await sleep(TARGET_READY_POLL_MS);
  }
}

async function refreshTargetPage(client: CdpClient): Promise<void> {
  await client.send('Page.enable');
  const loadEventPromise = client.waitForEvent((event) => event.method === 'Page.loadEventFired');
  await client.send('Page.reload', {
    ignoreCache: true,
  });
  await loadEventPromise;
}

async function navigateTargetPage(client: CdpClient, chatUrl: string): Promise<void> {
  await client.send('Page.enable');
  const loadEventPromise = client.waitForEvent((event) => event.method === 'Page.loadEventFired');
  await client.send('Page.navigate', {
    url: chatUrl,
  });
  await loadEventPromise;
}

async function ensureThreadPageReady(
  client: CdpClient,
  chatUrl: string,
  options: {
    forceReload?: boolean;
    reloadExistingThread?: boolean;
  } = {},
): Promise<ThreadContentState> {
  const currentState = await readThreadContentState(client);
  if (options.forceReload !== true && threadContentLooksReady(currentState, chatUrl)) {
    return currentState;
  }

  if (conversationUrlsReferToSameThread(currentState.href, chatUrl)) {
    if (options.reloadExistingThread !== false) {
      await refreshTargetPage(client);
    }
  } else {
    await navigateTargetPage(client, chatUrl);
  }

  return await waitForTargetContent(client, chatUrl);
}

async function waitForSettledThreadSnapshot(client: CdpClient): Promise<ThreadSnapshot> {
  const startedAt = Date.now();
  let snapshot = await captureThreadSnapshot(client);
  if (hasThreadPayload(snapshot)) {
    return snapshot;
  }

  while (Date.now() - startedAt <= SNAPSHOT_SETTLE_TIMEOUT_MS) {
    await sleep(SNAPSHOT_SETTLE_POLL_MS);
    snapshot = await captureThreadSnapshot(client);
    if (hasThreadPayload(snapshot)) {
      return snapshot;
    }
  }

  return snapshot;
}

export async function captureThreadSnapshot(client: CdpClient): Promise<ThreadSnapshot> {
  const snapshot = await client.evaluate<Partial<ThreadSnapshot> | null | undefined>(buildCaptureThreadSnapshotExpression());
  return normalizeThreadSnapshot(snapshot);
}

function isDeepResearchIframeTarget(target: CdpTarget, parentTargetId: string): boolean {
  if (target.type !== 'iframe' || target.parentId !== parentTargetId || !target.webSocketDebuggerUrl) {
    return false;
  }
  const metadata = `${target.title ?? ''}\n${target.url ?? ''}`.toLowerCase();
  return (
    metadata.includes('deep research') ||
    metadata.includes('deep-research') ||
    metadata.includes('deep_research') ||
    metadata.includes('connector_openai_deep_research')
  );
}

async function captureDeepResearchReportSnapshots(
  browserEndpoint: string,
  parentTargetId: string,
): Promise<ThreadSnapshot[]> {
  const targets = await fetchJson<CdpTarget[]>(`${browserEndpoint}/json/list`);
  const iframeTargets = targets.filter((target) => isDeepResearchIframeTarget(target, parentTargetId));
  if (iframeTargets.length === 0) {
    throw new Error(
      'Captured Deep Research iframe target resolved to 0 frames; refusing thread export.',
    );
  }

  const snapshots: ThreadSnapshot[] = [];
  for (const iframeTarget of iframeTargets) {
    const iframeClient = new CdpClient(iframeTarget.webSocketDebuggerUrl);
    try {
      await iframeClient.send('Runtime.enable');
      snapshots.push(normalizeThreadSnapshot(
        await iframeClient.evaluate<Partial<ThreadSnapshot> | null | undefined>(
          buildDeepResearchResponseInspectionSource(),
          { awaitPromise: true },
        ),
      ));
    } finally {
      iframeClient.close();
    }
  }
  return snapshots;
}

async function scopeCapturedThreadSnapshot(
  browserEndpoint: string,
  parentTargetId: string,
  pageSnapshot: ThreadSnapshot,
  captureIdentity: ThreadCaptureIdentity | undefined,
): Promise<ThreadSnapshot> {
  const expectsDeepResearch =
    captureIdentity?.expectedContentSource === 'deep-research-iframe' ||
    captureIdentity?.assistantResponse?.contentSource === 'deep-research-iframe';
  if (!captureIdentity || !expectsDeepResearch) {
    return scopeThreadSnapshotToCaptureIdentity(pageSnapshot, captureIdentity);
  }
  if (!parentTargetId) {
    throw new Error('Captured Deep Research parent target is missing its exact browser target identity.');
  }

  const reportSnapshots = await captureDeepResearchReportSnapshots(browserEndpoint, parentTargetId);
  if (reportSnapshots.length === 1) {
    return scopeThreadSnapshotToCaptureIdentity(
      mergeDeepResearchReportSnapshot(pageSnapshot, reportSnapshots[0], captureIdentity),
      captureIdentity,
    );
  }
  if (captureIdentity.assistantResponse?.contentSource !== 'deep-research-iframe') {
    throw new Error(
      `Captured Deep Research iframe target resolved to ${reportSnapshots.length} frames before the report identity was known; refusing ambiguous thread export.`,
    );
  }

  const exactMatches: ThreadSnapshot[] = [];
  for (const reportSnapshot of reportSnapshots) {
    try {
      exactMatches.push(scopeThreadSnapshotToCaptureIdentity(
        mergeDeepResearchReportSnapshot(pageSnapshot, reportSnapshot, captureIdentity),
        captureIdentity,
      ));
    } catch {
      // A stale Deep Research iframe is expected to fail the stored report digest.
    }
  }
  if (exactMatches.length !== 1) {
    throw new Error(
      `Captured Deep Research report identity resolved to ${exactMatches.length} of ${reportSnapshots.length} frames; refusing ambiguous thread export.`,
    );
  }
  return exactMatches[0]!;
}

export function extractPatchAttachmentLabels(snapshot: Partial<ThreadSnapshot> | Pick<ThreadSnapshot, 'attachmentButtons'>): string[] {
  return [
    ...new Set(
      extractAssistantArtifactButtons(snapshot)
        .filter((attachment) => isPatchArtifactAttachment(attachment))
        .map((attachment) => deriveAttachmentLabel(attachment))
        .filter((label) => label.length > 0),
    ),
  ];
}

export function extractAssistantDownloadTargets(snapshot: Partial<ThreadSnapshot> | Pick<ThreadSnapshot, 'attachmentButtons'>): Array<{
  artifactIndex: number;
  artifactIndexInAssistantTurn?: number;
  assistantTurnId?: string;
  assistantTurnIndex?: number;
  href?: string | null;
  label: string;
}> {
  return extractAssistantDownloadButtons(snapshot).map((attachment: ThreadAssistantDownloadButton) => ({
    artifactIndex: attachment.artifactIndex,
    ...(Number.isInteger(attachment.artifactIndexInAssistantTurn)
      ? { artifactIndexInAssistantTurn: attachment.artifactIndexInAssistantTurn }
      : {}),
    ...(attachment.assistantTurnId ? { assistantTurnId: attachment.assistantTurnId } : {}),
    ...(Number.isInteger(attachment.assistantTurnIndex)
      ? { assistantTurnIndex: attachment.assistantTurnIndex }
      : {}),
    href: attachment.href,
    label: attachment.label,
  }));
}

export async function exportThreadSnapshot(
  browserEndpoint: string,
  chatUrl: string,
  outputPath: string,
  options: ExportThreadSnapshotOptions = {},
): Promise<ExportedThreadSnapshot> {
  if (options.captureIdentity) {
    if (options.captureIdentity.browserEndpoint !== browserEndpoint) {
      throw new Error('Capture metadata browser endpoint does not match the requested endpoint.');
    }
    if (!conversationUrlsReferToSameThread(options.captureIdentity.chatUrl, chatUrl)) {
      throw new Error('Capture metadata thread does not match the requested ChatGPT conversation.');
    }
  }
  const targetLease = await ensureTargetLease(
    browserEndpoint,
    chatUrl,
    options.captureIdentity?.targetId,
    Boolean(options.captureIdentity),
  );
  options.onTargetLease?.(targetLease);
  const client = new CdpClient(targetLease.target.webSocketDebuggerUrl);
  let exportSucceeded = false;

  try {
    await client.send('Runtime.enable');
    await ensureThreadPageReady(client, chatUrl, {
      forceReload: options.forceReload,
    });
    const capturedSnapshot = await waitForSettledThreadSnapshot(client);
    const snapshot = await scopeCapturedThreadSnapshot(
      browserEndpoint,
      String(targetLease.target.id ?? ''),
      capturedSnapshot,
      options.captureIdentity,
    );
    const payload: ExportedThreadSnapshot = {
      capturedAt: new Date().toISOString(),
      chatUrl,
      ...snapshot,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(
        payload,
        (key, value) => key === 'deepResearchParentAnchor' ? undefined : value,
        2,
      )}\n`,
    );
    exportSucceeded = true;
    return payload;
  } finally {
    client.close();
    if (!exportSucceeded && targetLease.rehydrated) {
      await closeTarget(browserEndpoint, String(targetLease.target.id ?? ''));
    } else {
      await closeTargetLeaseIfRequested(browserEndpoint, targetLease, options.targetLifecycle);
    }
  }
}

export async function downloadThreadAttachment(
  browserEndpoint: string,
  chatUrl: string,
  attachmentText: string,
  outputDir: string,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  selector: ThreadAttachmentDownloadSelector = {},
  options: {
    captureIdentity?: ThreadCaptureIdentity;
    onTargetLease?: (lease: CdpTargetLease) => void;
    targetLifecycle?: ThreadTargetLifecycle;
  } = {},
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Download timeout must be a positive integer.');
  }
  if (attachmentText.trim().length === 0 && selector.artifactIndex === undefined && normalizeAttachmentValue(selector.href).length === 0) {
    throw new Error('Attachment selection requires --attachment-text, --artifact-index, or a concrete href.');
  }

  await mkdir(outputDir, { recursive: true });
  const filesBeforeDownloadAttempt = await listDownloadDirectoryFiles(outputDir);
  if (options.captureIdentity) {
    if (options.captureIdentity.browserEndpoint !== browserEndpoint) {
      throw new Error('Capture metadata browser endpoint does not match the requested endpoint.');
    }
    if (!conversationUrlsReferToSameThread(options.captureIdentity.chatUrl, chatUrl)) {
      throw new Error('Capture metadata thread does not match the requested ChatGPT conversation.');
    }
  }
  const targetLease = await ensureTargetLease(
    browserEndpoint,
    chatUrl,
    options.captureIdentity?.targetId,
    Boolean(options.captureIdentity),
  );
  options.onTargetLease?.(targetLease);
  const client = new CdpClient(targetLease.target.webSocketDebuggerUrl);
  let downloadSucceeded = false;
  let captureValidated = !options.captureIdentity?.assistantResponse;
  let expectedContentSha256 = '';

  const completeVerifiedDownload = async (downloadedFile: string): Promise<string> => {
    await verifyDownloadedArtifact(downloadedFile, expectedContentSha256);
    downloadSucceeded = true;
    return downloadedFile;
  };

  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Network.enable');
    await ensureThreadPageReady(client, chatUrl, {
      reloadExistingThread: false,
    });
    let effectiveAttachmentText = attachmentText;
    let effectiveSelector = selector;
    if (options.captureIdentity?.assistantResponse) {
      if (!Number.isInteger(selector.artifactIndex) || Number(selector.artifactIndex) < 0) {
        throw new Error('Exact capture metadata requires an artifact index before download activation.');
      }
      const capturedArtifact = options.captureIdentity.artifacts[Number(selector.artifactIndex)];
      if (!capturedArtifact) {
        throw new Error('Requested artifact index is not present in the exact waited capture metadata.');
      }
      expectedContentSha256 = capturedArtifact.contentSha256 ?? '';
      const exactSnapshot = await scopeCapturedThreadSnapshot(
        browserEndpoint,
        String(targetLease.target.id ?? ''),
        await waitForSettledThreadSnapshot(client),
        options.captureIdentity,
      );
      captureValidated = true;
      const liveArtifact = exactSnapshot.attachmentButtons[Number(selector.artifactIndex)];
      if (!liveArtifact) {
        throw new Error('Requested artifact index did not resolve after exact capture validation.');
      }
      effectiveAttachmentText = deriveAttachmentLabel(liveArtifact);
      effectiveSelector = {
        artifactIndex: selector.artifactIndex,
        artifactIndexInAssistantTurn: liveArtifact.artifactIndexInAssistantTurn,
        assistantTurnId: liveArtifact.assistantTurnId,
        assistantTurnIndex: liveArtifact.assistantTurnIndex,
        href: liveArtifact.href,
      };
    }
    // Keep the existing hydrated thread tab alive for attachment clicks. Reloading here
    // can leave behavior buttons visible before ChatGPT rebinds their click handlers.
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(outputDir),
    });

    const downloadStartPromise = client.waitForEvent(
      (event) =>
        event.method === 'Page.downloadWillBegin' &&
        String(event.params?.suggestedFilename ?? '').length > 0,
      timeoutMs,
    ).then((event) => ({ event, kind: 'native-download' as const }));

    const estuaryResponsePromise = client.waitForEvent(
      (event) => {
        const response = getNetworkResponse(event);
        return (
          event.method === 'Network.responseReceived' &&
          String(response.url ?? '').includes('/backend-api/estuary/content') &&
          Number(response.status ?? 0) >= 200 &&
          Number(response.status ?? 0) < 300
        );
      },
      timeoutMs,
    ).then((event) => ({ event, kind: 'estuary-response' as const }));
    // Either signal may win the download race. Observe the unused wait as well
    // so bounded socket shutdown cannot surface it as an unhandled rejection.
    void downloadStartPromise.catch(() => {});
    void estuaryResponsePromise.catch(() => {});

    try {
      const clicked = await clickAttachmentWithSelector(client, effectiveAttachmentText, timeoutMs, effectiveSelector);
      if (!clicked.found) {
        throw new Error(
          clicked.identityError ??
          `Attachment button not found for ${effectiveAttachmentText || `artifact #${effectiveSelector.artifactIndex ?? '?'}`}. Available buttons: ${(clicked.availableButtons ?? []).join(' | ')}`,
        );
      }

      const persistFetchedArtifact = async (artifactSignal: { event: CdpEvent; kind: 'estuary-response' }): Promise<string> => {
        const fetchedArtifact = await client.evaluate<{
          base64: string;
          contentDisposition: string | null;
          contentType: string | null;
          ok: boolean;
          status: number;
        }>(`(async () => {
      const response = await fetch(${JSON.stringify(String(getNetworkResponse(artifactSignal.event).url ?? ''))}, {
        credentials: 'include',
      });
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return {
        base64: btoa(binary),
        contentDisposition: response.headers.get('content-disposition'),
        contentType: response.headers.get('content-type'),
        ok: response.ok,
        status: response.status,
      };
    })()`, { awaitPromise: true });

        if (!fetchedArtifact.ok) {
          throw new Error(`Attachment fetch failed for ${effectiveAttachmentText} with status ${fetchedArtifact.status}.`);
        }

        const fallbackHeaderFilename =
          parseContentDispositionFilename(fetchedArtifact.contentDisposition) ??
          parseContentDispositionFilename(
            String(
              getNetworkResponse(artifactSignal.event).headers?.['content-disposition'] ??
              getNetworkResponse(artifactSignal.event).headers?.['Content-Disposition'] ??
              '',
            ),
          );
        const downloadedFile = path.join(
          path.resolve(outputDir),
          sanitizeDownloadFilename(fallbackHeaderFilename ?? clicked.hrefLabel ?? clicked.text ?? effectiveAttachmentText),
        );
        await removeIfPresent(downloadedFile);
        await writeFile(downloadedFile, Buffer.from(fetchedArtifact.base64, 'base64'));
        return downloadedFile;
      };

      const tryFetchArtifactFallback = async (): Promise<string | null> => {
        try {
          const fallbackArtifactSignal = await Promise.race([
            estuaryResponsePromise,
            sleep(Math.min(timeoutMs, LATE_NATIVE_DOWNLOAD_GRACE_MS)).then(() => null),
          ]);
          if (fallbackArtifactSignal?.kind === 'estuary-response') {
            return await persistFetchedArtifact(fallbackArtifactSignal);
          }
        } catch {
          // Preserve the original native-download error when no fetch fallback is available.
        }

        return null;
      };

      const completeNativeDownload = async (downloadStart: CdpEvent): Promise<string> => {
        const suggestedFilename = sanitizeDownloadFilename(
          String(downloadStart.params?.suggestedFilename ?? ''),
          sanitizeDownloadFilename(effectiveAttachmentText),
        );
        const guid = String(downloadStart.params?.guid ?? '');
        const downloadedFile = path.join(path.resolve(outputDir), suggestedFilename);

        await removeIfPresent(`${downloadedFile}.crdownload`);
        await client.waitForEvent(
          (event) =>
            event.method === 'Page.downloadProgress' &&
            String(event.params?.guid ?? '') === guid &&
            String(event.params?.state ?? '') === 'completed',
          timeoutMs,
        );
        try {
          await waitForDownloadedFile(downloadedFile, timeoutMs);
        } catch (error) {
          const fallbackDownloadedFile = await tryFetchArtifactFallback();
          if (fallbackDownloadedFile) {
            return fallbackDownloadedFile;
          }
          throw error;
        }
        return downloadedFile;
      };

      const earlySignal = await Promise.race([
        downloadStartPromise,
        sleep(Math.min(timeoutMs, NATIVE_DOWNLOAD_GRACE_MS)).then(() => ({ kind: 'native-download-timeout' as const })),
      ]);
      if (earlySignal.kind === 'native-download') {
        const downloadedFile = await completeNativeDownload(earlySignal.event);
        return await completeVerifiedDownload(downloadedFile);
      }

      const fallbackSignal = await Promise.race([
        downloadStartPromise,
        estuaryResponsePromise,
        sleep(Math.min(timeoutMs, LATE_NATIVE_DOWNLOAD_GRACE_MS)).then(() => ({ kind: 'late-native-timeout' as const })),
      ]);
      if (fallbackSignal.kind === 'native-download') {
        const downloadedFile = await completeNativeDownload(fallbackSignal.event);
        return await completeVerifiedDownload(downloadedFile);
      }

      const artifactSignal =
        fallbackSignal.kind === 'estuary-response'
          ? fallbackSignal
          : await Promise.race([downloadStartPromise, estuaryResponsePromise]);

      if (artifactSignal.kind === 'native-download') {
        const downloadedFile = await completeNativeDownload(artifactSignal.event);
        return await completeVerifiedDownload(downloadedFile);
      }
      const downloadedFile = await persistFetchedArtifact(artifactSignal);
      return await completeVerifiedDownload(downloadedFile);
    } catch (error) {
      await removeEmptyDownloadFilesCreatedSince(outputDir, filesBeforeDownloadAttempt);
      throw error;
    }
  } finally {
    client.close();
    if (!downloadSucceeded && targetLease.rehydrated && !captureValidated) {
      await closeTarget(browserEndpoint, String(targetLease.target.id ?? ''));
    } else {
      await closeTargetLeaseIfRequested(browserEndpoint, targetLease, options.targetLifecycle);
    }
  }
}
