import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { buildCompanionSnapshots } from '../dist/review-gpt-lib.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, { mode = 'valid', anchor = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-companion-test-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'source.ts'), 'export const synthetic = true;\n');
  writeFileSync(join(root, '.gitignore'), 'generated-path\nremote-head\noutside.zip\n');
  writeFileSync(join(root, 'scripts/review-gpt.config.sh'), 'package_script="scripts/package.sh"\n');
  writeFileSync(join(root, 'scripts/package.sh'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$REVIEW_GPT_PR_URL" == "https://github.com/example/companion/pull/7" ]]
[[ "$REVIEW_GPT_ROUND_NUMBER" == "1" ]]
[[ -z "\${REVIEW_GPT_PREVIOUS_REVIEWED_HEAD:-}" ]]
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--out-dir" ]]; then out="$2"; shift; fi
  shift
done
mkdir -p "$out/review-gpt-pr-context"
head="$(git rev-parse HEAD)"
printf '%s' '{"schemaVersion":1,"contextMode":"full_snapshot","currentReviewedHead":"'"$head"'"${anchor ? ',"contextAnchorHead":"\'"$head"\'"' : ''}}' > "$out/review-gpt-pr-context/review-round.json"
${mode === 'metadata' ? 'echo "{}" > "$out/review-gpt-pr-context/review-round.json"' : ''}
cp source.ts "$out/source.ts"
${mode === 'sensitive' ? 'mkdir -p "$out/.ssh"; printf synthetic > "$out/.ssh/config"' : ''}
(cd "$out" && zip -qr "$out/generated.zip" source.ts review-gpt-pr-context ${mode === 'sensitive' ? '.ssh' : ''})
${mode === 'dirty' ? 'printf changed >> source.ts' : ''}
${mode === 'remote' ? 'printf 0000000000000000000000000000000000000000 > remote-head' : ''}
${mode === 'escape' ? 'cp "$out/generated.zip" "$PWD/generated-path"; out="$PWD"; mv "$out/generated-path" "$out/outside.zip"' : ''}
printf '%s' "$out/${mode === 'escape' ? 'outside' : 'generated'}.zip" > generated-path
printf 'ZIP: %s (1K)\\n' "$out/${mode === 'escape' ? 'outside' : 'generated'}.zip"
`);
  writeFileSync(join(root, 'tools/gh'), `#!/usr/bin/env bash
head="$(git rev-parse HEAD)"
if [[ -f remote-head ]]; then head="$(cat remote-head)"; fi
printf '{"headRefOid":"%s","url":"https://github.com/example/companion/pull/7","isCrossRepository":false}' "$head"
`, { mode: 0o755 });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture Agent');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/companion.git');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'test fixture');
  const envBefore = { ...process.env };
  process.env.PATH = `${join(root, 'tools')}:${process.env.PATH}`;
  process.env.REVIEW_GPT_PR_URL = 'https://github.com/example/primary/pull/1';
  process.env.REVIEW_GPT_PREVIOUS_REVIEWED_HEAD = 'primary-round';
  process.env.REVIEW_GPT_ALLOW_SENSITIVE_ARTIFACTS = '1';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
    const receipt = join(root, 'generated-path');
    if (existsSync(receipt)) {
      const output = readFileSync(receipt, 'utf8');
      if (dirname(output).startsWith(join(tmpdir(), 'review-gpt-companion-'))) {
        rmSync(dirname(output), { recursive: true, force: true });
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const descriptor = { repo: root, head: git(root, 'rev-parse', 'HEAD'), prUrl: 'https://github.com/example/companion/pull/7' };
  return { root, descriptor, input: JSON.stringify(descriptor) };
}

for (const anchor of [true, false]) {
  test(`companion uses its own guarded packager and exact metadata (anchor=${anchor})`, async (t) => {
    const { root, input, descriptor } = fixture(t, { anchor });
    const result = await buildCompanionSnapshots([input], root);
    t.after(() => rmSync(dirname(result[0].path), { recursive: true, force: true }));
    assert.equal(result.length, 1);
    const original = readFileSync(join(root, 'generated-path'), 'utf8');
    assert.deepEqual(readFileSync(result[0].path), readFileSync(original));
    assert.match(result[0].instruction, new RegExp(descriptor.head));
    assert.match(result[0].instruction, /companion-1.codebase.zip/);
    assert.equal(result[0].instruction.includes(root), false);
  });
}

test('companion fails before running config for a dirty checkout or stale local head', async (t) => {
  const { root, input, descriptor } = fixture(t);
  writeFileSync(join(root, 'untracked.txt'), 'synthetic');
  await assert.rejects(buildCompanionSnapshots([input], root), /clean tracked and untracked/);
  rmSync(join(root, 'untracked.txt'));
  await assert.rejects(buildCompanionSnapshots([JSON.stringify({ ...descriptor, head: 'a'.repeat(40) })], root), /HEAD differs/);
  assert.equal(existsSync(join(root, 'generated-path')), false);
});

test('companion rejects moved remote PR and mismatched repository', async (t) => {
  const { root, input } = fixture(t);
  writeFileSync(join(root, 'remote-head'), 'a'.repeat(40));
  await assert.rejects(buildCompanionSnapshots([input], root), /match the requested exact head/);
  rmSync(join(root, 'remote-head'));
  git(root, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git');
  await assert.rejects(buildCompanionSnapshots([input], root), /origin does not match/);
});

for (const [mode, error] of [['metadata', /guarded full snapshot/], ['sensitive', /credential-shaped/], ['dirty', /clean tracked and untracked/], ['remote', /match the requested exact head/], ['escape', /supplied output directory/]]) {
  test(`companion refuses ${mode} output`, async (t) => {
    const { root, input } = fixture(t, { mode });
    await assert.rejects(buildCompanionSnapshots([input], root), error);
  });
}

test('companion rejects duplicate repositories and filename collisions', async (t) => {
  const { root, input } = fixture(t);
  await assert.rejects(buildCompanionSnapshots([input], root, ['companion-1.codebase.zip']), /filename collides/);
  await assert.rejects(buildCompanionSnapshots([input, input], root), /duplicate companion/);
});

test('companion descriptor cannot specify arbitrary ZIPs or scripts', async () => {
  await assert.rejects(buildCompanionSnapshots(['{"zip":"raw.zip"}'], process.cwd()), /requires repo/);
});

test('companion requires a committed canonical config and explicit packager', async (t) => {
  const { root, descriptor } = fixture(t);
  writeFileSync(join(root, 'scripts/review-gpt.config.sh'), '# no packager\n');
  git(root, 'add', 'scripts/review-gpt.config.sh');
  git(root, 'commit', '-qm', 'remove packager');
  const input = JSON.stringify({ ...descriptor, head: git(root, 'rev-parse', 'HEAD') });
  await assert.rejects(buildCompanionSnapshots([input], root), /must declare its canonical guarded/);
});

test('companion validates committed bytes even when Git hides a config modification', async (t) => {
  const { root, input } = fixture(t);
  git(root, 'update-index', '--assume-unchanged', 'scripts/review-gpt.config.sh');
  writeFileSync(join(root, 'scripts/review-gpt.config.sh'), 'exit 91\n');
  await assert.rejects(buildCompanionSnapshots([input], root), /must not hide tracked changes/);
});

test('CLI rejects companion snapshots when artifact uploads are disabled', (t) => {
  const { root, input } = fixture(t);
  const result = spawnSync(process.execPath, [new URL('../dist/bin.mjs', import.meta.url).pathname,
    '--config', 'scripts/review-gpt.config.sh', '--companion-snapshot', input, '--no-artifacts', '--dry-run'],
  { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /companion snapshots require artifact attachments/);
});
