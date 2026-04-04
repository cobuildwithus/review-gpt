import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const distCodexSessionLib = new URL('../dist/codex-session-lib.mjs', import.meta.url);
const distThreadLib = new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url);
const distWakeLib = new URL('../dist/chatgpt-thread-wake-lib.mjs', import.meta.url);
const sourceThreadLib = new URL('../src/chatgpt-thread-lib.mts', import.meta.url);

test('thread download keeps the hydrated tab alive, activates the DOM button directly, and falls back when the native file never appears', () => {
  const source = readFileSync(sourceThreadLib, 'utf8');
  const downloadFunction = source.match(/export async function downloadThreadAttachment[\s\S]*?\n\}/u)?.[0] ?? '';

  assert.equal(downloadFunction.length > 0, true);
  assert.doesNotMatch(downloadFunction, /await refreshTargetPage\(client\);/);
  assert.match(downloadFunction, /Keep the existing hydrated thread tab alive/);
  assert.match(downloadFunction, /const tryFetchArtifactFallback = async/u);
  assert.match(downloadFunction, /const fallbackDownloadedFile = await tryFetchArtifactFallback\(\);/u);
  assert.match(source, /const activated = await client\.evaluate<boolean>/u);
  assert.match(source, /const dispatchClickSequence = \(node\) =>/u);
  assert.match(source, /node\.click\(\)/u);
});

test('lists only conventional local Codex homes', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-homes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, '.codex'), { recursive: true });
  mkdirSync(path.join(root, '.codex-1'), { recursive: true });
  mkdirSync(path.join(root, '.codex-4'), { recursive: true });
  mkdirSync(path.join(root, '.codexbar'), { recursive: true });
  mkdirSync(path.join(root, 'not-codex'), { recursive: true });
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { listDefaultCodexHomes } = await import(distCodexSessionLib);
  const homes = listDefaultCodexHomes(root, path.join(root, '.codex-4'));

  assert.deepEqual(
    homes.map((homePath) => path.basename(homePath)),
    ['.codex', '.codex-1', '.codex-4'],
  );
});

test('lists default codex bins with explicit and nvm candidates first', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-bins-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const home = path.join(root, 'home');
  const explicit = path.join(root, 'explicit-codex');
  const pathBinDir = path.join(root, 'path-bin');
  const nodeBinDir = path.join(root, 'node-bin');
  const nvm24 = path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin');
  const nvm18 = path.join(home, '.nvm', 'versions', 'node', 'v18.16.1', 'bin');
  for (const target of [home, pathBinDir, nodeBinDir, nvm24, nvm18]) {
    mkdirSync(target, { recursive: true });
  }
  for (const filePath of [explicit, path.join(pathBinDir, 'codex'), path.join(nodeBinDir, 'codex'), path.join(nvm24, 'codex'), path.join(nvm18, 'codex')]) {
    writeFileSync(filePath, '#!/bin/sh\n');
    chmodSync(filePath, 0o755);
  }
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { listDefaultCodexBins, resolveCodexBin } = await import(distCodexSessionLib);
  const bins = listDefaultCodexBins(
    home,
    pathBinDir,
    explicit,
    path.join(nodeBinDir, 'node'),
  );

  assert.equal(bins[0], explicit);
  assert.equal(bins[1], path.join(pathBinDir, 'codex'));
  assert.equal(bins[2], path.join(nodeBinDir, 'codex'));
  assert.equal(bins[3], path.join(nvm24, 'codex'));
  assert.equal(bins[4], path.join(nvm18, 'codex'));
  assert.equal(resolveCodexBin({ candidateBins: bins }), explicit);
});

test('resolves a session owner from shell snapshots', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-owner-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const home1 = path.join(root, '.codex-1');
  const home2 = path.join(root, '.codex-2');
  mkdirSync(path.join(home1, 'shell_snapshots'), { recursive: true });
  mkdirSync(path.join(home2, 'shell_snapshots'), { recursive: true });
  writeFileSync(path.join(home1, 'shell_snapshots', `${sessionId}.123.sh`), '#!/bin/sh\n');
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { resolveCodexHomeForSession } = await import(distCodexSessionLib);
  const result = resolveCodexHomeForSession(sessionId, {
    candidateHomes: [home1, home2],
  });

  assert.equal(result.homePath, home1);
  assert.equal(result.resolution, 'discovered');
});

test('resolves a session owner from session logs when no shell snapshot exists', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-log-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const home = path.join(root, '.codex-3');
  mkdirSync(path.join(home, 'sessions', '2026', '03'), { recursive: true });
  writeFileSync(
    path.join(home, 'sessions', '2026', '03', 'rollout.jsonl'),
    `{"type":"thread.started","thread_id":"${sessionId}"}\n`,
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { resolveCodexHomeForSession } = await import(distCodexSessionLib);
  const result = resolveCodexHomeForSession(sessionId, {
    candidateHomes: [home],
  });

  assert.equal(result.homePath, home);
});

test('fails when a session appears in multiple Codex homes', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-ambiguous-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = '99999999-8888-7777-6666-555555555555';
  const home1 = path.join(root, '.codex-1');
  const home2 = path.join(root, '.codex-2');
  mkdirSync(path.join(home1, 'shell_snapshots'), { recursive: true });
  mkdirSync(path.join(home2, 'shell_snapshots'), { recursive: true });
  writeFileSync(path.join(home1, 'shell_snapshots', `${sessionId}.1.sh`), '#!/bin/sh\n');
  writeFileSync(path.join(home2, 'shell_snapshots', `${sessionId}.2.sh`), '#!/bin/sh\n');
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { resolveCodexHomeForSession } = await import(distCodexSessionLib);

  assert.throws(
    () =>
      resolveCodexHomeForSession(sessionId, {
        candidateHomes: [home1, home2],
      }),
    /appears in multiple Codex homes/,
  );
});

test('builds a wake follow-up prompt with repo-relative file references', async () => {
  const { buildWakeFollowupPrompt, parseWakeDelayToMs } = await import(distWakeLib);
  const repoDir = '/repo';
  const prompt = buildWakeFollowupPrompt({
    chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
    downloadedPatches: ['/repo/output-packages/chatgpt-watch/run/downloads/fix.patch'],
    exportPath: '/repo/output-packages/chatgpt-watch/run/thread.json',
    repoDir,
    resumePrompt:
      'After applying the patch, run pnpm review:gpt --send --chat-url {{chat_url}} against {{chat_id}} for a final bug and simplification pass.',
  });

  assert.match(prompt, /watched ChatGPT thread URL is https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/thread\.json/);
  assert.match(prompt, /downloads\/fix\.patch/);
  assert.match(prompt, /Additional instructions:/);
  assert.match(prompt, /pnpm review:gpt --send --chat-url https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
  assert.match(prompt, /against 69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
  assert.match(prompt, /final bug and simplification pass/);
  assert.equal(parseWakeDelayToMs('1h10m5s'), 4_205_000);
  assert.equal(parseWakeDelayToMs('0s'), 0);
});

test('extracts patch attachment labels from final assistant-turn artifacts', async () => {
  const { extractPatchAttachmentLabels } = await import(distThreadLib);
  const labels = extractPatchAttachmentLabels({
    attachmentButtons: [
      { href: null, tag: 'button', text: 'repo-context.zip', download: true },
      { href: 'https://chatgpt.com/c/older-patch-thread', tag: 'a', text: 'Behavior-preserving Simplification Patch' },
      { href: null, tag: 'button', text: 'previous.patch', insideAssistantMessage: true },
      {
        href: null,
        tag: 'button',
        text: 'Combined patch',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
      },
      {
        href: 'https://files.example.invalid/foo__SLASH__bar.patched',
        tag: 'a',
        text: 'Download',
        download: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
      },
      {
        href: null,
        tag: 'button',
        text: 'Download',
        download: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
      },
    ],
  });

  assert.deepEqual(labels, [
    'Combined patch',
    'foo__SLASH__bar.patched',
    'Download',
  ]);
});

test('falls back to earlier assistant patch labels when no final assistant artifacts exist', async () => {
  const { extractPatchAttachmentLabels } = await import(distThreadLib);
  const labels = extractPatchAttachmentLabels({
    attachmentButtons: [
      { href: null, tag: 'button', text: 'repo-context.zip', download: true },
      { href: null, tag: 'button', text: 'earlier.patch', insideAssistantMessage: true },
      { href: 'sandbox:/mnt/data/fix.diff', tag: 'a', text: 'download here', insideAssistantMessage: true },
    ],
  });

  assert.deepEqual(labels, [
    'earlier.patch',
    'fix.diff',
  ]);
});

test('ignores uploaded repo snapshot zips until an assistant attachment exists', async () => {
  const { extractPatchAttachmentLabels } = await import(distThreadLib);
  const labels = extractPatchAttachmentLabels({
    attachmentButtons: [
      { href: null, tag: 'button', text: 'repo.snapshot.zip', download: true },
    ],
  });

  assert.deepEqual(labels, []);
});

test('detects busy snapshots from stop controls or busy status text', async () => {
  const { snapshotIndicatesBusy, threadStatusTextIndicatesBusy } = await import(distThreadLib);

  assert.equal(threadStatusTextIndicatesBusy('Researching sources'), true);
  assert.equal(threadStatusTextIndicatesBusy('Done'), false);
  assert.equal(snapshotIndicatesBusy({ statusBusy: false, stopVisible: true }), true);
  assert.equal(snapshotIndicatesBusy({ statusBusy: true, stopVisible: false }), true);
  assert.equal(snapshotIndicatesBusy({ statusBusy: false, stopVisible: false }), false);
  assert.equal(snapshotIndicatesBusy(undefined), false);
});

test('requires real conversation signals before treating a thread as ready', async () => {
  const { threadContentHasMeaningfulSignals, threadContentLooksReady } = await import(distThreadLib);

  assert.equal(
    threadContentHasMeaningfulSignals({
      articleCount: 0,
      attachmentButtonCount: 0,
      bodyLength: 61,
      messageCount: 0,
    }),
    false,
  );
  assert.equal(
    threadContentLooksReady(
      {
        articleCount: 0,
        attachmentButtonCount: 0,
        bodyLength: 61,
        href: 'https://chatgpt.com/c/example',
        messageCount: 0,
        readyState: 'complete',
        title: 'Branch · Example thread',
      },
      'https://chatgpt.com/c/example',
    ),
    false,
  );
  assert.equal(
    threadContentLooksReady(
      {
        articleCount: 0,
        attachmentButtonCount: 0,
        bodyLength: 4000,
        href: 'https://chatgpt.com/c/example',
        messageCount: 3,
        readyState: 'complete',
        title: 'ChatGPT',
      },
      'https://chatgpt.com/c/example',
    ),
    true,
  );
});

test('thread export waits for the reload load event and not just a non-default title', () => {
  const source = readFileSync(sourceThreadLib, 'utf8');

  assert.match(source, /const loadEventPromise = client\.waitForEvent\(\(event\) => event\.method === 'Page\.loadEventFired'\);/u);
  assert.match(source, /await loadEventPromise;/u);
  assert.match(source, /return state\.href === chatUrl && state\.readyState === 'complete' && threadContentHasMeaningfulSignals\(state\);/u);
  assert.doesNotMatch(source, /state\.title !== 'ChatGPT'/u);
});

test('normalizes transient empty thread snapshots instead of crashing', async () => {
  const { hasThreadPayload, normalizeThreadSnapshot } = await import(distThreadLib);

  assert.equal(hasThreadPayload(undefined), false);
  assert.deepEqual(normalizeThreadSnapshot(undefined), {
    assistantSnapshots: [],
    attachmentButtons: [],
    bodyText: '',
    codeBlocks: [],
    href: '',
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
    title: '',
  });
});

test('wake summaries ignore static deep research labels', async () => {
  const { formatWakePollSummary } = await import(distWakeLib);

  const summary = formatWakePollSummary(
    {
      assistantSnapshots: [],
      statusBusy: false,
      statusTexts: ['Deep research', ''],
      stopVisible: true,
    },
    [],
  );

  assert.match(summary, /status=\"none\"/);
  assert.doesNotMatch(summary, /Deep research/);
});

test('runWakeFlow does not contact the browser until after the delay elapses', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 60_000,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        calls.push(`export:${outputPath}`);
        return {
          assistantSnapshots: [],
          attachmentButtons: [
            {
              href: null,
              tag: 'button',
              text: 'assistant.patch',
            },
          ],
          bodyText: '',
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
      },
      log: (_message) => {
        calls.push('log');
      },
      mkdir: async (targetPath) => {
        calls.push(`mkdir:${targetPath}`);
      },
      resolveCodexBin: () => {
        calls.push('codex-bin');
        return '/tmp/codex';
      },
      resolveCodexHomeForSession: (sessionId) => {
        calls.push(`resolve:${sessionId}`);
        return {
          homePath: '/tmp/.codex-1',
          resolution: 'discovered',
        };
      },
      runCodexChildSession: async (command, args, options) => {
        calls.push(`spawn:${command}:${args[0]}`);
        assert.equal(args[0], '-C');
        assert.equal(args[1], '/repo');
        assert.equal(typeof args.at(-1), 'string');
        assert.match(args.at(-1), /watched ChatGPT thread URL is https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
        assert.match(args.at(-1), /downloads\/assistant\.patch/);
        assert.equal(options?.env?.CODEX_HOME, '/tmp/.codex-1');
      },
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
        assert.deepEqual(calls, [
          'codex-bin',
          'resolve:019d36e3-f6a2-7873-910a-2bdbd4f9748c',
          'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
          'log',
          'sleep:60000',
        ]);
      },
      writeFile: async () => {},
    },
  );

  assert.deepEqual(calls, [
    'codex-bin',
    'resolve:019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
    'log',
    'sleep:60000',
    'export:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log',
    'download:assistant.patch',
    'spawn:/tmp/codex:-C',
  ]);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.childSessionId, undefined);
  assert.equal(result.completionStatus, 'completed');
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
  assert.equal(result.codexBin, '/tmp/codex');
  assert.equal(result.codexHome, '/tmp/.codex-1');
  assert.equal(result.eventsPath, undefined);
  assert.equal(result.resumeOutputPath, undefined);
  assert.equal(result.statusPath, '/repo/output-packages/chatgpt-watch/run/status.json');
});

test('runWakeFlow still supports the old one-shot mode when polling is disabled', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollUntilComplete: false,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        calls.push(`export:${outputPath}`);
        return {
          assistantSnapshots: [{ hasCopyButton: false, signature: 'working', text: 'still working' }],
          attachmentButtons: [{ href: null, tag: 'button', text: 'assistant.patch' }],
          bodyText: 'working',
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
          statusBusy: true,
          statusTexts: ['Researching sources'],
          stopVisible: true,
          title: 'Thread title',
        };
      },
      log: (_message) => {
        calls.push('log');
      },
      mkdir: async (targetPath) => {
        calls.push(`mkdir:${targetPath}`);
      },
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      runCodexChildSession: async (command, args) => {
        calls.push(`spawn:${command}:${args[0]}`);
      },
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.deepEqual(calls, [
    'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
    'log',
    'sleep:0',
    'export:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log',
    'download:assistant.patch',
    'spawn:/tmp/codex:-C',
  ]);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.completionStatus, 'checked-once');
});

test('runWakeFlow polls until a busy thread becomes idle', async () => {
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
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}`);
        if (exportCount === 1) {
          return {
            assistantSnapshots: [{ hasCopyButton: false, signature: 'working', text: 'still working' }],
            attachmentButtons: [],
            bodyText: '',
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
            statusBusy: true,
            statusTexts: ['Researching sources'],
            stopVisible: true,
            title: 'Thread title',
          };
        }
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
          attachmentButtons: [{ href: null, tag: 'button', text: 'assistant.patch' }],
          bodyText: 'done',
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
          statusTexts: ['Done'],
          stopVisible: false,
          title: 'Thread title',
        };
      },
      log: (message) => {
        calls.push(`log:${message.includes('Polling: enabled') ? 'setup' : 'check'}`);
      },
      mkdir: async (targetPath) => {
        calls.push(`mkdir:${targetPath}`);
      },
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      runCodexChildSession: async (command, args) => {
        calls.push(`spawn:${command}:${args[0]}`);
      },
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.deepEqual(calls, [
    'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
    'log:setup',
    'sleep:0',
    'export:1:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log:check',
    'log:check',
    'sleep:60000',
    'export:2:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log:check',
    'download:assistant.patch',
    'spawn:/tmp/codex:-C',
  ]);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.completionStatus, 'completed');
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
});

test('runWakeFlow uses jittered polling delays when enabled', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];
  let exportCount = 0;

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 60_000,
      pollIntervalMs: 60_000,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}`);
        return exportCount === 1
          ? {
              assistantSnapshots: [{ hasCopyButton: false, signature: 'working', text: 'still working' }],
              attachmentButtons: [],
              bodyText: '',
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
              statusBusy: true,
              statusTexts: ['Writing code'],
              stopVisible: true,
              title: 'Thread title',
            }
          : {
              assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
              attachmentButtons: [{ href: null, tag: 'button', text: 'assistant.patch' }],
              bodyText: 'done',
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
              statusTexts: ['Done'],
              stopVisible: false,
              title: 'Thread title',
            };
      },
      log: (message) => {
        calls.push(message);
      },
      mkdir: async () => {},
      random: () => 0.5,
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      runCodexChildSession: async () => {},
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 2);
  assert.match(calls.join('\n'), /Polling: enabled \(60000ms interval, \+0-60000ms jitter, 3 transient export retries\)/u);
  assert.match(calls.join('\n'), /Thread still looks busy; polling again in 90000ms \(60000ms base \+ up to 60000ms jitter\)\./u);
  assert.match(calls.join('\n'), /sleep:90000/u);
});

test('runWakeFlow retries transient export failures while polling', async () => {
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
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}`);
        if (exportCount < 3) {
          throw new Error(`Timed out waiting for ChatGPT thread content (attempt ${exportCount})`);
        }
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
          attachmentButtons: [{ href: null, tag: 'button', text: 'assistant.patch' }],
          bodyText: 'done',
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
      runCodexChildSession: async () => {},
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 3);
  assert.match(calls.join('\n'), /Wake check 1: export failed \(1\/3 transient retries used\): Timed out waiting for ChatGPT thread content \(attempt 1\)\./u);
  assert.match(calls.join('\n'), /Wake check 2: export failed \(2\/3 transient retries used\): Timed out waiting for ChatGPT thread content \(attempt 2\)\./u);
  assert.match(calls.join('\n'), /Thread export failed; polling again in 60000ms\./u);
  assert.equal(calls.filter((entry) => entry === 'sleep:60000').length, 2);
});

test('runWakeFlow fails after repeated transient export failures', async () => {
  const { runWakeFlow } = await import(distWakeLib);

  await assert.rejects(
    () =>
      runWakeFlow(
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
          downloadThreadAttachment: async () => {
            throw new Error('should not download');
          },
          exportThreadSnapshot: async () => {
            throw new Error('Timed out waiting for ChatGPT thread content');
          },
          log: () => {},
          mkdir: async () => {},
          resolveCodexBin: () => '/tmp/codex',
          resolveCodexHomeForSession: () => ({
            homePath: '/tmp/.codex-1',
            resolution: 'discovered',
          }),
          runCodexChildSession: async () => {},
          sleep: async () => {},
          writeFile: async () => {},
        },
      ),
    /Failed to export https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536 after 3 consecutive polling errors/u,
  );
});
