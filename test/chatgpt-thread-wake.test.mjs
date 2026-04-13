import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const distCodexSessionLib = new URL('../dist/codex-session-lib.mjs', import.meta.url);
const distThreadLib = new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url);
const distWakeLib = new URL('../dist/chatgpt-thread-wake-lib.mjs', import.meta.url);
const sourceThreadLib = new URL('../src/chatgpt-thread-lib.mts', import.meta.url);
const sourceWakeLib = new URL('../src/chatgpt-thread-wake-lib.mts', import.meta.url);

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

test('wake launcher hands off after the child starts instead of waiting for the resumed session to exit', () => {
  const source = readFileSync(sourceWakeLib, 'utf8');

  assert.match(source, /const DEFAULT_CHILD_LAUNCH_TIMEOUT_MS = 15_000/u);
  assert.match(source, /const DEFAULT_CHILD_SESSION_POLL_MS = 250/u);
  assert.match(source, /const childArgs = \['exec', '--json', '--output-last-message'/u);
  assert.match(source, /childSessionPersistence: homeContainsSession\(codexHome, childSessionId\) \? 'verified' : 'pending'/u);
  assert.match(source, /if \(childSessionId && sawTurnStarted\)/u);
  assert.doesNotMatch(source, /if \(childSessionId && homeContainsSession\(options\.codexHome, childSessionId\) && sawTurnStarted\)/u);
  assert.match(source, /homeContainsSession\(codexHome, childSessionId\)/u);
  assert.match(source, /type === 'thread\.started'/u);
  assert.match(source, /type === 'turn\.started'/u);
  assert.match(source, /child\.unref\(\)/u);
  assert.match(source, /did not produce launch events/u);
  assert.match(source, /exited before handoff/u);
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
    path.join(home, 'sessions', '2026', '03', `rollout-2026-03-01T00-00-00-${sessionId}.jsonl`),
    `{"timestamp":"2026-03-01T00:00:00.000Z","type":"session_meta","payload":{"id":"${sessionId}"}}\n`,
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { resolveCodexHomeForSession } = await import(distCodexSessionLib);
  const result = resolveCodexHomeForSession(sessionId, {
    candidateHomes: [home],
  });

  assert.equal(result.homePath, home);
});

test('resolves a session owner from history when no shell snapshot or session log exists', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-history-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = '12121212-3434-5656-7878-909090909090';
  const home = path.join(root, '.codex-7');
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, 'history.jsonl'),
    `{"session_id":"${sessionId}","ts":1775511287,"text":"Wake-up task:\\n- Example"}\n`,
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { resolveCodexHomeForSession } = await import(distCodexSessionLib);
  const result = resolveCodexHomeForSession(sessionId, {
    candidateHomes: [home],
  });

  assert.equal(result.homePath, home);
});

test('finds new Codex session logs and matches the seeded wake prompt text', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-session-log-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const home = path.join(root, '.codex-5');
  const logPath = path.join(home, 'sessions', '2026', '04', `rollout-2026-04-06T00-00-00-${sessionId}.jsonl`);
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(
    logPath,
    `{"timestamp":"2026-04-06T00:00:00.000Z","type":"session_meta","payload":{"id":"${sessionId}"}}\n` +
      `{"timestamp":"2026-04-06T00:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"Wake-up task:\\n- The watched ChatGPT thread URL is https://chatgpt.com/c/example."}}\n`,
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { listCodexSessionLogs, sessionLogContainsUserText } = await import(distCodexSessionLib);
  const logs = listCodexSessionLogs(home);

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.sessionId, sessionId);
  assert.equal(sessionLogContainsUserText(logPath, 'Wake-up task:'), true);
  assert.equal(sessionLogContainsUserText(logPath, 'nonexistent prompt'), false);
});

test('finds new Codex session history and matches the seeded wake prompt text', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-history-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = 'abababab-cdef-1234-5678-abcdefabcdef';
  const home = path.join(root, '.codex-8');
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, 'history.jsonl'),
    `{"session_id":"${sessionId}","ts":1775511287,"text":"Wake-up task:\\n- The watched ChatGPT thread URL is https://chatgpt.com/c/example."}\n`,
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { listCodexSessionEvidence, sessionEvidenceContainsUserText } = await import(distCodexSessionLib);
  const evidence = listCodexSessionEvidence(home);
  const historyRecord = evidence.find((record) => record.sessionId === sessionId && record.source === 'history');

  assert.ok(historyRecord);
  assert.equal(sessionEvidenceContainsUserText(historyRecord, 'Wake-up task:'), true);
  assert.equal(sessionEvidenceContainsUserText(historyRecord, 'nonexistent prompt'), false);
});

test('ignores session-id mentions in unrelated session transcripts when resolving a home', async (t) => {
  const root = path.join(tmpdir(), `review-gpt-codex-false-positive-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const ownedSessionId = '11111111-aaaa-bbbb-cccc-222222222222';
  const unrelatedSessionId = '99999999-8888-7777-6666-555555555555';
  const owningHome = path.join(root, '.codex-3');
  const mentioningHome = path.join(root, '.codex-4');
  mkdirSync(path.join(owningHome, 'sessions', '2026', '04'), { recursive: true });
  mkdirSync(path.join(mentioningHome, 'sessions', '2026', '04'), { recursive: true });
  writeFileSync(
    path.join(owningHome, 'sessions', '2026', '04', `rollout-2026-04-05T00-00-00-${ownedSessionId}.jsonl`),
    `{"timestamp":"2026-04-05T00:00:00.000Z","type":"session_meta","payload":{"id":"${ownedSessionId}"}}\n`,
  );
  writeFileSync(
    path.join(mentioningHome, 'sessions', '2026', '04', `rollout-2026-04-05T00-00-00-${unrelatedSessionId}.jsonl`),
    `{"timestamp":"2026-04-05T00:00:00.000Z","type":"session_meta","payload":{"id":"${unrelatedSessionId}"}}\n{"timestamp":"2026-04-05T00:01:00.000Z","type":"response_item","payload":{"type":"message","content":"ps output mentioned --session-id ${ownedSessionId}"}}\n`,
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const { findMatchingCodexHomes, resolveCodexHomeForSession } = await import(distCodexSessionLib);
  const matches = findMatchingCodexHomes(ownedSessionId, [owningHome, mentioningHome]);
  const result = resolveCodexHomeForSession(ownedSessionId, {
    candidateHomes: [owningHome, mentioningHome],
  });

  assert.deepEqual(matches, [owningHome]);
  assert.equal(result.homePath, owningHome);
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
    artifactLabels: ['Unified patch'],
    chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
    downloadedArtifacts: ['/repo/output-packages/chatgpt-watch/run/downloads/fix.patch'],
    downloadErrors: [],
    exportPath: '/repo/output-packages/chatgpt-watch/run/thread.json',
    replayCommandsPath: '/repo/output-packages/chatgpt-watch/run/wake-commands.sh',
    recursive: {
      descendantOutputDir: '/repo/output-packages/chatgpt-watch/run/recursive-depth-0',
      descendantStatusPath: '/repo/output-packages/chatgpt-watch/run/recursive-depth-0/status.json',
      descendantWakeLaunchPath: '/repo/output-packages/chatgpt-watch/run/recursive-next-wake-launch.json',
      descendantWakeLogPath: '/repo/output-packages/chatgpt-watch/run/recursive-next-wake.log',
      followupReceiptPath: '/repo/output-packages/chatgpt-watch/run/recursive-followup.json',
      followupScriptPath: '/repo/output-packages/chatgpt-watch/run/recursive-followup.sh',
      nextDepth: 0,
      requestedDepth: 1,
      reviewSendLogPath: '/repo/output-packages/chatgpt-watch/run/recursive-review-send.log',
      reviewTimeoutMs: 300_000,
    },
    repoDir,
    resumePrompt:
      'After applying the patch, run pnpm review:gpt --send --chat-url {{chat_url}} against {{chat_id}} for a final bug and simplification pass.',
  });

  assert.match(prompt, /watched ChatGPT thread URL is https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/thread\.json/);
  assert.match(prompt, /downloads\/fix\.patch/);
  assert.match(prompt, /bash output-packages\/chatgpt-watch\/run\/wake-commands\.sh instead of pnpm exec/);
  assert.match(prompt, /Additional instructions:/);
  assert.match(prompt, /pnpm review:gpt --send --chat-url https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
  assert.match(prompt, /against 69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
  assert.match(prompt, /final bug and simplification pass/);
  assert.match(prompt, /Recursive same-thread review flow:/);
  assert.match(prompt, /Recursive depth remaining after this wake handoff: 1\./);
  assert.match(prompt, /Do not use --prompt-only\./);
  assert.match(prompt, /bash output-packages\/chatgpt-watch\/run\/recursive-followup\.sh/u);
  assert.match(prompt, /explicit 300000ms send timeout/u);
  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/recursive-review-send\.log/u);
  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/recursive-followup\.json/u);
  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/recursive-depth-0/u);
  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/recursive-next-wake-launch\.json/u);
  assert.match(prompt, /stop without sending another review request\./);
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
        text: 'combined.patch',
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
    'combined.patch',
    'foo__SLASH__bar.patched',
  ]);
});

test('extracts assistant artifact labels only from filename-shaped final assistant attachments', async () => {
  const { extractAssistantArtifactLabels } = await import(distThreadLib);
  const labels = extractAssistantArtifactLabels({
    attachmentButtons: [
      { href: null, tag: 'button', text: 'repo.snapshot.zip', download: false, afterLastUserMessage: true },
      {
        href: null,
        tag: 'button',
        text: 'murph-review.patch',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
      {
        href: null,
        tag: 'button',
        text: 'Changed files zip',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
      {
        href: null,
        tag: 'button',
        text: 'followup-files.zip',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
    ],
  });

  assert.deepEqual(labels, [
    'murph-review.patch',
    'followup-files.zip',
  ]);
});

test('hydrates final assistant download controls from transcript markdown patch links', async () => {
  const {
    extractAssistantArtifactLabels,
    extractAssistantDownloadTargets,
    snapshotHasPatchArtifacts,
    snapshotIndicatesBusy,
  } = await import(distThreadLib);
  const snapshot = {
    attachmentButtons: [
      {
        href: null,
        tag: 'button',
        text: 'Download the patch',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
    ],
    assistantSnapshots: [
      {
        hasCopyButton: true,
        signature: 'download the patch changed apps cloudflare only',
        text: 'Download the patch\n\nChanged apps/cloudflare only.',
        afterLastUserMessage: true,
      },
    ],
    bodyText:
      '[Download the patch](sandbox:/mnt/data/murph_code_quality_audit.patch)\n\nChanged apps/cloudflare only.',
    statusBusy: false,
    stopVisible: false,
  };

  assert.deepEqual(extractAssistantArtifactLabels(snapshot), [
    'murph_code_quality_audit.patch',
  ]);
  assert.deepEqual(extractAssistantDownloadTargets(snapshot), [
    {
      artifactIndex: 0,
      href: 'sandbox:/mnt/data/murph_code_quality_audit.patch',
      label: 'murph_code_quality_audit.patch',
    },
  ]);
  assert.equal(snapshotHasPatchArtifacts(snapshot), true);
  assert.equal(snapshotIndicatesBusy(snapshot), false);
});

test('keeps final assistant download controls actionable even when no filename is exposed yet', async () => {
  const {
    extractAssistantArtifactLabels,
    extractAssistantDownloadTargets,
    snapshotHasAssistantArtifacts,
    snapshotHasPatchArtifacts,
    snapshotIndicatesBusy,
  } = await import(distThreadLib);
  const snapshot = {
    attachmentButtons: [
      {
        href: null,
        tag: 'button',
        text: 'Download the patch',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
    ],
    assistantSnapshots: [
      {
        hasCopyButton: true,
        signature: 'download the patch changed apps cloudflare only',
        text: 'Download the patch\n\nChanged apps/cloudflare only.',
        afterLastUserMessage: true,
      },
    ],
    statusBusy: false,
    stopVisible: false,
  };

  assert.deepEqual(extractAssistantArtifactLabels(snapshot), []);
  assert.deepEqual(extractAssistantDownloadTargets(snapshot), [
    {
      artifactIndex: 0,
      href: null,
      label: 'Download the patch',
    },
  ]);
  assert.equal(snapshotHasAssistantArtifacts(snapshot), true);
  assert.equal(snapshotHasPatchArtifacts(snapshot), false);
  assert.equal(snapshotIndicatesBusy(snapshot), false);
});

test('extracts assistant download targets from concrete assistant controls and ignores unlabeled generic zip buttons', async () => {
  const { extractAssistantDownloadTargets } = await import(distThreadLib);
  const targets = extractAssistantDownloadTargets({
    attachmentButtons: [
      {
        href: null,
        tag: 'button',
        text: 'Changed files zip',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
      {
        href: 'sandbox:/mnt/data/murph-knowledge-boundary-direct-owner.patch',
        tag: 'a',
        text: 'Download the patch',
        insideAssistantMessage: true,
        insideFinalAssistantMessage: true,
        afterLastUserMessage: true,
      },
    ],
  });

  assert.deepEqual(targets, [
    {
      artifactIndex: 0,
      href: 'sandbox:/mnt/data/murph-knowledge-boundary-direct-owner.patch',
      label: 'murph-knowledge-boundary-direct-owner.patch',
    },
  ]);
});

test('ignores generic assistant controls that are not filename-shaped attachments', async () => {
  const { extractAssistantArtifactLabels, snapshotHasAssistantArtifacts, snapshotIndicatesBusy } = await import(distThreadLib);
  const snapshot = {
    attachmentButtons: [
      {
        href: null,
        tag: 'button',
        text: 'Inspecting and modifying test file snippet',
        behaviorButton: true,
        insideAssistantMessage: true,
        insideFinalAssistantMessage: false,
        afterLastUserMessage: true,
      },
    ],
    assistantSnapshots: [
      {
        hasCopyButton: true,
        signature: 'device-sync hardening',
        text: 'I found three concrete hardening changes in this seam.',
        afterLastUserMessage: true,
      },
    ],
    statusBusy: false,
    stopVisible: true,
  };

  assert.deepEqual(extractAssistantArtifactLabels(snapshot), []);
  assert.equal(snapshotHasAssistantArtifacts(snapshot), false);
  assert.equal(snapshotIndicatesBusy(snapshot), true);
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

test('ignores assistant patch attachments from before the latest user turn', async () => {
  const { extractPatchAttachmentLabels, snapshotHasPatchArtifacts, snapshotIndicatesBusy } = await import(distThreadLib);
  const snapshot = {
    attachmentButtons: [
      { href: null, tag: 'button', text: 'earlier.patch', insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: false },
      { href: null, tag: 'button', text: 'repo.snapshot.zip', download: true, afterLastUserMessage: true },
    ],
    assistantSnapshots: [
      { hasCopyButton: true, signature: 'previous patch', text: 'Patch: earlier.patch', afterLastUserMessage: false },
    ],
    patchMarkers: {
      addFile: false,
      beginPatch: false,
      deleteFile: false,
      diffGit: false,
      updateFile: false,
    },
    statusBusy: false,
    stopVisible: true,
  };

  assert.deepEqual(extractPatchAttachmentLabels(snapshot), []);
  assert.equal(snapshotHasPatchArtifacts(snapshot), false);
  assert.equal(snapshotIndicatesBusy(snapshot), true);
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

test('detects busy snapshots from stop controls, fragment turns, or busy status text', async () => {
  const { snapshotBusyReason, snapshotHasAssistantArtifacts, snapshotHasPatchArtifacts, snapshotIndicatesBusy, threadStatusTextIndicatesBusy } = await import(distThreadLib);

  assert.equal(threadStatusTextIndicatesBusy('Researching sources'), true);
  assert.equal(threadStatusTextIndicatesBusy('Done'), false);
  assert.equal(
    snapshotIndicatesBusy({
      assistantSnapshots: [{ hasCopyButton: false, signature: 'i', text: 'I', afterLastUserMessage: true }],
      attachmentButtons: [],
      statusBusy: false,
      stopVisible: false,
    }),
    true,
  );
  assert.equal(snapshotIndicatesBusy({ statusBusy: false, stopVisible: true }), true);
  assert.equal(
    snapshotBusyReason({
      assistantSnapshots: [{ hasCopyButton: true, signature: 'working', text: 'still packaging patch', afterLastUserMessage: true }],
      attachmentButtons: [],
      statusBusy: false,
      stopVisible: true,
    }),
    'stop-visible',
  );
  assert.equal(
    snapshotHasAssistantArtifacts({
      attachmentButtons: [
        {
          behaviorButton: true,
          href: null,
          insideAssistantMessage: true,
          insideFinalAssistantMessage: true,
          tag: 'button',
          text: 'assistant.patch',
          afterLastUserMessage: true,
        },
      ],
    }),
    true,
  );
  assert.equal(
    snapshotHasPatchArtifacts({
      attachmentButtons: [
        {
          behaviorButton: true,
          href: null,
          insideAssistantMessage: true,
          insideFinalAssistantMessage: true,
          tag: 'button',
          text: 'assistant.patch',
        },
      ],
      statusBusy: false,
      stopVisible: true,
    }),
    true,
  );
  assert.equal(
    snapshotIndicatesBusy({
      attachmentButtons: [
        {
          behaviorButton: true,
          href: null,
          insideAssistantMessage: true,
          insideFinalAssistantMessage: true,
          tag: 'button',
          text: 'Changed files zip',
        },
      ],
      statusBusy: false,
      stopVisible: true,
    }),
    true,
  );
  assert.equal(
    snapshotIndicatesBusy({
      attachmentButtons: [
        {
          behaviorButton: true,
          href: null,
          insideAssistantMessage: true,
          insideFinalAssistantMessage: true,
          tag: 'button',
          text: 'assistant.patch',
        },
      ],
      statusBusy: false,
      stopVisible: true,
    }),
    false,
  );
  assert.equal(snapshotIndicatesBusy({ statusBusy: true, stopVisible: false }), true);
  assert.equal(snapshotIndicatesBusy({ statusBusy: false, stopVisible: false }), false);
  assert.equal(snapshotIndicatesBusy(undefined), false);
});

test('requires real conversation signals before treating a thread as ready', async () => {
  const {
    conversationUrlsReferToSameThread,
    pickBestThreadTarget,
    threadContentHasMeaningfulSignals,
    threadContentLooksReady,
  } = await import(distThreadLib);

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
    conversationUrlsReferToSameThread(
      'https://chatgpt.com/c/example?model=gpt-5.4-pro',
      'https://chatgpt.com/c/example',
    ),
    true,
  );
  assert.deepEqual(
    pickBestThreadTarget(
      [
        {
          type: 'page',
          url: 'https://chatgpt.com/',
          webSocketDebuggerUrl: 'ws://root',
        },
        {
          type: 'page',
          url: 'https://chatgpt.com/c/example?model=gpt-5.4-pro',
          webSocketDebuggerUrl: 'ws://same-chat',
        },
        {
          type: 'page',
          url: 'https://chatgpt.com/c/different',
          webSocketDebuggerUrl: 'ws://different-chat',
        },
      ],
      'https://chatgpt.com/c/example',
    ),
    {
      type: 'page',
      url: 'https://chatgpt.com/c/example?model=gpt-5.4-pro',
      webSocketDebuggerUrl: 'ws://same-chat',
    },
  );
  assert.equal(
    pickBestThreadTarget(
      [
        {
          type: 'page',
          url: 'https://chatgpt.com/',
          webSocketDebuggerUrl: 'ws://root',
        },
      ],
      'https://chatgpt.com/c/example',
    ),
    null,
  );
  assert.equal(
    threadContentLooksReady(
      {
        articleCount: 0,
        attachmentButtonCount: 0,
        bodyLength: 4000,
        href: 'https://chatgpt.com/c/example?model=gpt-5.4-pro',
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
  assert.match(source, /return conversationUrlsReferToSameThread\(state\.href, chatUrl\) && state\.readyState === 'complete' && threadContentHasMeaningfulSignals\(state\);/u);
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
      pollJitterMs: 0,
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
              behaviorButton: true,
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
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async (command, args, options) => {
        calls.push(`spawn:${command}:${args[0]}`);
        assert.equal(args[0], 'exec');
        assert.equal(args[1], '--json');
        assert.equal(args[2], '--output-last-message');
        assert.equal(args[3], '/repo/output-packages/chatgpt-watch/run/child-last-message.txt');
        assert.equal(args[4], '-C');
        assert.equal(args[5], '/repo');
        assert.equal(typeof args.at(-1), 'string');
        assert.match(args.at(-1), /watched ChatGPT thread URL is https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536/u);
        assert.match(args.at(-1), /downloads\/assistant\.patch/);
        assert.equal(options?.env?.CODEX_HOME, '/tmp/.codex-1');
        assert.equal(options?.eventsPath, '/repo/output-packages/chatgpt-watch/run/child-events.jsonl');
        assert.equal(options?.stderrPath, '/repo/output-packages/chatgpt-watch/run/child-stderr.log');
      },
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
        assert.deepEqual(calls, [
          'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
          'codex-bin',
          'resolve:019d36e3-f6a2-7873-910a-2bdbd4f9748c',
          'log',
          'sleep:60000',
        ]);
      },
      writeFile: async () => {},
    },
  );

  assert.deepEqual(calls, [
    'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
    'codex-bin',
    'resolve:019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    'log',
    'sleep:60000',
    'export:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log',
    'log',
    'download:assistant.patch',
    'log',
    'spawn:/tmp/codex:exec',
    'log',
  ]);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.childSessionId, undefined);
  assert.equal(result.childRolloutPath, undefined);
  assert.equal(result.completionStatus, 'completed');
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
  assert.equal(result.codexBin, '/tmp/codex');
  assert.equal(result.codexHome, '/tmp/.codex-1');
  assert.equal(result.eventsPath, '/repo/output-packages/chatgpt-watch/run/child-events.jsonl');
  assert.equal(result.replayCommandsPath, '/repo/output-packages/chatgpt-watch/run/wake-commands.sh');
  assert.equal(result.resumeOutputPath, '/repo/output-packages/chatgpt-watch/run/child-last-message.txt');
  assert.equal(result.stderrPath, '/repo/output-packages/chatgpt-watch/run/child-stderr.log');
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
          attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      resolveExpectBin: () => '/tmp/expect',
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
    'log',
    'download:assistant.patch',
    'log',
    'spawn:/tmp/codex:exec',
    'log',
  ]);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.completionStatus, 'checked-once');
  assert.equal(result.replayCommandsPath, '/repo/output-packages/chatgpt-watch/run/wake-commands.sh');
});

test('runWakeFlow writes direct replay commands that bypass consumer-repo pnpm exec', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const writes = new Map();

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollUntilComplete: false,
      repoDir: '/repo',
      skipResume: true,
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) =>
        `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`,
      exportThreadSnapshot: async () => ({
        assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
        attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      }),
      log: () => {},
      mkdir: async () => {},
      sleep: async () => {},
      writeFile: async (targetPath, content) => {
        writes.set(targetPath, content);
      },
    },
  );

  const commands = writes.get('/repo/output-packages/chatgpt-watch/run/wake-commands.sh');
  const status = JSON.parse(writes.get('/repo/output-packages/chatgpt-watch/run/status.json'));

  assert.equal(result.replayCommandsPath, '/repo/output-packages/chatgpt-watch/run/wake-commands.sh');
  assert.match(commands, /'thread' 'export'/u);
  assert.match(commands, /'thread' 'download'/u);
  assert.match(commands, /--artifact-index/u);
  assert.match(commands, /assistant\.patch/u);
  assert.doesNotMatch(commands, /pnpm exec/u);
  assert.equal(status.state, 'succeeded');
  assert.equal(status.replayCommandsPath, '/repo/output-packages/chatgpt-watch/run/wake-commands.sh');
});

test('runWakeFlow writes recursive helper artifacts and deterministic descendant metadata', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const writes = new Map();

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollUntilComplete: false,
      recursiveDepth: 1,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText, _outputDir, _timeoutMs) =>
        `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`,
      exportThreadSnapshot: async () => ({
        assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
        attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      }),
      log: () => {},
      mkdir: async () => {},
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      runCodexChildSession: async (_command, args) => {
        assert.match(args.at(-1), /bash output-packages\/chatgpt-watch\/run\/recursive-followup\.sh/u);
        return {};
      },
      sleep: async () => {},
      writeFile: async (targetPath, content) => {
        writes.set(targetPath, content);
      },
    },
  );

  const script = writes.get('/repo/output-packages/chatgpt-watch/run/recursive-followup.sh');
  const status = JSON.parse(writes.get('/repo/output-packages/chatgpt-watch/run/status.json'));

  assert.equal(result.recursive?.requestedDepth, 1);
  assert.equal(result.recursive?.nextDepth, 0);
  assert.equal(result.recursive?.descendantOutputDir, '/repo/output-packages/chatgpt-watch/run/recursive-depth-0');
  assert.equal(result.recursive?.followupScriptPath, '/repo/output-packages/chatgpt-watch/run/recursive-followup.sh');
  assert.equal(status.recursive.followupReceiptPath, '/repo/output-packages/chatgpt-watch/run/recursive-followup.json');
  assert.equal(status.recursive.reviewTimeoutMs, 300000);
  assert.match(script, /--timeout' '300000ms'/u);
  assert.match(script, /recursive-review-send\.log/u);
  assert.match(script, /recursive-next-wake-launch\.json/u);
  assert.match(script, /--output-dir' '\/repo\/output-packages\/chatgpt-watch\/run\/recursive-depth-0'/u);
  assert.match(script, /--repo-dir' '\/repo'/u);
});

test('runWakeFlow writes a failed status file when resume preflight fails before polling', async (t) => {
  const { runWakeFlow } = await import(distWakeLib);
  const outputDir = path.join(tmpdir(), `review-gpt-wake-status-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  t.after(() => rmSync(outputDir, { force: true, recursive: true }));

  await assert.rejects(
    () =>
      runWakeFlow(
        {
          chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
          delayMs: 0,
          outputDir,
          pollJitterMs: 0,
          pollUntilComplete: false,
          repoDir: '/repo',
          sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
        },
        {
          log: () => {},
          resolveCodexBin: () => '/tmp/codex',
          resolveCodexHomeForSession: () => {
            throw new Error('Session appears in multiple Codex homes');
          },
          resolveExpectBin: () => '/tmp/expect',
        },
      ),
    /appears in multiple Codex homes/u,
  );

  const status = JSON.parse(readFileSync(path.join(outputDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /appears in multiple Codex homes/u);
  assert.equal(status.exportPath, path.join(outputDir, 'thread.json'));
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
          attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      resolveExpectBin: () => '/tmp/expect',
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
    'log:check',
    'download:assistant.patch',
    'log:check',
    'spawn:/tmp/codex:exec',
    'log:check',
  ]);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.completionStatus, 'completed');
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
});

test('runWakeFlow requires a stable terminal idle snapshot before completing without artifacts', async () => {
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
      skipResume: true,
    },
    {
      downloadThreadAttachment: async () => {
        throw new Error('no artifact should be downloaded');
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}`);
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'all-done', text: 'All done.' }],
          attachmentButtons: [],
          bodyText: 'All done.',
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
        calls.push(
          `log:${message.includes('stableIdle=2/2') ? 'stable-2' : message.includes('staleSnapshot=1/3') ? 'stale-1' : 'other'}`,
        );
      },
      mkdir: async (targetPath) => {
        calls.push(`mkdir:${targetPath}`);
      },
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.deepEqual(calls, [
    'mkdir:/repo/output-packages/chatgpt-watch/run/downloads',
    'log:other',
    'sleep:0',
    'export:1:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log:stale-1',
    'log:other',
    'sleep:60000',
    'export:2:/repo/output-packages/chatgpt-watch/run/thread.json',
    'log:stable-2',
  ]);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.completionStatus, 'completed');
  assert.deepEqual(result.downloadedPatches, []);
});

test('runWakeFlow ignores stale assistant patches from before the latest user turn', async () => {
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
            assistantSnapshots: [{ hasCopyButton: true, signature: 'previous patch', text: 'Patch: earlier.patch', afterLastUserMessage: false }],
            attachmentButtons: [{ href: null, tag: 'button', text: 'earlier.patch', insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: false }],
            bodyText: 'Patch: earlier.patch',
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
            stopVisible: true,
            title: 'Thread title',
          };
        }
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done', afterLastUserMessage: true }],
          attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch', insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true }],
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
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async () => {},
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 2);
  assert.equal(calls.includes('download:earlier.patch'), false);
  assert.equal(calls.includes('download:assistant.patch'), true);
  assert.match(calls.join('\n'), /Wake check 1: busy=yes, attachments=0/u);
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
              attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async () => {},
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 2);
  assert.match(calls.join('\n'), /Polling: enabled \(60000ms interval, \+0-60000ms jitter, \+0-15000ms startup spread, 3 transient export retries\)/u);
  assert.match(calls.join('\n'), /Applying 7500ms startup jitter before the first thread export so simultaneous wake runs spread out\./u);
  assert.match(calls.join('\n'), /sleep:7500/u);
  assert.match(calls.join('\n'), /Thread still looks busy; polling again in 90000ms \(60000ms base \+ up to 60000ms jitter\)\./u);
  assert.match(calls.join('\n'), /sleep:90000/u);
});

test('runWakeFlow keeps startup jitter out of one-shot mode', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 60_000,
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
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
          attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async () => {},
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 1);
  assert.doesNotMatch(calls.join('\n'), /startup jitter/u);
  assert.doesNotMatch(calls.join('\n'), /startup spread/u);
  assert.equal(calls.filter((entry) => entry === 'sleep:7500').length, 0);
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
          attachmentButtons: [{ behaviorButton: true, href: null, tag: 'button', text: 'assistant.patch' }],
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
      resolveExpectBin: () => '/tmp/expect',
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

test('runWakeFlow keeps polling after export failures once it already has a usable snapshot', async () => {
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
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}`);
        if (exportCount === 1) {
          return {
            assistantSnapshots: [{ hasCopyButton: true, signature: 'working', text: 'still packaging patch' }],
            attachmentButtons: [],
            bodyText: 'still packaging patch',
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
            stopVisible: true,
            title: 'Thread title',
          };
        }
        if (exportCount < 5) {
          throw new Error(`Timed out waiting for ChatGPT thread content (attempt ${exportCount})`);
        }
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'all done' }],
          attachmentButtons: [{ behaviorButton: true, href: null, insideAssistantMessage: true, insideFinalAssistantMessage: true, tag: 'button', text: 'assistant.patch' }],
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
      resolveExpectBin: () => '/tmp/expect',
      runCodexChildSession: async () => {},
      sleep: async (delayMs) => {
        calls.push(`sleep:${delayMs}`);
      },
      writeFile: async () => {},
    },
  );

  assert.equal(result.attemptCount, 5);
  assert.match(calls.join('\n'), /Preserving the last successful snapshot while export is flaky\./u);
  assert.equal(calls.filter((entry) => entry === 'sleep:60000').length, 4);
  assert.match(calls.join('\n'), /Last good export: busy=yes, attachments=0, assistantTurns=1, status="none"/u);
  assert.match(calls.join('\n'), /download:assistant\.patch/u);
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
          resolveExpectBin: () => '/tmp/expect',
          runCodexChildSession: async () => {},
          sleep: async () => {},
          writeFile: async () => {},
        },
      ),
    /Failed to export https:\/\/chatgpt\.com\/c\/69c71d43-0e38-8330-9df8-c4e10f5bf536 after 3 consecutive polling errors/u,
  );
});

test('runWakeFlow downloads all assistant artifacts from the final assistant turn', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText.replace(/\s+/gu, '-').toLowerCase()}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath) => {
        calls.push(`export:${outputPath}`);
        return {
          assistantSnapshots: [
            { hasCopyButton: false, signature: 'i', text: 'I', afterLastUserMessage: true },
            {
              hasCopyButton: false,
              signature: 'done filename artifacts',
              text: 'Done. Files: murph-review.patch murph-followup.zip Full patched repo snapshot',
              afterLastUserMessage: true,
            },
          ],
          attachmentButtons: [
            { href: null, tag: 'button', text: 'repo.snapshot.zip', download: false, afterLastUserMessage: true },
            { href: null, tag: 'button', text: 'murph-review.patch', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true },
            { href: null, tag: 'button', text: 'murph-followup.zip', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true },
            { href: null, tag: 'button', text: 'Full patched repo snapshot', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true },
          ],
          bodyText: 'Done. Files: murph-review.patch murph-followup.zip Full patched repo snapshot',
          capturedAt: '2026-04-06T11:02:06.557Z',
          chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
          codeBlocks: [],
          href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
          title: 'Package Deployment Architecture',
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
      runCodexChildSession: async () => ({
        childSessionId: '019d-child-session',
        childRolloutPath: '/tmp/.codex-1/sessions/2026/04/07/rollout-2026-04-07T10-28-51-019d-child-session.jsonl',
        eventsPath: '/repo/output-packages/chatgpt-watch/run/child-events.jsonl',
        launcherPid: 4242,
        resumeOutputPath: '/repo/output-packages/chatgpt-watch/run/child-last-message.txt',
        stderrPath: '/repo/output-packages/chatgpt-watch/run/child-stderr.log',
      }),
      sleep: async () => {},
      writeFile: async () => {},
    },
  );

  assert.deepEqual(result.downloadedArtifacts, [
    '/repo/output-packages/chatgpt-watch/run/downloads/murph-review.patch',
    '/repo/output-packages/chatgpt-watch/run/downloads/murph-followup.zip',
    '/repo/output-packages/chatgpt-watch/run/downloads/full-patched-repo-snapshot',
  ]);
  assert.deepEqual(result.downloadedPatches, result.downloadedArtifacts);
  assert.equal(result.childSessionId, '019d-child-session');
  assert.equal(result.childRolloutPath, '/tmp/.codex-1/sessions/2026/04/07/rollout-2026-04-07T10-28-51-019d-child-session.jsonl');
  assert.equal(result.eventsPath, '/repo/output-packages/chatgpt-watch/run/child-events.jsonl');
  assert.equal(result.launcherPid, 4242);
  assert.equal(result.resumeOutputPath, '/repo/output-packages/chatgpt-watch/run/child-last-message.txt');
  assert.equal(result.stderrPath, '/repo/output-packages/chatgpt-watch/run/child-stderr.log');
  assert.match(calls.join('\n'), /assistant download targets: murph-review\.patch \| murph-followup\.zip \| Full patched repo snapshot/u);
  assert.match(calls.join('\n'), /Downloaded assistant artifact "murph-review\.patch"/u);
  assert.match(calls.join('\n'), /Downloaded assistant artifact "Full patched repo snapshot"/u);
  assert.match(calls.join('\n'), /Wake child launch verified with child session 019d-child-session \(launcher pid 4242\), events at output-packages\/chatgpt-watch\/run\/child-events\.jsonl, stderr at output-packages\/chatgpt-watch\/run\/child-stderr\.log\./u);
});

test('runWakeFlow forces one same-tab reload after repeated identical assistant-settling snapshots', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];
  let exportCount = 0;
  const writes = new Map();

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollIntervalMs: 60_000,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath, options) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}:${options?.forceReload === true ? 'reload' : 'normal'}`);
        if (exportCount < 4) {
          return {
            assistantSnapshots: [{ hasCopyButton: true, signature: 'i', text: 'I', afterLastUserMessage: true }],
            attachmentButtons: [],
            bodyText: 'I',
            capturedAt: '2026-04-09T00:00:00Z',
            chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
            codeBlocks: [],
            href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
        assert.equal(options?.forceReload, true);
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'Done. Patch ready.', afterLastUserMessage: true }],
          attachmentButtons: [{ href: null, tag: 'button', text: 'assistant.patch', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true }],
          bodyText: 'Done. Patch ready.',
          capturedAt: '2026-04-09T00:05:00Z',
          chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
          codeBlocks: [],
          href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
      writeFile: async (targetPath, content) => {
        writes.set(targetPath, content);
      },
    },
  );

  const status = JSON.parse(writes.get('/repo/output-packages/chatgpt-watch/run/status.json'));

  assert.equal(result.attemptCount, 4);
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
  assert.match(calls.join('\n'), /staleSnapshot=3\/3/u);
  assert.match(calls.join('\n'), /forcing a same-tab reload on the next export/u);
  assert.match(calls.join('\n'), /export:4:\/repo\/output-packages\/chatgpt-watch\/run\/thread\.json:reload/u);
  assert.equal(calls.filter((entry) => entry === 'sleep:60000').length, 3);
  assert.equal(status.forcedReloadCount, 1);
  assert.equal(status.forceReloadNextExport, false);
  assert.equal(status.staleSnapshotThreshold, 3);
});

test('runWakeFlow succeeds when child launch events arrive before session-home persistence evidence', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];
  const writes = new Map();

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText.replace(/\s+/gu, '-').toLowerCase()}`;
      },
      exportThreadSnapshot: async () => ({
        assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'Done. Files: murph-review.patch', afterLastUserMessage: true }],
        attachmentButtons: [
          { href: null, tag: 'button', text: 'murph-review.patch', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true },
        ],
        bodyText: 'done',
        capturedAt: '2026-03-29T00:01:00Z',
        chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
        codeBlocks: [],
        href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
      }),
      log: (message) => {
        calls.push(message);
      },
      mkdir: async () => {},
      resolveCodexBin: () => '/tmp/codex',
      resolveCodexHomeForSession: () => ({
        homePath: '/tmp/.codex-1',
        resolution: 'discovered',
      }),
      runCodexChildSession: async () => ({
        childSessionId: '019d-child-session',
        childSessionPersistence: 'pending',
        eventsPath: '/repo/output-packages/chatgpt-watch/run/child-events.jsonl',
        launcherPid: 4242,
        resumeOutputPath: '/repo/output-packages/chatgpt-watch/run/child-last-message.txt',
        stderrPath: '/repo/output-packages/chatgpt-watch/run/child-stderr.log',
      }),
      sleep: async () => {},
      writeFile: async (targetPath, content) => {
        writes.set(targetPath, content);
      },
    },
  );

  const status = JSON.parse(writes.get('/repo/output-packages/chatgpt-watch/run/status.json'));

  assert.equal(result.childSessionId, '019d-child-session');
  assert.equal(result.childSessionPersistence, 'pending');
  assert.equal(result.childRolloutPath, undefined);
  assert.equal(status.state, 'succeeded');
  assert.equal(status.childSessionPersistence, 'pending');
  assert.match(calls.join('\n'), /Wake child launch verified with child session 019d-child-session/u);
  assert.match(calls.join('\n'), /session-home evidence was discoverable; persistence is still pending/u);
});

test('runWakeFlow does not force reload while an explicit stop control stays visible without artifacts', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];
  let exportCount = 0;
  const writes = new Map();

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
      delayMs: 0,
      outputDir: '/repo/output-packages/chatgpt-watch/run',
      pollJitterMs: 0,
      pollIntervalMs: 60_000,
      repoDir: '/repo',
      sessionId: '019d36e3-f6a2-7873-910a-2bdbd4f9748c',
    },
    {
      downloadThreadAttachment: async (_browserEndpoint, _chatUrl, attachmentText) => {
        calls.push(`download:${attachmentText}`);
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText}`;
      },
      exportThreadSnapshot: async (_browserEndpoint, _chatUrl, outputPath, options) => {
        exportCount += 1;
        calls.push(`export:${exportCount}:${outputPath}:${options?.forceReload === true ? 'reload' : 'normal'}`);
        if (exportCount < 4) {
          return {
            assistantSnapshots: [{ hasCopyButton: true, signature: 'working', text: 'still packaging patch', afterLastUserMessage: true }],
            attachmentButtons: [],
            bodyText: 'still packaging patch',
            capturedAt: '2026-04-09T00:00:00Z',
            chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
            codeBlocks: [],
            href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
            patchMarkers: {
              addFile: false,
              beginPatch: false,
              deleteFile: false,
              diffGit: false,
              updateFile: false,
            },
            statusBusy: false,
            statusTexts: [],
            stopVisible: true,
            title: 'Thread title',
          };
        }
        assert.notEqual(options?.forceReload, true);
        return {
          assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'Done. Patch ready.', afterLastUserMessage: true }],
          attachmentButtons: [{ href: null, tag: 'button', text: 'assistant.patch', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true }],
          bodyText: 'Done. Patch ready.',
          capturedAt: '2026-04-09T00:05:00Z',
          chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
          codeBlocks: [],
          href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
      writeFile: async (targetPath, content) => {
        writes.set(targetPath, content);
      },
    },
  );

  const status = JSON.parse(writes.get('/repo/output-packages/chatgpt-watch/run/status.json'));

  assert.equal(result.attemptCount, 4);
  assert.deepEqual(result.downloadedPatches, [
    '/repo/output-packages/chatgpt-watch/run/downloads/assistant.patch',
  ]);
  assert.doesNotMatch(calls.join('\n'), /forcing a same-tab reload on the next export/u);
  assert.doesNotMatch(calls.join('\n'), /staleSnapshot=/u);
  assert.match(calls.join('\n'), /reason="stop-visible", lastAssistant="still packaging patch"/u);
  assert.match(calls.join('\n'), /export:4:\/repo\/output-packages\/chatgpt-watch\/run\/thread\.json:normal/u);
  assert.equal(calls.filter((entry) => entry === 'sleep:60000').length, 3);
  assert.equal(status.forcedReloadCount, 0);
  assert.equal(status.forceReloadNextExport, false);
});

test('runWakeFlow records filename-shaped artifact download failures without aborting the child handoff', async () => {
  const { runWakeFlow } = await import(distWakeLib);
  const calls = [];

  const result = await runWakeFlow(
    {
      chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
        if (attachmentText === 'murph-followup.zip') {
          throw new Error('Download click produced no file');
        }
        return `/repo/output-packages/chatgpt-watch/run/downloads/${attachmentText.replace(/\s+/gu, '-').toLowerCase()}`;
      },
      exportThreadSnapshot: async () => ({
        assistantSnapshots: [{ hasCopyButton: true, signature: 'done', text: 'Done. Files: murph-review.patch murph-followup.zip', afterLastUserMessage: true }],
        attachmentButtons: [
          { href: null, tag: 'button', text: 'murph-review.patch', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true },
          { href: null, tag: 'button', text: 'murph-followup.zip', behaviorButton: true, insideAssistantMessage: true, insideFinalAssistantMessage: true, afterLastUserMessage: true },
        ],
        bodyText: 'done',
        capturedAt: '2026-03-29T00:01:00Z',
        chatUrl: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
        codeBlocks: [],
        href: 'https://chatgpt.com/c/69d35f22-2018-839c-a44f-e0c5f9fe0645',
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
      }),
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
      runCodexChildSession: async () => ({
        childSessionId: '019d-child-session',
        childRolloutPath: '/tmp/.codex-1/sessions/2026/04/07/rollout-2026-04-07T10-28-51-019d-child-session.jsonl',
        eventsPath: '/repo/output-packages/chatgpt-watch/run/child-events.jsonl',
        launcherPid: 4242,
        resumeOutputPath: '/repo/output-packages/chatgpt-watch/run/child-last-message.txt',
        stderrPath: '/repo/output-packages/chatgpt-watch/run/child-stderr.log',
      }),
      sleep: async () => {},
      writeFile: async () => {},
    },
  );

  assert.deepEqual(result.downloadedArtifacts, [
    '/repo/output-packages/chatgpt-watch/run/downloads/murph-review.patch',
  ]);
  assert.deepEqual(result.downloadedPatches, result.downloadedArtifacts);
  assert.deepEqual(result.downloadErrors, [
    'murph-followup.zip: Download click produced no file',
  ]);
  assert.equal(result.childSessionId, '019d-child-session');
  assert.equal(result.childRolloutPath, '/tmp/.codex-1/sessions/2026/04/07/rollout-2026-04-07T10-28-51-019d-child-session.jsonl');
  assert.match(calls.join('\n'), /Assistant artifact download failed for "murph-followup\.zip": Download click produced no file\./u);
});
