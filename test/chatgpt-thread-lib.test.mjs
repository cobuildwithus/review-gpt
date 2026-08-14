import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const distThreadLib = new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url);
const distThreadDiagnosticsLib = new URL('../dist/chatgpt-thread-diagnostics-lib.mjs', import.meta.url);
const distWakeLib = new URL('../dist/chatgpt-thread-wake-lib.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const {
  buildThreadCaptureIdentity,
  mergeResponseCaptureStates,
  selectAssistantResponseCandidate,
} = require('../src/prepare-chatgpt-draft.js');

class FakeWebSocket {
  static autoOpen = false;

  static instances = [];

  static onSend = null;

  listeners = new Map();

  sent = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.emit('open'));
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
    FakeWebSocket.onSend?.(this, JSON.parse(payload));
  }
}

function installFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.autoOpen = false;
  FakeWebSocket.onSend = null;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.autoOpen = false;
    FakeWebSocket.onSend = null;
  });
}

function respondToCdpCommand(socket, command, result) {
  queueMicrotask(() => {
    socket.emit('message', {
      data: JSON.stringify({ id: command.id, result }),
    });
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

test('capture identity scopes replacement responses and artifacts instead of rediscovering an older branch', async () => {
  const { scopeThreadSnapshotToCaptureIdentity } = await import(distThreadLib);
  const responseText = 'Replacement patch ready.';
  const assistantIdentity = {
    assistantTurnId: 'data-message-id:assistant-new',
    assistantTurnIndex: 3,
    precedingUserMessageSignature: 'correct the patch',
    precedingUserTurnId: 'data-message-id:user-new',
    precedingUserTurnIndex: 2,
    responseSha256: createHash('sha256').update(`${responseText}\n`).digest('hex'),
    signature: 'replacement patch ready',
  };
  const captureIdentity = {
    artifacts: [
      {
        artifactIndexInAssistantTurn: 0,
        assistantTurnId: assistantIdentity.assistantTurnId,
        assistantTurnIndex: assistantIdentity.assistantTurnIndex,
        href: 'sandbox:/mnt/data/fix.patch',
        label: 'fix.patch',
      },
    ],
    assistantResponse: assistantIdentity,
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/thread',
    committedUserTurn: {
      signature: 'correct the patch',
      turnId: 'data-message-id:user-new',
      turnIndex: 2,
    },
    schemaVersion: 1,
    targetId: 'target-new',
  };
  const snapshot = {
    assistantSnapshots: [
      {
        assistantTurnId: 'data-message-id:assistant-old',
        assistantTurnIndex: 1,
        hasCopyButton: true,
        precedingUserMessageSignature: 'initial patch',
        precedingUserTurnId: 'data-message-id:user-old',
        precedingUserTurnIndex: 0,
        signature: 'older patch ready',
        text: 'Older patch ready.',
      },
      {
        ...assistantIdentity,
        hasCopyButton: true,
        text: responseText,
      },
    ],
    attachmentButtons: [
      {
        artifactIndexInAssistantTurn: 0,
        assistantTurnId: 'data-message-id:assistant-old',
        assistantTurnIndex: 1,
        behaviorButton: true,
        href: 'sandbox:/mnt/data/fix.patch',
        insideAssistantMessage: true,
        tag: 'BUTTON',
        text: 'fix.patch',
      },
      {
        artifactIndexInAssistantTurn: 0,
        assistantTurnId: assistantIdentity.assistantTurnId,
        assistantTurnIndex: assistantIdentity.assistantTurnIndex,
        behaviorButton: true,
        href: 'sandbox:/mnt/data/fix.patch',
        insideAssistantMessage: true,
        tag: 'BUTTON',
        text: 'fix.patch',
      },
    ],
  };

  const scoped = scopeThreadSnapshotToCaptureIdentity(snapshot, captureIdentity);
  assert.equal(scoped.assistantSnapshots.length, 1);
  assert.equal(scoped.assistantSnapshots[0]?.assistantTurnId, assistantIdentity.assistantTurnId);
  assert.equal(scoped.attachmentButtons.length, 1);
  assert.equal(scoped.attachmentButtons[0]?.assistantTurnId, assistantIdentity.assistantTurnId);

  assert.throws(
    () => scopeThreadSnapshotToCaptureIdentity(
      {
        ...snapshot,
        assistantSnapshots: [snapshot.assistantSnapshots[0]],
      },
      captureIdentity,
    ),
    /resolved to 0 turns/u,
  );
});

test('pending capture binds completion to its exact committed user turn and persists only that artifact', async () => {
  const { completeThreadCaptureIdentity, scopeThreadSnapshotToCaptureIdentity } = await import(distThreadLib);
  const browserSource = readFileSync(new URL('../src/chatgpt-thread-lib.mts', import.meta.url), 'utf8');
  const pendingCapture = {
    artifacts: [],
    assistantResponse: null,
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/thread',
    committedUserTurn: {
      signature: 'repeat this request',
      turnId: 'data-message-id:user-new',
      turnIndex: 2,
    },
    schemaVersion: 1,
    targetId: 'accepted-target',
  };
  const exactAssistant = {
    afterLastUserMessage: true,
    assistantTurnId: 'data-message-id:assistant-new',
    assistantTurnIndex: 3,
    hasCopyButton: true,
    precedingUserMessageSignature: pendingCapture.committedUserTurn.signature,
    precedingUserTurnId: pendingCapture.committedUserTurn.turnId,
    precedingUserTurnIndex: pendingCapture.committedUserTurn.turnIndex,
    signature: 'exact completed response',
    text: 'Exact completed response.',
  };
  const snapshot = {
    assistantSnapshots: [
      {
        ...exactAssistant,
        afterLastUserMessage: false,
        assistantTurnId: 'data-message-id:assistant-old',
        assistantTurnIndex: 1,
        precedingUserTurnId: 'data-message-id:user-old',
        precedingUserTurnIndex: 0,
        signature: 'older same-prompt response',
      },
      exactAssistant,
    ],
    attachmentButtons: [{
      afterLastUserMessage: true,
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: exactAssistant.assistantTurnId,
      assistantTurnIndex: exactAssistant.assistantTurnIndex,
      behaviorButton: true,
      href: 'sandbox:/mnt/data/replacement.patch',
      insideAssistantMessage: true,
      insideFinalAssistantMessage: true,
      tag: 'BUTTON',
      text: 'replacement.patch',
    }],
    userSnapshots: [
      { signature: 'repeat this request', turnId: 'data-message-id:user-old', turnIndex: 0 },
      pendingCapture.committedUserTurn,
    ],
  };

  const scoped = scopeThreadSnapshotToCaptureIdentity(snapshot, pendingCapture);
  assert.deepEqual(scoped.assistantSnapshots.map((assistant) => assistant.assistantTurnId), [exactAssistant.assistantTurnId]);
  const completed = completeThreadCaptureIdentity(pendingCapture, snapshot);
  assert.equal(completed.assistantResponse?.assistantTurnId, exactAssistant.assistantTurnId);
  assert.match(completed.artifacts[0]?.label, /^sha256:[a-f0-9]{64}$/u);
  assert.match(
    browserSource,
    /Captured assistant artifact index no longer matches its exact href and label identity/u,
  );

  assert.throws(
    () => scopeThreadSnapshotToCaptureIdentity(
      {
        ...snapshot,
        userSnapshots: [
          ...snapshot.userSnapshots,
          { signature: 'later request', turnId: 'data-message-id:user-later', turnIndex: 4 },
        ],
      },
      pendingCapture,
    ),
    /no longer the latest request/u,
  );
});

test('exact target leases reject another tab for the same thread', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      id: 'other-target',
      type: 'page',
      url: 'https://chatgpt.com/c/thread',
      webSocketDebuggerUrl: 'ws://example/other',
    },
  ]), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { ensureTargetLease } = await import(distThreadLib);
  await assert.rejects(
    () => ensureTargetLease(
      'http://127.0.0.1:9333',
      'https://chatgpt.com/c/thread',
      'accepted-target',
    ),
    /resolved to 0 tabs.*refusing to navigate, create, or select another target/u,
  );
});

test('exact thread export inspects hydrated evidence before any requested reload', async (t) => {
  installFakeWebSocket(t);
  const root = mkdtempSync(path.join(tmpdir(), 'review-gpt-exact-export-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const originalFetch = globalThis.fetch;
  const chatUrl = 'https://chatgpt.com/c/exact-thread';
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'accepted-target',
    type: 'page',
    url: chatUrl,
    webSocketDebuggerUrl: 'ws://example/exact-target',
  }]), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const responseText = 'Replacement B is ready.';
  const rawSnapshot = {
    assistantFailureTexts: [],
    assistantSnapshots: [{
      assistantTurnId: 'data-message-id:assistant-b',
      assistantTurnIndex: 1,
      hasCopyButton: true,
      precedingUserMessageSignature: 'replace artifact a',
      precedingUserTurnId: 'data-message-id:user-a',
      precedingUserTurnIndex: 0,
      signature: 'replacement b is ready',
      text: responseText,
    }],
    attachmentButtons: [{
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: 'data-message-id:assistant-b',
      assistantTurnIndex: 1,
      behaviorButton: true,
      href: 'blob:https://chatgpt.com/replacement-b',
      insideAssistantMessage: true,
      tag: 'BUTTON',
      text: 'replacement-b.patch',
    }],
    bodyText: responseText,
    codeBlocks: [],
    href: chatUrl,
    patchMarkers: { addFile: false, beginPatch: false, deleteFile: false, diffGit: false, updateFile: false },
    statusBusy: false,
    statusTexts: [],
    stopVisible: false,
    title: 'Exact thread',
    userSnapshots: [{ signature: 'replace artifact a', turnId: 'data-message-id:user-a', turnIndex: 0 }],
  };
  const captureIdentity = {
    artifacts: [{
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: 'data-message-id:assistant-b',
      assistantTurnIndex: 1,
      href: 'blob:https://chatgpt.com/replacement-b',
      label: 'replacement-b.patch',
    }],
    assistantResponse: {
      assistantTurnId: 'data-message-id:assistant-b',
      assistantTurnIndex: 1,
      precedingUserMessageSignature: 'replace artifact a',
      precedingUserTurnId: 'data-message-id:user-a',
      precedingUserTurnIndex: 0,
      responseSha256: createHash('sha256').update(`${responseText}\n`).digest('hex'),
      signature: 'replacement b is ready',
    },
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl,
    committedUserTurn: { signature: 'replace artifact a', turnId: 'data-message-id:user-a', turnIndex: 0 },
    schemaVersion: 1,
    targetId: 'accepted-target',
  };
  const contentState = {
    articleCount: 2,
    attachmentButtonCount: 1,
    bodyLength: responseText.length,
    href: chatUrl,
    messageCount: 2,
    readyState: 'complete',
    title: 'Exact thread',
  };
  const { exportThreadSnapshot } = await import(distThreadLib);

  const runExport = async (forceReload) => {
    const priorSocketCount = FakeWebSocket.instances.length;
    const methods = [];
    let evaluateCount = 0;
    FakeWebSocket.onSend = (socket, command) => {
      methods.push(command.method);
      if (command.method === 'Runtime.evaluate') {
        evaluateCount += 1;
        const value = evaluateCount === 1 || (forceReload && evaluateCount === 2)
          ? contentState
          : rawSnapshot;
        respondToCdpCommand(socket, command, { result: { value } });
        return;
      }
      respondToCdpCommand(socket, command, {});
      if (command.method === 'Page.reload') {
        queueMicrotask(() => socket.emit('message', {
          data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }),
        }));
      }
    };
    const exportPromise = exportThreadSnapshot(
      captureIdentity.browserEndpoint,
      chatUrl,
      path.join(root, forceReload ? 'fallback.json' : 'hydrated.json'),
      { captureIdentity, forceReload },
    );
    await waitForTestCondition(() => FakeWebSocket.instances.length > priorSocketCount);
    const socket = FakeWebSocket.instances[priorSocketCount];
    socket.emit('open');
    await exportPromise;
    return methods;
  };

  const hydratedMethods = await runExport(false);
  assert.equal(hydratedMethods.includes('Page.reload'), false);
  assert.deepEqual(hydratedMethods.slice(0, 3), ['Runtime.enable', 'Runtime.evaluate', 'Runtime.evaluate']);

  const fallbackMethods = await runExport(true);
  assert.equal(fallbackMethods.filter((method) => method === 'Page.reload').length, 1);
  assert.ok(fallbackMethods.indexOf('Runtime.evaluate') < fallbackMethods.indexOf('Page.reload'));
});

test('Deep Research capture replays the exact iframe report through production wake and export', async (t) => {
  installFakeWebSocket(t);
  FakeWebSocket.autoOpen = true;
  const root = mkdtempSync(path.join(tmpdir(), 'review-gpt-deep-replay-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const browserEndpoint = 'http://127.0.0.1:9333';
  const chatUrl = 'https://chatgpt.com/c/deep-thread';
  const committedUserTurn = {
    signature: 'audit the browser lifecycle',
    turnId: 'data-message-id:user-deep',
    turnIndex: 2,
  };
  const parentAssistantAnchor = {
    afterLastUserMessage: true,
    assistantTurnId: 'data-message-id:assistant-deep',
    assistantTurnIndex: 3,
    hasCopyButton: false,
    precedingUserMessageSignature: committedUserTurn.signature,
    precedingUserTurnId: committedUserTurn.turnId,
    precedingUserTurnIndex: committedUserTurn.turnIndex,
    signature: 'researching',
    text: 'Researching',
  };
  const rawReportText = '0\n1\n2\n3\n4\n5\ncitations\nResearch completed\nExact final report';
  const finalReportText = 'Research completed\nExact final report';
  const attachment = {
    afterLastUserMessage: true,
    artifactIndexInAssistantTurn: 0,
    assistantTurnId: parentAssistantAnchor.assistantTurnId,
    assistantTurnIndex: parentAssistantAnchor.assistantTurnIndex,
    behaviorButton: true,
    href: 'sandbox:/mnt/data/deep-report.md',
    insideAssistantMessage: true,
    insideFinalAssistantMessage: true,
    tag: 'BUTTON',
    text: 'deep-report.md',
  };

  const mergedWaitState = mergeResponseCaptureStates(
    {
      assistantSnapshots: [parentAssistantAnchor],
      attachmentButtons: [attachment],
      statusBusy: false,
      statusTexts: ['Researching'],
      stopVisible: false,
    },
    {
      assistantSnapshots: [{ hasCopyButton: true, signature: 'iframe-report', text: rawReportText }],
      statusBusy: false,
      statusTexts: ['Research completed'],
      stopVisible: false,
    },
    committedUserTurn,
  );
  const selectedCompletion = selectAssistantResponseCandidate(
    mergedWaitState,
    [parentAssistantAnchor.signature],
    [],
    true,
    committedUserTurn.signature,
    committedUserTurn.turnId,
    committedUserTurn.turnIndex,
  ).snapshot;
  assert.equal(selectedCompletion?.text, finalReportText);

  const captured = buildThreadCaptureIdentity({
    assistantSnapshot: selectedCompletion,
    attachmentButtons: mergedWaitState.attachmentButtons,
    browserEndpoint,
    chatUrl,
    committedUserTurn,
    targetId: 'deep-target',
  });
  const serializedCapture = JSON.stringify(captured);
  assert.doesNotMatch(serializedCapture, /Researching|Exact final report|sandbox:\/mnt\/data/u);

  const { exportThreadSnapshot, parseThreadCaptureIdentity } = await import(distThreadLib);
  const { runWakeFlow } = await import(distWakeLib);
  const parsedCapture = parseThreadCaptureIdentity(JSON.parse(serializedCapture));
  assert.equal(parsedCapture.assistantResponse?.contentSource, 'deep-research-iframe');
  assert.match(parsedCapture.assistantResponse?.parentAnchor?.signature ?? '', /^sha256:[a-f0-9]{64}$/u);

  const basePageSnapshot = {
    assistantFailureTexts: [],
    assistantSnapshots: [parentAssistantAnchor],
    attachmentButtons: [attachment],
    bodyText: 'Researching',
    codeBlocks: [],
    href: chatUrl,
    patchMarkers: { addFile: false, beginPatch: false, deleteFile: false, diffGit: false, updateFile: false },
    statusBusy: false,
    statusTexts: [],
    stopVisible: false,
    title: 'Deep Research thread',
    userSnapshots: [committedUserTurn],
  };
  const contentState = {
    articleCount: 2,
    attachmentButtonCount: 1,
    bodyLength: 100,
    href: chatUrl,
    messageCount: 2,
    readyState: 'complete',
    title: 'Deep Research thread',
  };
  const originalFetch = globalThis.fetch;
  let includeSecondIframe = false;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      id: 'deep-target',
      type: 'page',
      url: chatUrl,
      webSocketDebuggerUrl: 'ws://example/deep-parent',
    },
    {
      id: 'deep-iframe',
      parentId: 'deep-target',
      title: 'Deep Research',
      type: 'iframe',
      url: 'https://chatgpt.com/connector_openai_deep_research/report',
      webSocketDebuggerUrl: 'ws://example/deep-iframe',
    },
    ...(includeSecondIframe
      ? [{
          id: 'deep-iframe-stale',
          parentId: 'deep-target',
          title: 'Deep Research',
          type: 'iframe',
          url: 'https://chatgpt.com/connector_openai_deep_research/report',
          webSocketDebuggerUrl: 'ws://example/deep-iframe-stale',
        }]
      : []),
  ]), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let currentPageSnapshot = basePageSnapshot;
  let currentIframeReportText = rawReportText;
  let currentSecondIframeReportText = 'Research completed\nStale iframe report';
  const parentEvaluateCounts = new WeakMap();
  FakeWebSocket.onSend = (socket, command) => {
    if (command.method !== 'Runtime.evaluate') {
      respondToCdpCommand(socket, command, {});
      return;
    }
    if (socket.url === 'ws://example/deep-iframe' || socket.url === 'ws://example/deep-iframe-stale') {
      assert.match(command.params.expression, /research completed/u);
      respondToCdpCommand(socket, command, {
        result: {
          value: {
            assistantSnapshots: [{
              hasCopyButton: true,
              signature: 'iframe-report',
              text: socket.url === 'ws://example/deep-iframe'
                ? currentIframeReportText
                : currentSecondIframeReportText,
            }],
            statusBusy: false,
            statusTexts: ['Research completed'],
            stopVisible: false,
          },
        },
      });
      return;
    }
    const evaluateCount = (parentEvaluateCounts.get(socket) ?? 0) + 1;
    parentEvaluateCounts.set(socket, evaluateCount);
    respondToCdpCommand(socket, command, {
      result: { value: evaluateCount === 1 ? contentState : currentPageSnapshot },
    });
  };

  const pendingCapture = parseThreadCaptureIdentity(buildThreadCaptureIdentity({
    browserEndpoint,
    chatUrl,
    committedUserTurn,
    expectedContentSource: 'deep-research-iframe',
    targetId: 'deep-target',
  }));
  assert.equal(pendingCapture.assistantResponse, null);
  assert.equal(pendingCapture.expectedContentSource, 'deep-research-iframe');
  assert.doesNotMatch(JSON.stringify(pendingCapture), /Researching|Exact final report|sandbox:\/mnt\/data/u);
  const pendingCapturePath = path.join(root, 'pending-capture.json');
  writeFileSync(pendingCapturePath, `${JSON.stringify(pendingCapture)}\n`, 'utf8');
  const pendingDownloads = [];
  const pendingWakeResult = await runWakeFlow(
    {
      browserEndpoint,
      captureIdentity: pendingCapture,
      captureMetadataPath: pendingCapturePath,
      chatUrl,
      delayMs: 0,
      outputDir: path.join(root, 'pending-wake'),
      pollJitterMs: 0,
      pollUntilComplete: false,
      repoDir: root,
      skipResume: true,
      tabLifecycle: 'keep',
    },
    {
      downloadThreadAttachment: async (_endpoint, _url, label) => {
        pendingDownloads.push(label);
        return path.join(root, 'pending-wake', 'downloads', label);
      },
      log: () => {},
      sleep: async () => {},
    },
  );
  assert.equal(readFileSync(pendingWakeResult.assistantResponsePath, 'utf8'), `${finalReportText}\n`);
  assert.doesNotMatch(readFileSync(pendingWakeResult.exportPath, 'utf8'), /Researching/u);
  assert.deepEqual(pendingDownloads, ['deep-report.md']);
  const completedPendingCapture = parseThreadCaptureIdentity(JSON.parse(readFileSync(pendingCapturePath, 'utf8')));
  assert.equal(completedPendingCapture.expectedContentSource, 'deep-research-iframe');
  assert.equal(completedPendingCapture.assistantResponse?.contentSource, 'deep-research-iframe');
  assert.match(completedPendingCapture.assistantResponse?.parentAnchor?.signature ?? '', /^sha256:[a-f0-9]{64}$/u);

  const downloads = [];
  const wakeResult = await runWakeFlow(
    {
      browserEndpoint,
      captureIdentity: parsedCapture,
      chatUrl,
      delayMs: 0,
      outputDir: path.join(root, 'wake'),
      pollJitterMs: 0,
      pollUntilComplete: false,
      repoDir: root,
      skipResume: true,
      tabLifecycle: 'keep',
    },
    {
      downloadThreadAttachment: async (_endpoint, _url, label, _dir, _timeout, selector, options) => {
        downloads.push({ label, options, selector });
        return path.join(root, 'wake', 'downloads', label);
      },
      log: () => {},
      sleep: async () => {},
    },
  );
  assert.equal(readFileSync(wakeResult.assistantResponsePath, 'utf8'), `${finalReportText}\n`);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]?.selector.assistantTurnId, parentAssistantAnchor.assistantTurnId);
  assert.equal(downloads[0]?.options.captureIdentity, parsedCapture);

  includeSecondIframe = true;
  const multiFrameExport = await exportThreadSnapshot(
    browserEndpoint,
    chatUrl,
    path.join(root, 'multi-frame.json'),
    { captureIdentity: parsedCapture },
  );
  assert.equal(multiFrameExport.assistantSnapshots[0]?.text, finalReportText);

  currentSecondIframeReportText = rawReportText;
  await assert.rejects(
    () => exportThreadSnapshot(browserEndpoint, chatUrl, path.join(root, 'duplicate-report.json'), {
      captureIdentity: parsedCapture,
    }),
    /Deep Research report identity resolved to 2 of 2 frames/u,
  );

  includeSecondIframe = false;
  currentIframeReportText = 'Research completed\nWrong iframe report';
  await assert.rejects(
    () => exportThreadSnapshot(browserEndpoint, chatUrl, path.join(root, 'wrong-report.json'), {
      captureIdentity: parsedCapture,
    }),
    /Captured assistant response identity resolved to 0 turns/u,
  );

  currentIframeReportText = rawReportText;
  currentPageSnapshot = {
    ...basePageSnapshot,
    assistantSnapshots: [parentAssistantAnchor, { ...parentAssistantAnchor }],
  };
  await assert.rejects(
    () => exportThreadSnapshot(browserEndpoint, chatUrl, path.join(root, 'ambiguous-parent.json'), {
      captureIdentity: parsedCapture,
    }),
    /Deep Research parent assistant anchor resolved to 2 turns/u,
  );
});

test('exact attachment activation remains authoritative after a later user turn', async (t) => {
  installFakeWebSocket(t);
  const root = mkdtempSync(path.join(tmpdir(), 'review-gpt-exact-download-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const originalFetch = globalThis.fetch;
  const chatUrl = 'https://chatgpt.com/c/exact-thread';
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'accepted-target',
    type: 'page',
    url: chatUrl,
    webSocketDebuggerUrl: 'ws://example/exact-download',
  }]), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  class MockHTMLElement {}
  const originalUser = {};
  const laterUser = {
    compareDocumentPosition(node) {
      return node === laterAssistant ? 4 : 0;
    },
  };
  const capturedAssistant = {
    contains(node) { return node === artifactButton; },
    getAttribute(name) { return name === 'data-message-id' ? 'assistant-old' : ''; },
    innerText: 'Replacement B is ready.',
    textContent: 'Replacement B is ready.',
  };
  const laterAssistant = {
    contains() { return false; },
    getAttribute(name) { return name === 'data-message-id' ? 'assistant-later' : ''; },
    innerText: 'Later answer without the artifact.',
    textContent: 'Later answer without the artifact.',
  };
  let activationClicks = 0;
  const artifactButton = Object.assign(new MockHTMLElement(), {
    classList: { contains: () => false },
    closest: () => capturedAssistant,
    dispatchEvent: () => true,
    getAttribute: (name) => name === 'aria-label' ? 'replacement-b.patch' : '',
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    hasAttribute: (name) => name === 'download',
    href: 'blob:https://chatgpt.com/replacement-b',
    innerText: 'replacement-b.patch',
    ownerDocument: { defaultView: { MouseEvent: class {}, PointerEvent: class {} } },
    scrollIntoView: () => {},
    click: () => { activationClicks += 1; },
  });
  const documentRoot = {
    querySelectorAll(selector) {
      if (selector === 'button, a') return [artifactButton];
      if (selector.includes('user')) return [originalUser, laterUser];
      return [capturedAssistant, laterAssistant];
    },
  };
  const context = {
    document: { body: documentRoot, querySelector: () => documentRoot },
    HTMLElement: MockHTMLElement,
    location: { href: chatUrl },
    Math,
    MouseEvent: class {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    PointerEvent: class {},
    URL,
    window: { MouseEvent: class {}, PointerEvent: class {} },
  };
  const contentState = {
    articleCount: 3,
    attachmentButtonCount: 1,
    bodyLength: 100,
    href: chatUrl,
    messageCount: 4,
    readyState: 'complete',
    title: 'Exact thread',
  };
  let evaluateCount = 0;
  FakeWebSocket.onSend = (socket, command) => {
    if (command.method !== 'Runtime.evaluate') {
      respondToCdpCommand(socket, command, {});
      return;
    }
    evaluateCount += 1;
    const value = evaluateCount === 1
      ? contentState
      : vm.runInNewContext(command.params.expression, context);
    respondToCdpCommand(socket, command, { result: { value } });
    if (evaluateCount === 3) {
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({
          method: 'Page.downloadWillBegin',
          params: { guid: 'replacement-b', suggestedFilename: 'replacement-b.patch' },
        }),
      }));
      // Let completeNativeDownload install its progress listener after the
      // downloadWillBegin promise wins the race.
      setTimeout(() => {
        writeFileSync(path.join(root, 'replacement-b.patch'), 'patch bytes', 'utf8');
        socket.emit('message', {
          data: JSON.stringify({
            method: 'Page.downloadProgress',
            params: { guid: 'replacement-b', state: 'completed' },
          }),
        });
      }, 25);
    }
  };

  const { downloadThreadAttachment } = await import(distThreadLib);
  const downloadPromise = downloadThreadAttachment(
    'http://127.0.0.1:9333',
    chatUrl,
    'replacement-b.patch',
    root,
    2_000,
    {
      artifactIndex: 0,
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: 'data-message-id:assistant-old',
      assistantTurnIndex: 0,
    },
    {
      captureIdentity: {
        artifacts: [],
        assistantResponse: null,
        browserEndpoint: 'http://127.0.0.1:9333',
        chatUrl,
        committedUserTurn: { signature: 'original request', turnId: 'data-message-id:user-original', turnIndex: 0 },
        schemaVersion: 1,
        targetId: 'accepted-target',
      },
    },
  );
  await waitForTestCondition(() => FakeWebSocket.instances.some((socket) => socket.url === 'ws://example/exact-download'));
  FakeWebSocket.instances.find((socket) => socket.url === 'ws://example/exact-download').emit('open');

  assert.equal(await downloadPromise, path.join(root, 'replacement-b.patch'));
  assert.equal(activationClicks > 0, true);
});

test('exact attachment activation revalidates stored artifact digests immediately before clicking', async (t) => {
  installFakeWebSocket(t);
  const root = mkdtempSync(path.join(tmpdir(), 'review-gpt-digest-download-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const browserEndpoint = 'http://127.0.0.1:9333';
  const chatUrl = 'https://chatgpt.com/c/digest-thread';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'digest-target',
    type: 'page',
    url: chatUrl,
    webSocketDebuggerUrl: 'ws://example/digest-download',
  }]), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const committedUserTurn = {
    signature: 'produce the exact artifact',
    turnId: 'data-message-id:user-digest',
    turnIndex: 0,
  };
  const assistantSnapshot = {
    afterLastUserMessage: true,
    assistantTurnId: 'data-message-id:assistant-digest',
    assistantTurnIndex: 0,
    hasCopyButton: true,
    precedingUserMessageSignature: committedUserTurn.signature,
    precedingUserTurnId: committedUserTurn.turnId,
    precedingUserTurnIndex: committedUserTurn.turnIndex,
    signature: 'the exact artifact is ready',
    text: 'The exact artifact is ready.',
  };
  const expectedAttachment = {
    afterLastUserMessage: true,
    artifactIndexInAssistantTurn: 0,
    assistantTurnId: assistantSnapshot.assistantTurnId,
    assistantTurnIndex: assistantSnapshot.assistantTurnIndex,
    download: true,
    href: 'blob:https://chatgpt.com/expected-artifact',
    insideAssistantMessage: true,
    insideFinalAssistantMessage: true,
    tag: 'A',
    text: 'expected.patch',
  };
  const captureIdentity = buildThreadCaptureIdentity({
    assistantSnapshot,
    attachmentButtons: [expectedAttachment],
    browserEndpoint,
    chatUrl,
    committedUserTurn,
    targetId: 'digest-target',
  });
  assert.match(captureIdentity.artifacts[0]?.href ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.match(captureIdentity.artifacts[0]?.label ?? '', /^sha256:[a-f0-9]{64}$/u);

  const replacementAttachment = {
    ...expectedAttachment,
    href: 'blob:https://chatgpt.com/replacement-artifact',
    text: 'replacement.patch',
  };
  const liveSnapshot = {
    assistantFailureTexts: [],
    assistantSnapshots: [assistantSnapshot],
    attachmentButtons: [replacementAttachment],
    bodyText: assistantSnapshot.text,
    codeBlocks: [],
    href: chatUrl,
    patchMarkers: { addFile: false, beginPatch: false, deleteFile: false, diffGit: false, updateFile: false },
    statusBusy: false,
    statusTexts: [],
    stopVisible: false,
    title: 'Digest thread',
    userSnapshots: [committedUserTurn],
  };
  const contentState = {
    articleCount: 2,
    attachmentButtonCount: 1,
    bodyLength: 100,
    href: chatUrl,
    messageCount: 2,
    readyState: 'complete',
    title: 'Digest thread',
  };

  class MockHTMLElement {}
  const userNode = {
    compareDocumentPosition(node) {
      return node === assistantNode ? 4 : 0;
    },
  };
  const assistantNode = {
    contains(node) { return node === artifactButton; },
    getAttribute(name) { return name === 'data-message-id' ? 'assistant-digest' : ''; },
    innerText: assistantSnapshot.text,
    textContent: assistantSnapshot.text,
  };
  let activationClicks = 0;
  const artifactButton = Object.assign(new MockHTMLElement(), {
    classList: { contains: () => false },
    closest: () => assistantNode,
    dispatchEvent: () => true,
    getAttribute: (name) => name === 'aria-label' ? replacementAttachment.text : '',
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    hasAttribute: (name) => name === 'download',
    href: replacementAttachment.href,
    innerText: replacementAttachment.text,
    ownerDocument: { defaultView: { MouseEvent: class {}, PointerEvent: class {} } },
    scrollIntoView: () => {},
    click: () => { activationClicks += 1; },
  });
  const documentRoot = {
    querySelectorAll(selector) {
      if (selector === 'button, a') return [artifactButton];
      if (selector.includes('user')) return [userNode];
      return [assistantNode];
    },
  };
  const context = {
    document: { body: documentRoot, querySelector: () => documentRoot },
    HTMLElement: MockHTMLElement,
    location: { href: chatUrl },
    Math,
    MouseEvent: class {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    PointerEvent: class {},
    URL,
    window: { MouseEvent: class {}, PointerEvent: class {} },
  };
  let evaluateCount = 0;
  FakeWebSocket.onSend = (socket, command) => {
    if (command.method !== 'Runtime.evaluate') {
      respondToCdpCommand(socket, command, {});
      return;
    }
    evaluateCount += 1;
    const expression = String(command.params.expression ?? '');
    const value = evaluateCount === 1
      ? contentState
      : expression.includes('const bodyText = root?.innerText')
        ? liveSnapshot
        : vm.runInNewContext(expression, context);
    respondToCdpCommand(socket, command, { result: { value } });
    if (expression.includes('dispatchClickSequence')) {
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({
          method: 'Page.downloadWillBegin',
          params: { guid: 'replacement', suggestedFilename: replacementAttachment.text },
        }),
      }));
      setTimeout(() => {
        writeFileSync(path.join(root, replacementAttachment.text), 'replacement bytes', 'utf8');
        socket.emit('message', {
          data: JSON.stringify({
            method: 'Page.downloadProgress',
            params: { guid: 'replacement', state: 'completed' },
          }),
        });
      }, 25);
    }
  };

  const { downloadThreadAttachment } = await import(distThreadLib);
  const downloadPromise = downloadThreadAttachment(
    browserEndpoint,
    chatUrl,
    '',
    root,
    2_000,
    {
      artifactIndex: 0,
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: assistantSnapshot.assistantTurnId,
      assistantTurnIndex: assistantSnapshot.assistantTurnIndex,
    },
    { captureIdentity },
  );
  await waitForTestCondition(() => FakeWebSocket.instances.some((socket) => socket.url === 'ws://example/digest-download'));
  FakeWebSocket.instances.find((socket) => socket.url === 'ws://example/digest-download').emit('open');

  await assert.rejects(downloadPromise, /Captured assistant artifact identity resolved to 0 controls/u);
  assert.equal(activationClicks, 0);
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
