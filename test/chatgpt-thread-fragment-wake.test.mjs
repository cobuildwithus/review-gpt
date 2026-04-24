import assert from 'node:assert/strict';
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
