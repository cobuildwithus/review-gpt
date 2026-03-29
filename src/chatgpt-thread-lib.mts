import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BROWSER_ENDPOINT = 'http://127.0.0.1:9222';
const TARGET_READY_TIMEOUT_MS = 30_000;
const TARGET_READY_POLL_MS = 750;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const SNAPSHOT_SETTLE_TIMEOUT_MS = 20_000;
const SNAPSHOT_SETTLE_POLL_MS = 500;

type CdpPending = {
  reject: (error?: unknown) => void;
  resolve: (value: unknown) => void;
};

type CdpEvaluateOptions = {
  awaitPromise?: boolean;
  returnByValue?: boolean;
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

export type ThreadAttachmentButton = {
  href: string | null;
  tag: string;
  text: string;
};

export type ThreadSnapshot = {
  attachmentButtons: ThreadAttachmentButton[];
  bodyText: string;
  codeBlocks: string[];
  href: string;
  patchMarkers: {
    addFile: boolean;
    beginPatch: boolean;
    deleteFile: boolean;
    diffGit: boolean;
    updateFile: boolean;
  };
  title: string;
};

export type ExportedThreadSnapshot = ThreadSnapshot & {
  capturedAt: string;
  chatUrl: string;
};

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
  const matches = targets.filter((target) => target.type === 'page' && target.url === chatUrl);
  return matches.at(-1) ?? null;
}

async function clickAttachment(client: CdpClient, attachmentText: string): Promise<{ availableButtons?: string[]; found: boolean; text?: string }> {
  return await client.evaluate(`(() => {
    const controls = Array.from(document.querySelectorAll('button, a'));
    const getLabel = (element) => (element.innerText || element.getAttribute('aria-label') || '').trim();
    const button = controls.find((element) => getLabel(element) === ${JSON.stringify(attachmentText)});
    if (!button) {
      return {
        found: false,
        availableButtons: controls
          .map((element) => getLabel(element))
          .filter(Boolean)
          .slice(-80),
      };
    }
    button.scrollIntoView({ block: 'center' });
    button.click();
    return { found: true, text: button.innerText.trim() };
  })()`);
}

function hasThreadPayload(snapshot: ThreadSnapshot): boolean {
  if (snapshot.patchMarkers.beginPatch || snapshot.patchMarkers.diffGit || snapshot.patchMarkers.addFile || snapshot.patchMarkers.updateFile || snapshot.patchMarkers.deleteFile) {
    return true;
  }

  return snapshot.attachmentButtons.some((attachment) => {
    const label = attachment.text.trim();
    return label.length > 0 && !/^Add files and more$/iu.test(label);
  });
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

export async function waitForTargetContent(client: CdpClient, chatUrl: string): Promise<{
  articleCount: number;
  attachmentButtonCount: number;
  bodyLength: number;
  href: string;
  messageCount: number;
  readyState: string;
  title: string;
}> {
  const startedAt = Date.now();
  for (;;) {
    const state = await client.evaluate<{
      articleCount: number;
      attachmentButtonCount: number;
      bodyLength: number;
      href: string;
      messageCount: number;
      readyState: string;
      title: string;
    }>(`(() => ({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyLength: document.body?.innerText?.length ?? 0,
      articleCount: document.querySelectorAll('article').length,
      messageCount: document.querySelectorAll('[data-message-author-role]').length,
      attachmentButtonCount: Array.from(document.querySelectorAll('button')).filter((element) => /\\.(patch|diff|zip|txt|json|md)\\b/i.test((element.innerText || element.getAttribute('aria-label') || '').trim())).length,
    }))()`);
    if (
      state.href === chatUrl &&
      state.readyState === 'complete' &&
      (
        state.title !== 'ChatGPT' ||
        state.bodyLength > 500 ||
        state.articleCount > 0 ||
        state.messageCount > 0 ||
        state.attachmentButtonCount > 0
      )
    ) {
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
  await client.send('Page.reload', {
    ignoreCache: true,
  });
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
  return await client.evaluate(`(() => {
    const bodyText = document.body?.innerText ?? '';
    const filePattern = /\\.(patch|diff|zip|txt|json|md)\\b/i;
    const keywordPattern = /patch|diff|archive|zip|file/i;
    const attachments = Array.from(document.querySelectorAll('button, a'))
      .map((element) => ({
        tag: element.tagName,
        text: (element.innerText || element.getAttribute('aria-label') || '').trim(),
        href: element.href || null,
      }))
      .filter((item) => filePattern.test(item.text) || filePattern.test(item.href || '') || keywordPattern.test(item.text));

    const codeBlocks = Array.from(document.querySelectorAll('pre'))
      .map((element) => element.innerText)
      .filter(Boolean);

    return {
      href: location.href,
      title: document.title,
      patchMarkers: {
        beginPatch: bodyText.includes('*** Begin Patch'),
        diffGit: bodyText.includes('diff --git'),
        addFile: bodyText.includes('*** Add File:'),
        updateFile: bodyText.includes('*** Update File:'),
        deleteFile: bodyText.includes('*** Delete File:'),
      },
      attachmentButtons: attachments,
      codeBlocks,
      bodyText,
    };
  })()`);
}

export function extractPatchAttachmentLabels(snapshot: Pick<ThreadSnapshot, 'attachmentButtons'>): string[] {
  return [
    ...new Set(
      (snapshot.attachmentButtons ?? [])
        .filter((attachment) => {
          const label = attachment.text.trim();
          const href = attachment.href ?? '';
          return (
            /\.(patch|diff)\b/iu.test(label) ||
            /\.(patch|diff)\b/iu.test(href) ||
            /\bpatch\b/iu.test(label) ||
            /\bdiff\b/iu.test(label)
          );
        })
        .map((attachment) => attachment.text),
    ),
  ];
}

export async function exportThreadSnapshot(browserEndpoint: string, chatUrl: string, outputPath: string): Promise<ExportedThreadSnapshot> {
  const target = await ensureTarget(browserEndpoint, chatUrl);
  const client = new CdpClient(target.webSocketDebuggerUrl);

  try {
    await client.send('Runtime.enable');
    await refreshTargetPage(client);
    await waitForTargetContent(client, chatUrl);
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
    await refreshTargetPage(client);
    await waitForTargetContent(client, chatUrl);
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(outputDir),
    });

    const downloadStartPromise = client.waitForEvent(
      (event) =>
        event.method === 'Page.downloadWillBegin' &&
        String(event.params?.suggestedFilename ?? '').length > 0,
      timeoutMs,
    );

    const clickedStartedAt = Date.now();
    let clicked = await clickAttachment(client, attachmentText);
    while (!clicked.found && Date.now() - clickedStartedAt <= timeoutMs) {
      await sleep(250);
      clicked = await clickAttachment(client, attachmentText);
    }
    if (!clicked.found) {
      throw new Error(
        `Attachment button not found for ${attachmentText}. Available buttons: ${(clicked.availableButtons ?? []).join(' | ')}`,
      );
    }

    const downloadStart = await downloadStartPromise;
    const suggestedFilename = String(downloadStart.params?.suggestedFilename ?? '');
    const guid = String(downloadStart.params?.guid ?? '');
    const downloadedFile = path.join(path.resolve(outputDir), suggestedFilename);

    await removeIfPresent(downloadedFile);
    await removeIfPresent(`${downloadedFile}.crdownload`);

    await client.waitForEvent(
      (event) =>
        event.method === 'Page.downloadProgress' &&
        String(event.params?.guid ?? '') === guid &&
        String(event.params?.state ?? '') === 'completed',
      timeoutMs,
    );
    await waitForDownloadedFile(downloadedFile, timeoutMs);
    return downloadedFile;
  } finally {
    client.close();
  }
}
