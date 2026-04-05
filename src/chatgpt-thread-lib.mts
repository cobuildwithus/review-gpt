import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildCaptureThreadSnapshotExpression,
  deriveAttachmentLabel,
  hasThreadPayload,
  isPatchArtifactAttachment,
  isThreadAttachmentCandidate,
  normalizeThreadSnapshot,
  normalizeAttachmentValue,
  type ExportedThreadSnapshot,
  type ThreadSnapshot,
} from './chatgpt-thread-snapshot-lib.mjs';
export {
  assistantSnapshotLooksIncomplete,
  hasThreadPayload,
  normalizeThreadSnapshot,
  snapshotBusyReason,
  snapshotHasPatchArtifacts,
  snapshotIndicatesBusy,
  threadStatusTextIndicatesBusy,
} from './chatgpt-thread-snapshot-lib.mjs';
export type {
  ExportedThreadSnapshot,
  ThreadAssistantSnapshot,
  ThreadAttachmentButton,
  ThreadSnapshot,
} from './chatgpt-thread-snapshot-lib.mjs';

export const DEFAULT_BROWSER_ENDPOINT = 'http://127.0.0.1:9222';
const TARGET_READY_TIMEOUT_MS = 60_000;
const TARGET_READY_POLL_MS = 750;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const NATIVE_DOWNLOAD_GRACE_MS = 1_500;
const LATE_NATIVE_DOWNLOAD_GRACE_MS = 1_000;
const SNAPSHOT_SETTLE_TIMEOUT_MS = 20_000;
const SNAPSHOT_SETTLE_POLL_MS = 500;

export type ExportThreadSnapshotOptions = {
  forceReload?: boolean;
};

type CdpPending = {
  reject: (error?: unknown) => void;
  resolve: (value: unknown) => void;
};

type CdpEvaluateOptions = {
  awaitPromise?: boolean;
  returnByValue?: boolean;
};

type CdpNetworkResponse = {
  headers?: Record<string, string | undefined>;
  status?: number;
  url?: string;
};

export type CdpEvent = {
  method?: string;
  params?: Record<string, unknown>;
};

export type CdpTarget = {
  type?: string;
  url?: string;
  webSocketDebuggerUrl: string;
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

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

export class CdpClient {
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();

  private nextId = 1;

  private readonly pending = new Map<number, CdpPending>();

  readonly ready: Promise<void>;

  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP socket failed to open.')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data)) as {
        error?: unknown;
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
      };

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

  close(): void {
    this.ws.close();
  }

  async evaluate<T>(expression: string, options: CdpEvaluateOptions = {}): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      awaitPromise: options.awaitPromise ?? false,
      expression,
      returnByValue: options.returnByValue ?? true,
    })) as {
      result?: {
        value?: T;
      };
    };
    return result.result?.value as T;
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
      });
    });
  }

  waitForEvent(predicate: (event: CdpEvent) => boolean, timeoutMs = TARGET_READY_TIMEOUT_MS): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.eventListeners.delete(handleEvent);
        reject(new Error(`Timed out waiting for matching CDP event after ${timeoutMs}ms`));
      }, timeoutMs);

      const handleEvent = (event: CdpEvent) => {
        if (!predicate(event)) {
          return;
        }
        clearTimeout(timeoutId);
        this.eventListeners.delete(handleEvent);
        resolve(event);
      };

      this.eventListeners.add(handleEvent);
    });
  }
}

async function createTarget(browserEndpoint: string, chatUrl: string): Promise<void> {
  const version = await fetchJson<{ webSocketDebuggerUrl: string }>(`${browserEndpoint}/json/version`);
  const browser = new CdpClient(version.webSocketDebuggerUrl);
  try {
    await browser.send('Target.createTarget', { url: chatUrl });
  } finally {
    browser.close();
  }
}

async function findMatchingTarget(browserEndpoint: string, chatUrl: string): Promise<CdpTarget | null> {
  const targets = await fetchJson<CdpTarget[]>(`${browserEndpoint}/json/list`);
  return pickBestThreadTarget(targets, chatUrl);
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
    const controls = Array.from(root.querySelectorAll('button, a'));
    const button = controls.find((element) => {
      const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
      return text === ${JSON.stringify(attachmentText)} || deriveHrefLabel(element.href || '') === ${JSON.stringify(attachmentText)};
    });
    if (!button || typeof button.getBoundingClientRect !== 'function') {
      return {
        found: false,
        availableButtons: controls
          .map((element) => (element.innerText || element.getAttribute('aria-label') || '').trim())
          .filter(Boolean)
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
  const startedAt = Date.now();
  let target = await findAttachmentClickTarget(client, attachmentText);
  while (!target.found && Date.now() - startedAt <= timeoutMs) {
    await sleep(250);
    target = await findAttachmentClickTarget(client, attachmentText);
  }
  if (!target.found || target.centerX === undefined || target.centerY === undefined) {
    return target;
  }

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
    const node = Array.from(root.querySelectorAll('button, a')).find((element) => {
      const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
      return text === ${JSON.stringify(attachmentText)} || deriveHrefLabel(element.href || '') === ${JSON.stringify(attachmentText)};
    });
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    node.scrollIntoView({ block: 'center' });
    dispatchClickSequence(node);
    if (typeof node.click === 'function') {
      node.click();
      return true;
    }
    return true;
  })()`, { awaitPromise: true });
  if (activated) {
    return target;
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
    if (await exists(filePath)) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for downloaded file ${filePath}`);
    }
    await sleep(250);
  }
}

export async function ensureTarget(browserEndpoint: string, chatUrl: string): Promise<CdpTarget> {
  const existingTarget = await findMatchingTarget(browserEndpoint, chatUrl);
  if (existingTarget) {
    return existingTarget;
  }

  await createTarget(browserEndpoint, chatUrl);
  const startedAt = Date.now();
  for (;;) {
    const target = await findMatchingTarget(browserEndpoint, chatUrl);
    if (target) {
      return target;
    }
    if (Date.now() - startedAt > TARGET_READY_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for a browser tab for ${chatUrl}`);
    }
    await sleep(TARGET_READY_POLL_MS);
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

export function extractPatchAttachmentLabels(snapshot: Pick<ThreadSnapshot, 'attachmentButtons'>): string[] {
  const attachments = (snapshot.attachmentButtons ?? []).filter((attachment) => isThreadAttachmentCandidate(attachment));
  const assistantAttachments = attachments.filter((attachment) => attachment.insideAssistantMessage);
  const finalAssistantAttachments = attachments.filter((attachment) => attachment.insideFinalAssistantMessage);
  const scopedAttachments = finalAssistantAttachments.length > 0
    ? finalAssistantAttachments
    : assistantAttachments.length > 0
      ? assistantAttachments
      : attachments;

  return [
    ...new Set(
      scopedAttachments
        .filter((attachment) => isPatchArtifactAttachment(attachment))
        .map((attachment) => deriveAttachmentLabel(attachment))
        .filter((label) => label.length > 0),
    ),
  ];
}

export async function exportThreadSnapshot(
  browserEndpoint: string,
  chatUrl: string,
  outputPath: string,
  options: ExportThreadSnapshotOptions = {},
): Promise<ExportedThreadSnapshot> {
  const target = await ensureTarget(browserEndpoint, chatUrl);
  const client = new CdpClient(target.webSocketDebuggerUrl);

  try {
    await client.send('Runtime.enable');
    await ensureThreadPageReady(client, chatUrl, {
      forceReload: options.forceReload,
    });
    const snapshot = await waitForSettledThreadSnapshot(client);
    const payload: ExportedThreadSnapshot = {
      capturedAt: new Date().toISOString(),
      chatUrl,
      ...snapshot,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  } finally {
    client.close();
  }
}

export async function downloadThreadAttachment(
  browserEndpoint: string,
  chatUrl: string,
  attachmentText: string,
  outputDir: string,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Download timeout must be a positive integer.');
  }

  await mkdir(outputDir, { recursive: true });
  const target = await ensureTarget(browserEndpoint, chatUrl);
  const client = new CdpClient(target.webSocketDebuggerUrl);

  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Network.enable');
    await ensureThreadPageReady(client, chatUrl, {
      reloadExistingThread: false,
    });
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

    const clicked = await clickAttachment(client, attachmentText, timeoutMs);
    if (!clicked.found) {
      throw new Error(
        `Attachment button not found for ${attachmentText}. Available buttons: ${(clicked.availableButtons ?? []).join(' | ')}`,
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
        throw new Error(`Attachment fetch failed for ${attachmentText} with status ${fetchedArtifact.status}.`);
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
        sanitizeDownloadFilename(fallbackHeaderFilename ?? clicked.hrefLabel ?? clicked.text ?? attachmentText),
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
        sanitizeDownloadFilename(attachmentText),
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
      return await completeNativeDownload(earlySignal.event);
    }

    const fallbackSignal = await Promise.race([
      downloadStartPromise,
      estuaryResponsePromise,
      sleep(Math.min(timeoutMs, LATE_NATIVE_DOWNLOAD_GRACE_MS)).then(() => ({ kind: 'late-native-timeout' as const })),
    ]);
    if (fallbackSignal.kind === 'native-download') {
      return await completeNativeDownload(fallbackSignal.event);
    }

    const artifactSignal =
      fallbackSignal.kind === 'estuary-response'
        ? fallbackSignal
        : await Promise.race([downloadStartPromise, estuaryResponsePromise]);

    if (artifactSignal.kind === 'native-download') {
      return await completeNativeDownload(artifactSignal.event);
    }
    return await persistFetchedArtifact(artifactSignal);
  } finally {
    client.close();
  }
}
