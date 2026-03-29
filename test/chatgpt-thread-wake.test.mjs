import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const distCodexSessionLib = new URL('../dist/codex-session-lib.mjs', import.meta.url);
const distWakeLib = new URL('../dist/chatgpt-thread-wake-lib.mjs', import.meta.url);

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

test('builds a wake resume prompt with repo-relative file references', async () => {
  const { buildWakeResumePrompt, parseWakeDelayToMs } = await import(distWakeLib);
  const repoDir = '/repo';
  const prompt = buildWakeResumePrompt({
    downloadedPatches: ['/repo/output-packages/chatgpt-watch/run/downloads/fix.patch'],
    exportPath: '/repo/output-packages/chatgpt-watch/run/thread.json',
    repoDir,
  });

  assert.match(prompt, /output-packages\/chatgpt-watch\/run\/thread\.json/);
  assert.match(prompt, /downloads\/fix\.patch/);
  assert.equal(parseWakeDelayToMs('1h10m5s'), 4_205_000);
  assert.equal(parseWakeDelayToMs('0s'), 0);
});
