import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const distThreadLib = new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url);
const distThreadDiagnosticsLib = new URL('../dist/chatgpt-thread-diagnostics-lib.mjs', import.meta.url);

class FakeWebSocket {
  static instances = [];

  listeners = new Map();

  sent = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({
      listener,
      once: options.once === true,
    });
    this.listeners.set(type, listeners);
  }

  close() {
    this.emit('close', {});
  }

  emit(type, event = {}) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const entry of listeners) {
      entry.listener(event);
      if (entry.once) {
        const remaining = (this.listeners.get(type) ?? []).filter((candidate) => candidate !== entry);
        this.listeners.set(type, remaining);
      }
    }
  }

  send(payload) {
    this.sent.push(payload);
  }
}

function installFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances.length = 0;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
    FakeWebSocket.instances.length = 0;
  });
}

async function waitForTestCondition(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for test condition.');
}

test('CdpClient rejects pending commands when the websocket closes mid-flight', async (t) => {
  installFakeWebSocket(t);

  const { CdpClient } = await import(distThreadLib);
  const client = new CdpClient('ws://example.invalid/devtools/page/1');
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit('open');

  const pending = client.send('Runtime.enable');
  socket.emit('close');

  await assert.rejects(pending, /CDP socket closed unexpectedly|CDP client closed/u);
});

test('CdpClient rejects event waits when the websocket closes', async (t) => {
  installFakeWebSocket(t);

  const { CdpClient } = await import(distThreadLib);
  const client = new CdpClient('ws://example.invalid/devtools/page/2');
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit('open');

  const pending = client.waitForEvent(() => false, 10_000);
  socket.emit('close');

  await assert.rejects(pending, /CDP socket closed unexpectedly|CDP client closed/u);
});

test('fetchJson aborts browser endpoint probes that overrun their timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { fetchJson } = await import(distThreadLib);
  await assert.rejects(
    () => fetchJson('http://127.0.0.1:9222/json/list', { timeoutMs: 5 }),
    /Timed out fetching http:\/\/127\.0\.0\.1:9222\/json\/list after 5ms/u,
  );
});

test('target leases record created tabs and close them when requested', async (t) => {
  installFakeWebSocket(t);
  const originalFetch = globalThis.fetch;
  let created = false;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/json/version')) {
      return new Response(
        JSON.stringify({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
        }),
        { status: 200 },
      );
    }
    if (value.endsWith('/json/list')) {
      return new Response(
        JSON.stringify(
          created
            ? [
                {
                  id: 'created-target',
                  type: 'page',
                  url: 'https://chatgpt.com/c/example-thread',
                  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/created-target',
                },
              ]
            : [],
        ),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { closeTarget, ensureTargetLease } = await import(distThreadLib);
  const leasePromise = ensureTargetLease(
    'http://127.0.0.1:9222',
    'https://chatgpt.com/c/example-thread',
  );

  await waitForTestCondition(() => FakeWebSocket.instances.length === 1);
  const createSocket = FakeWebSocket.instances[0];
  createSocket.emit('open');
  await waitForTestCondition(() => createSocket.sent.length === 1);
  const createCommand = JSON.parse(createSocket.sent[0]);
  assert.equal(createCommand.method, 'Target.createTarget');
  assert.equal(createCommand.params.background, true);
  created = true;
  createSocket.emit('message', {
    data: JSON.stringify({
      id: createCommand.id,
      result: {
        targetId: 'created-target',
      },
    }),
  });

  const lease = await leasePromise;
  assert.equal(lease.created, true);
  assert.equal(lease.target.id, 'created-target');

  const closePromise = closeTarget('http://127.0.0.1:9222', lease.target.id);
  await waitForTestCondition(() => FakeWebSocket.instances.length === 2);
  const closeSocket = FakeWebSocket.instances[1];
  closeSocket.emit('open');
  await waitForTestCondition(() => closeSocket.sent.length === 1);
  const closeCommand = JSON.parse(closeSocket.sent[0]);
  assert.equal(closeCommand.method, 'Target.closeTarget');
  assert.equal(closeCommand.params.targetId, 'created-target');
  closeSocket.emit('message', {
    data: JSON.stringify({
      id: closeCommand.id,
      result: {
        success: true,
      },
    }),
  });
  await closePromise;
});

test('collectThreadDiagnostics captures duplicate matching tabs and a sanitized receipt copy', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-gpt-diagnostics-'));
  const logFilePath = path.join(root, 'send.log');
  const receiptPath = path.join(root, 'receipt.json');
  const outputDir = path.join(root, 'diagnostics');
  writeFileSync(logFilePath, 'failing log\n', 'utf8');
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        nextWakeStatus: 'skipped',
        requestedDepth: 2,
        reviewDiagnosticsStatus: 'captured',
        reviewSendStatus: 'failed',
      },
      null,
      2,
    ),
    'utf8',
  );
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const { collectThreadDiagnostics } = await import(distThreadDiagnosticsLib);
  const result = await collectThreadDiagnostics(
    {
      chatUrl: 'https://chatgpt.com/c/69e0ada0-4a44-839a-819a-71c374d067fc',
      commandLabel: 'review:gpt',
      cwd: root,
      exitCode: 1,
      logFilePath,
      outputDir,
      receiptPath,
    },
    {
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, targetPath) => {
        writeFileSync(
          targetPath,
          JSON.stringify(
            {
              chatUrl: 'https://chatgpt.com/c/69e0ada0-4a44-839a-819a-71c374d067fc',
              statusTexts: ['Done'],
            },
            null,
            2,
          ),
          'utf8',
        );
      },
      fetchJson: async (url) => {
        if (String(url).endsWith('/json/version')) {
          return {
            Browser: 'Chromium',
            'Protocol-Version': '1.3',
            'User-Agent': 'Fake Browser',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
          };
        }
        return [
          {
            id: 'page-1',
            title: 'ChatGPT',
            type: 'page',
            url: 'https://chatgpt.com/c/69e0ada0-4a44-839a-819a-71c374d067fc',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
          },
          {
            id: 'page-2',
            title: 'Strava Integration Review',
            type: 'page',
            url: 'https://chatgpt.com/c/69e0ada0-4a44-839a-819a-71c374d067fc',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2',
          },
        ];
      },
    },
  );

  assert.equal(result.outputDir, outputDir);
  const status = JSON.parse(readFileSync(result.statusPath, 'utf8'));
  assert.equal(status.browser.matchingThreadTargetCount, 2);
  assert.equal(status.browser.preferredTargetId, 'page-2');
  assert.equal(status.receipt.reviewDiagnosticsStatus, 'captured');
  assert.equal(status.receipt.reviewSendStatus, 'failed');
  assert.equal(status.export.status, 'succeeded');
  assert.equal(readFileSync(path.join(outputDir, 'command.log'), 'utf8'), 'failing log\n');
});
