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

test('runWakeFlow closes the exact wake-created target when export fails', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  await assert.rejects(
    runWakeFlow(
      {
        chatUrl: 'https://chatgpt.com/c/example-thread',
        delayMs: 0,
        outputDir: '/repo/output-packages/chatgpt-watch/run',
        pollJitterMs: 0,
        pollIntervalMs: 60_000,
        repoDir: '/repo',
        skipResume: true,
        tabLifecycle: 'close-harvested',
      },
      {
        closeTarget: async (_browserEndpoint, targetId) => {
          calls.push(`close:${targetId}`);
        },
        closeThreadTarget: async () => {
          calls.push('close-by-url');
          return true;
        },
        downloadThreadAttachment: async () => {
          throw new Error('no artifact should be downloaded');
        },
        exportThreadSnapshot: async (_browserEndpoint, _chatUrl, _outputPath, options) => {
          options?.onTargetLease?.({
            created: true,
            target: {
              id: 'wake-created-target',
              type: 'page',
              url: 'https://chatgpt.com/c/example-thread',
              webSocketDebuggerUrl: 'ws://example.test/devtools/page/wake-created-target',
            },
          });
          throw new Error('export failed');
        },
        log: () => {},
        mkdir: async () => {},
        random: () => 0,
        sleep: async () => {},
        writeFile: async () => {},
      },
    ),
    /export failed/u,
  );

  assert.deepEqual(calls, ['close:wake-created-target']);
});

test('runWakeFlow preserves a reused thread target when export fails', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  await assert.rejects(
    runWakeFlow(
      {
        chatUrl: 'https://chatgpt.com/c/example-thread',
        delayMs: 0,
        outputDir: '/repo/output-packages/chatgpt-watch/run',
        pollJitterMs: 0,
        pollIntervalMs: 60_000,
        repoDir: '/repo',
        skipResume: true,
        tabLifecycle: 'close-harvested',
      },
      {
        closeTarget: async (_browserEndpoint, targetId) => {
          calls.push(`close:${targetId}`);
        },
        closeThreadTarget: async () => {
          calls.push('close-by-url');
          return true;
        },
        downloadThreadAttachment: async () => {
          throw new Error('no artifact should be downloaded');
        },
        exportThreadSnapshot: async (_browserEndpoint, _chatUrl, _outputPath, options) => {
          options?.onTargetLease?.({
            created: false,
            target: {
              id: 'existing-sent-target',
              type: 'page',
              url: 'https://chatgpt.com/c/example-thread',
              webSocketDebuggerUrl: 'ws://example.test/devtools/page/existing-sent-target',
            },
          });
          throw new Error('export failed');
        },
        log: () => {},
        mkdir: async () => {},
        random: () => 0,
        sleep: async () => {},
        writeFile: async () => {},
      },
    ),
    /export failed/u,
  );

  assert.deepEqual(calls, []);
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
