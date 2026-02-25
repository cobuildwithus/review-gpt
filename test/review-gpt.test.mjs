import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const cliScript = join(repoRoot, 'src', 'review-gpt.sh');

function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-cli-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });

  mkdirSync(join(root, 'scripts', 'chatgpt-review-presets'), { recursive: true });
  mkdirSync(join(root, 'audit-packages'), { recursive: true });

  writeFileSync(
    join(root, 'scripts', 'chatgpt-review-presets', 'security-audit.md'),
    'Security preset prompt section.\n'
  );

  const packageScript = join(root, 'scripts', 'package-audit-context.sh');
  writeFileSync(
    packageScript,
    `#!/usr/bin/env bash
set -euo pipefail
zip_path="$PWD/audit-packages/test-audit.zip"
printf 'zip-bytes' > "$zip_path"
echo "Audit package created."
echo "Included files: 1"
echo "ZIP: $zip_path (1K)"
`
  );
  chmodSync(packageScript, 0o755);

  const fakeChrome = join(root, 'scripts', 'fake-chrome.sh');
  writeFileSync(fakeChrome, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeChrome, 0o755);

  writeFileSync(
    join(root, 'scripts', 'review-gpt.config.sh'),
    `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
`
  );

  return root;
}

function runCli(root, args) {
  return spawnSync(
    'bash',
    [cliScript, '--config', 'scripts/review-gpt.config.sh', ...args],
    { cwd: root, encoding: 'utf8' }
  );
}

test('stages inline custom prompt in dry-run mode', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt', 'custom prompt line']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Custom prompt chunks: 1/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
  assert.match(result.stdout, /Draft mode: always no-send \(Oracle removed\)/);
});

test('rejects send mode explicitly', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--send']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--send is no longer supported/);
});

test('rejects raw forwarded args via double-dash', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--', '--prompt', 'bad']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forwarding raw Oracle args is no longer supported/);
});

test('reads preset prompt content from repo-local preset directory', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--preset', 'security']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt presets: security/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
});
