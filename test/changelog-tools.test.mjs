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

test('changelog update and extract scripts work in an isolated repo', (t) => {
  const root = join(tmpdir(), `review-gpt-changelog-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });

  const updateScript = join(root, 'scripts', 'update-changelog.sh');
  const extractScript = join(root, 'scripts', 'extract-changelog-section.sh');

  copyFileSync(join(repoRoot, 'scripts', 'update-changelog.sh'), updateScript);
  copyFileSync(join(repoRoot, 'scripts', 'extract-changelog-section.sh'), extractScript);
  chmodSync(updateScript, 0o755);
  chmodSync(extractScript, 0o755);

  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = run('git', ['init', '-q'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['config', 'user.email', '123456+review-gpt-test@users.noreply.github.com'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['config', 'user.name', 'Test User'], root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'README.md'), 'hello\n');
  result = run('git', ['add', 'README.md'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['commit', '-m', 'feat: initial release plumbing'], root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'README.md'), 'hello world\n');
  result = run('git', ['add', 'README.md'], root);
  assert.equal(result.status, 0, result.stderr);
  result = run('git', ['commit', '-m', 'fix: tighten prompt flag parsing'], root);
  assert.equal(result.status, 0, result.stderr);

  result = run('bash', ['scripts/update-changelog.sh', '1.2.3'], root);
  assert.equal(result.status, 0, result.stderr);

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[1.2.3\] - /);
  assert.match(changelog, /### Added/);
  assert.match(changelog, /- initial release plumbing/);
  assert.match(changelog, /### Fixed/);
  assert.match(changelog, /- tighten prompt flag parsing/);

  result = run('bash', ['scripts/extract-changelog-section.sh', '1.2.3', 'notes.md'], root);
  assert.equal(result.status, 0, result.stderr);

  const notes = readFileSync(join(root, 'notes.md'), 'utf8');
  assert.match(notes, /^## \[1.2.3\] - /);
  assert.match(notes, /### Added/);
  assert.match(notes, /### Fixed/);
});
