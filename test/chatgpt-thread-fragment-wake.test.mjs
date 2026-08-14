import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const distThreadLib = new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url);
const distWakeLib = new URL('../dist/chatgpt-thread-wake-lib.mjs', import.meta.url);

test('treats punctuation-less idle assistant turns as retainable text instead of busy state', async () => {
  const { assistantSnapshotLooksIncomplete, snapshotBusyReason } = await import(distThreadLib);

  const snapshot = {
    assistantSnapshots: [{ hasCopyButton: true, signature: 'i-ve-now-confirmed', text: 'I’ve now confirmed' }],
    attachmentButtons: [],
    patchMarkers: {
      addFile: false,
      beginPatch: false,
      deleteFile: false,
      diffGit: false,
      updateFile: false,
    },
    statusBusy: false,
    stopVisible: false,
  };

  assert.equal(assistantSnapshotLooksIncomplete(snapshot), false);
  assert.equal(snapshotBusyReason(snapshot), 'idle');
});

test('recognizes a finalized nested assistant response when its outer turn owns the copy control', async () => {
  const { assistantSnapshotLooksIncomplete, assistantSnapshotLooksTerminal } = await import(distThreadLib);

  const snapshot = {
    assistantSnapshots: [
      {
        afterLastUserMessage: true,
        hasCopyButton: true,
        signature: 'worked-for-12s-review-complete',
        text: 'Worked for 12s\n\nREVIEW_COMPLETE',
      },
      {
        afterLastUserMessage: true,
        hasCopyButton: false,
        modelSlug: 'gpt-pro',
        signature: 'review-complete',
        text: 'REVIEW_COMPLETE',
      },
    ],
    attachmentButtons: [],
    patchMarkers: {
      addFile: false,
      beginPatch: false,
      deleteFile: false,
      diffGit: false,
      updateFile: false,
    },
    statusBusy: false,
    statusTexts: [],
    stopVisible: false,
  };

  assert.equal(assistantSnapshotLooksTerminal(snapshot), true);
  assert.equal(assistantSnapshotLooksIncomplete(snapshot), false);
});

test('runWakeFlow closes a finalized harvested thread while keeping it open during export', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/example-thread',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollUntilComplete: false,
      repoDir: '/repo',
      skipResume: true,
      tabLifecycle: 'close-harvested',
    },
    {
      closeThreadTarget: async () => {
        calls.push('close');
        return true;
      },
      downloadThreadAttachment: async () => {
        throw new Error('no artifact should be downloaded');
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, _outputPath, options) => {
        calls.push(`export:${options?.targetLifecycle}`);
        return {
          assistantFailureTexts: [],
          assistantSnapshots: [
            {
              afterLastUserMessage: true,
              hasCopyButton: true,
              signature: 'worked-for-12s-review-complete',
              text: 'Worked for 12s\n\nREVIEW_COMPLETE',
            },
            {
              afterLastUserMessage: true,
              hasCopyButton: false,
              modelSlug: 'gpt-pro',
              signature: 'review-complete',
              text: 'REVIEW_COMPLETE',
            },
          ],
          attachmentButtons: [],
          bodyText: 'REVIEW_COMPLETE',
          capturedAt: '2026-08-06T12:00:00Z',
          chatUrl: 'https://chatgpt.com/c/example-thread',
          codeBlocks: [],
          href: 'https://chatgpt.com/c/example-thread',
          patchMarkers: {
            addFile: false,
            beginPatch: false,
            deleteFile: false,
            diffGit: false,
            updateFile: false,
          },
          statusBusy: false,
          statusTexts: [],
          stopVisible: false,
          title: 'Lifecycle test',
        };
      },
      log: () => {},
      mkdir: async () => {},
      sleep: async () => {},
      writeFile: async (targetPath) => {
        if (targetPath.endsWith('assistant-response.md')) {
          calls.push('write-response');
        }
      },
    },
  );

  assert.equal(result.handoffKind, 'text');
  assert.deepEqual(calls.filter((call) => call === 'export:keep' || call === 'write-response' || call === 'close'), [
    'export:keep',
    'write-response',
    'close',
  ]);
});

test('artifact download failure retains the exact target and writes a replayable recovery command', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const writes = new Map();
  let closeAttempts = 0;
  const chatUrl = 'https://chatgpt.com/c/exact-download-failure';
  const responseText = 'Replacement artifact is ready.';
  const captureIdentity = {
    artifacts: [{
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: 'data-message-id:assistant',
      assistantTurnIndex: 1,
      href: null,
      label: 'replacement.patch',
    }],
    assistantResponse: {
      assistantTurnId: 'data-message-id:assistant',
      assistantTurnIndex: 1,
      precedingUserMessageSignature: 'replace it',
      precedingUserTurnId: 'data-message-id:user',
      precedingUserTurnIndex: 0,
      responseSha256: createHash('sha256').update(`${responseText}\n`).digest('hex'),
      signature: 'replacement artifact is ready',
    },
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl,
    committedUserTurn: { signature: 'replace it', turnId: 'data-message-id:user', turnIndex: 0 },
    schemaVersion: 1,
    targetId: 'accepted-target',
  };

  const result = await runWakeFlow(
    {
      browserEndpoint: captureIdentity.browserEndpoint,
      captureIdentity,
      captureMetadataPath: '/repo/response.capture.json',
      chatUrl,
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/exact-failure',
      pollUntilComplete: false,
      repoDir: '/repo',
      skipResume: true,
      tabLifecycle: 'close-harvested',
    },
    {
      closeThreadTarget: async () => {
        closeAttempts += 1;
        return true;
      },
      downloadThreadAttachment: async () => {
        throw new Error('download did not materialize');
      },
      exportThreadSnapshot: async (_endpoint, _url, _path, options) => {
        assert.notEqual(options?.forceReload, true);
        return {
          assistantFailureTexts: [],
          assistantSnapshots: [{
            afterLastUserMessage: true,
            ...captureIdentity.assistantResponse,
            hasCopyButton: true,
            text: responseText,
          }],
          attachmentButtons: [{
            afterLastUserMessage: true,
            artifactIndexInAssistantTurn: 0,
            assistantTurnId: 'data-message-id:assistant',
            assistantTurnIndex: 1,
            behaviorButton: true,
            href: null,
            insideAssistantMessage: true,
            tag: 'BUTTON',
            text: 'replacement.patch',
          }],
          bodyText: responseText,
          capturedAt: '2026-08-13T00:00:00Z',
          chatUrl,
          codeBlocks: [],
          href: chatUrl,
          patchMarkers: { addFile: false, beginPatch: false, deleteFile: false, diffGit: false, updateFile: false },
          statusBusy: false,
          statusTexts: [],
          stopVisible: false,
          title: 'Exact thread',
          userSnapshots: [captureIdentity.committedUserTurn],
        };
      },
      log: () => {},
      mkdir: async () => {},
      sleep: async () => {},
      writeFile: async (filePath, contents) => {
        writes.set(filePath, String(contents));
      },
    },
  );

  assert.deepEqual(result.downloadErrors, ['replacement.patch: download did not materialize']);
  assert.equal(closeAttempts, 0);
  assert.match(writes.get(result.replayCommandsPath), /'--capture-metadata' 'response\.capture\.json'/u);
  assert.match(writes.get(result.replayCommandsPath), /'--chat-url' 'https:\/\/chatgpt\.com\/c\/exact-download-failure'/u);
});

test('exact wake allows only one reload fallback after hydrated identity validation fails', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const captureIdentity = {
    artifacts: [],
    assistantResponse: null,
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/exact-fallback',
    committedUserTurn: { signature: 'request', turnId: 'data-message-id:user', turnIndex: 0 },
    schemaVersion: 1,
    targetId: 'accepted-target',
  };
  const forceReloads = [];

  await assert.rejects(
    () => runWakeFlow(
      {
        browserEndpoint: captureIdentity.browserEndpoint,
        captureIdentity,
        chatUrl: captureIdentity.chatUrl,
        delayMs: 0,
        outputDir: '/repo/output-packages/chatgpt-watch/exact-fallback',
        pollUntilComplete: false,
        repoDir: '/repo',
        skipResume: true,
      },
      {
        exportThreadSnapshot: async (_endpoint, _url, _path, options) => {
          forceReloads.push(options?.forceReload === true);
          throw new Error('Captured committed user-turn identity resolved to 0 turns; refusing ambiguous wake.');
        },
        log: () => {},
        mkdir: async () => {},
        sleep: async () => {},
        writeFile: async () => {},
      },
    ),
    /resolved to 0 turns/u,
  );

  assert.deepEqual(forceReloads, [false, true]);
});

test('runWakeFlow keeps polling punctuation-less idle turns until an assistant artifact appears', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];
  let exportCount = 0;

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollIntervalMs: 60_000,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath, options) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}:${options?.forceReload === true ? 'reload' : 'normal'}`);
        if (exportCount === 1) {
          return {
            assistantSnapshots: [{ hasCopyButton: true, signature: 'i-ve-now-confirmed', text: 'I’ve now confirmed' }],
            attachmentButtons: [],
            bodyText: 'I’ve now confirmed',
            capturedAt: '2026-03-29T00:00:00Z',
            chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
            codeBlocks: [],
            href: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
            patchMarkers: {
              addFile: false,
              beginPatch: false,
              deleteFile: false,
              diffGit: false,
              updateFile: false,
            },
            statusBusy: false,
            statusTexts: [],
            stopVisible: false,
            title: 'Thread title',
          };
        }
        return {
          assistantSnapshots: [{ hasCopyButton: false, signature: 'patch ready', text: 'Patch: assistant.patch' }],
          attachmentButtons: [{ behaviorButton: true, href: null, insideAssistantMessage: true, insideFinalAssistantMessage: true, tag: 'button', text: 'assistant.patch' }],
          bodyText: 'Patch: assistant.patch',
          capturedAt: '2026-03-29T00:01:00Z',
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          codeBlocks: [],
          href: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          patchMarkers: {
            addFile: false,
            beginPatch: false,
            deleteFile: false,
            diffGit: false,
            updateFile: false,
          },
          statusBusy: false,
          statusTexts: [],
          stopVisible: false,
          title: 'Thread title',
        };
      },
      log: (message) => {
        calls.push(message);
      },
      mkdir: async () => {},
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async () => {},
      sleep: async () => {},
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 2);
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
  assert.match(calls.join('\n'), /Wake check 1: forcing a same-tab reload before the first export to avoid stale hydrated thread state\./u);
  assert.match(calls.join('\n'), /export:1:\/repo\/output-packages\/chatgpt-watch\/run\/thread\.json:reload/u);
  assert.match(calls.join('\n'), /Thread still looks busy; polling again in 60000ms\./u);
  assert.match(calls.join('\n'), /export:2:\/repo\/output-packages\/chatgpt-watch\/run\/thread\.json:normal/u);
  assert.match(calls.join('\n'), /reason="assistant-settling", lastAssistant="I’ve now confirmed"/u);
  assert.match(calls.join('\n'), /reason="idle", lastAssistant="Patch: assistant\.patch"/u);
});

test('runWakeFlow carries exact capture identity through export and artifact download', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const captureIdentity = {
    artifacts: [],
    assistantResponse: null,
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/exact-thread',
    committedUserTurn: {
      signature: 'review',
      turnId: 'data-message-id:user',
      turnIndex: 0,
    },
    schemaVersion: 1,
    targetId: 'accepted-target',
  };
  const observations = [];
  let persistedCapture = null;

  await runWakeFlow(
    {
      browserEndpoint: captureIdentity.browserEndpoint,
      captureIdentity,
      captureMetadataPath: '/repo/review.md.capture.json',
      chatUrl: captureIdentity.chatUrl,
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/exact',
      pollUntilComplete: false,
      repoDir: '/repo',
      skipResume: true,
      tabLifecycle: 'keep',
    },
    {
      downloadThreadAttachment: async (_endpoint, _url, _label, _dir, _timeout, selector, options) => {
        observations.push({ kind: 'download', options, selector });
        return '/repo/output-packages/chatgpt-watch/exact/downloads/fix.patch';
      },
      exportThreadSnapshot: async (_endpoint, _url, _path, options) => {
        observations.push({ kind: 'export', options });
        return {
          assistantFailureTexts: [],
          assistantSnapshots: [{
            afterLastUserMessage: true,
            assistantTurnId: 'data-message-id:assistant',
            assistantTurnIndex: 1,
            hasCopyButton: true,
            precedingUserMessageSignature: captureIdentity.committedUserTurn.signature,
            precedingUserTurnId: captureIdentity.committedUserTurn.turnId,
            precedingUserTurnIndex: captureIdentity.committedUserTurn.turnIndex,
            signature: 'done',
            text: 'Done',
          }],
          attachmentButtons: [{
            afterLastUserMessage: true,
            artifactIndexInAssistantTurn: 0,
            assistantTurnId: 'data-message-id:assistant',
            assistantTurnIndex: 1,
            behaviorButton: true,
            href: null,
            insideAssistantMessage: true,
            insideFinalAssistantMessage: true,
            tag: 'BUTTON',
            text: 'fix.patch',
          }],
          bodyText: 'Done',
          capturedAt: '2026-08-13T00:00:00Z',
          chatUrl: captureIdentity.chatUrl,
          codeBlocks: [],
          href: captureIdentity.chatUrl,
          patchMarkers: {
            addFile: false,
            beginPatch: false,
            deleteFile: false,
            diffGit: false,
            updateFile: false,
          },
          statusBusy: false,
          statusTexts: [],
          stopVisible: false,
          title: 'Exact thread',
          userSnapshots: [captureIdentity.committedUserTurn],
        };
      },
      log: () => {},
      mkdir: async () => {},
      sleep: async () => {},
      writeCaptureIdentity: async (filePath, capture) => {
        if (filePath === '/repo/review.md.capture.json') {
          persistedCapture = capture;
        }
      },
      writeFile: async (filePath, contents) => {
        void filePath;
        void contents;
      },
    },
  );

  assert.equal(observations[0]?.kind, 'export');
  assert.equal(observations[0]?.options.captureIdentity, captureIdentity);
  assert.notEqual(observations[0]?.options.forceReload, true);
  assert.equal(observations[1]?.kind, 'download');
  assert.equal(observations[1]?.options.captureIdentity.assistantResponse.assistantTurnId, 'data-message-id:assistant');
  assert.equal(observations[1]?.selector.assistantTurnId, 'data-message-id:assistant');
  assert.equal(observations[1]?.selector.artifactIndexInAssistantTurn, 0);
  assert.equal(persistedCapture?.assistantResponse?.assistantTurnId, 'data-message-id:assistant');
  assert.match(persistedCapture?.artifacts[0]?.label, /^sha256:[a-f0-9]{64}$/u);
});

test('runWakeFlow does not hand off stable progress prose before the assistant turn is complete', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];
  let exportCount = 0;
  const progressText =
    'I’ll audit the applied workspace, trace the ownership and lock order, then produce one minimal patch with focused tests.';
  const finalText = 'Done. The focused correction patch is attached.';

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollIntervalMs: 60_000,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async () => {
        exportCount += 1;
        if (exportCount <= 2) {
          return {
            assistantSnapshots: [
              {
                afterLastUserMessage: true,
                hasCopyButton: false,
                signature: 'audit-progress',
                text: progressText,
              },
            ],
            attachmentButtons: [],
            bodyText: progressText,
            capturedAt: `2026-07-30T09:4${exportCount}:00Z`,
            chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
            codeBlocks: [],
            href: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
            patchMarkers: {
              addFile: false,
              beginPatch: false,
              deleteFile: false,
              diffGit: false,
              updateFile: false,
            },
            statusBusy: false,
            statusTexts: [],
            stopVisible: false,
            title: 'Thread title',
          };
        }
        return {
          assistantSnapshots: [
            {
              afterLastUserMessage: true,
              hasCopyButton: true,
              signature: 'audit-complete',
              text: finalText,
            },
          ],
          attachmentButtons: [
            {
              afterLastUserMessage: true,
              behaviorButton: true,
              href: null,
              insideAssistantMessage: true,
              insideFinalAssistantMessage: true,
              tag: 'button',
              text: 'assistant.patch',
            },
          ],
          bodyText: finalText,
          capturedAt: '2026-07-30T09:43:00Z',
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          codeBlocks: [],
          href: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          patchMarkers: {
            addFile: false,
            beginPatch: false,
            deleteFile: false,
            diffGit: false,
            updateFile: false,
          },
          statusBusy: false,
          statusTexts: ['Done'],
          stopVisible: false,
          title: 'Thread title',
        };
      },
      log: (message) => {
        calls.push(message);
      },
      mkdir: async () => {},
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async () => {},
      sleep: async () => {},
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 3);
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
  assert.equal(calls.filter((entry) => entry.includes('reason="assistant-settling"')).length, 2);
  assert.doesNotMatch(calls.join('\n'), /stableIdle=/u);
});
