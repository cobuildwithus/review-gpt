import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

test('generate-release-notes creates codex-style sections and full changelog range', (t) => {
  const root = join(tmpdir(), `review-gpt-notes-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });

  const scriptPath = join(root, 'scripts', 'generate-release-notes.sh');
  copyFileSync(join(repoRoot, 'scripts', 'generate-release-notes.sh'), scriptPath);
  chmodSync(scriptPath, 0o755);

  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = run('git', ['init', '-q'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['config', 'user.email', '123456+review-gpt-test@users.noreply.github.com'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['config', 'user.name', 'Test User'], root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'README.md'), 'one\n');
  result = run('git', ['add', '.'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['commit', '-m', 'feat: initial scaffolding'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['tag', '-a', 'v0.1.0', '-m', 'release: v0.1.0'], root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'README.md'), 'two\n');
  result = run('git', ['add', 'README.md'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['commit', '-m', 'feat: add release automation'], root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'docs.md'), 'docs\n');
  result = run('git', ['add', 'docs.md'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['commit', '-m', 'docs: update usage docs'], root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'fix.txt'), 'fix\n');
  result = run('git', ['add', 'fix.txt'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['commit', '-m', 'fix: patch release parsing'], root);
  assert.equal(result.status, 0, result.stderr);

  result = run('bash', ['scripts/generate-release-notes.sh', '0.2.0', 'notes.md'], root);
  assert.equal(result.status, 0, result.stderr);

  const notes = readFileSync(join(root, 'notes.md'), 'utf8');
  assert.match(notes, /^0\.2\.0 Latest/m);
  assert.match(notes, /New Features/);
  assert.match(notes, /- add release automation/);
  assert.match(notes, /Bug Fixes/);
  assert.match(notes, /- patch release parsing/);
  assert.match(notes, /Documentation/);
  assert.match(notes, /- update usage docs/);
  assert.match(notes, /Full Changelog: v0\.1\.0\.\.\.v0\.2\.0/);
});
