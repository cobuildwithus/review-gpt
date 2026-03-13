import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const cliScript = join(repoRoot, 'src', 'review-gpt.sh');
const require = createRequire(import.meta.url);
const {
  buildExpectedAttachmentNames,
  formatAttachmentVerificationSummary,
  summarizeAttachmentVerification,
} = require('../src/prepare-chatgpt-draft.js');

function createFixtureRepo({ packageScriptMode = 0o755, configBody } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-test-'));
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
  chmodSync(packageScript, packageScriptMode);

  const fakeChrome = join(root, 'scripts', 'fake-chrome.sh');
  writeFileSync(fakeChrome, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeChrome, 0o755);

  writeFileSync(
    join(root, 'scripts', 'review-gpt.config.sh'),
    configBody ||
      `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
`
  );

  return root;
}

function runCli(root, args, { env } = {}) {
  return spawnSync(
    'bash',
    [cliScript, '--config', 'scripts/review-gpt.config.sh', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
    }
  );
}

test('stages inline custom prompt in dry-run mode', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt', 'custom prompt line']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Custom prompt chunks: 1/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
  assert.match(result.stdout, /Draft model target: current/);
  assert.match(result.stdout, /Draft thinking target: current/);
  assert.match(result.stdout, /Draft send: disabled/);
  assert.match(result.stdout, /Dry run: browser launch skipped/);
});

test('runs package script through bash even when wrapper is not executable', (t) => {
  const root = createFixtureRepo({ packageScriptMode: 0o644 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /ZIP: .*test-audit\.zip/);
});

test('accepts explicit model and thinking overrides', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--model', 'gpt-5.2-pro', '--thinking', 'extended']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft model target: gpt-5\.2-pro/);
  assert.match(result.stdout, /Draft thinking target: extended/);
});

test('enables send mode only when explicitly requested', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--send']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft send: enabled \(auto-submit\)/);
});

test('resolves --chat chat ID to a ChatGPT conversation URL', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const chatId = '69a86c41-cca8-8327-975a-1716caa599cf';
  const result = runCli(root, ['--dry-run', '--chat', chatId]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`ChatGPT URL: https://chatgpt\\.com/c/${chatId}`));
});

test('resolves --chat-id to a ChatGPT conversation URL', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const chatId = '69a86c41-cca8-8327-975a-1716caa599cf';
  const result = runCli(root, ['--dry-run', '--chat-id', chatId]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`ChatGPT URL: https://chatgpt\\.com/c/${chatId}`));
});

test('uses explicit conversation URL when provided via --chat-url', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const chatUrl = 'https://chatgpt.com/c/69a86c41-cca8-8327-975a-1716caa599cf';
  const result = runCli(root, ['--dry-run', '--chat-url', chatUrl]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`ChatGPT URL: ${chatUrl}`));
});

test('rejects invalid --chat target values', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--chat', 'bad/chat/value']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid --chat target/i);
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

test('loads prompt content from --prompt-file', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt-file', 'scripts/chatgpt-review-presets/security-audit.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt presets: \(none; upload-only prompt\)/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
});

test('errors when --prompt-file does not exist', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt-file', 'missing/prompt.md']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required file not found/i);
});

test('copy mode copies prompt text to the clipboard and skips browser launch', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/missing-browser.sh"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const clipboardPath = join(root, 'audit-packages', 'clipboard.txt');
  const fakePbcopy = join(root, 'scripts', 'pbcopy');
  writeFileSync(
    fakePbcopy,
    `#!/usr/bin/env bash
set -euo pipefail
cat > "${clipboardPath}"
`
  );
  chmodSync(fakePbcopy, 0o755);

  const result = runCli(
    root,
    ['--copy', '--prompt', 'manual fallback prompt'],
    { env: { PATH: `${join(root, 'scripts')}:${process.env.PATH}` } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt copy: copied to clipboard for manual paste/);
  assert.match(result.stdout, /Browser launch: skipped \(\-\-copy manual fallback\)/);
  assert.match(result.stdout, /Manual upload: attach the ZIP file yourself in ChatGPT/);
  assert.match(readFileSync(clipboardPath, 'utf8'), /manual fallback prompt/);
});

test('copy mode rejects auto-send', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--copy', '--send']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--copy cannot be combined with --send/i);
});

test('supports clearer managed browser config aliases', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_user_data_dir="tmp-managed-browser"
managed_browser_profile="Profile 7"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed browser data dir: .*tmp-managed-browser/);
  assert.match(result.stdout, /Managed browser profile: Profile 7/);
  assert.match(result.stdout, /Browser binary: .*fake-chrome\.sh/);
});

test('repo tools config uses shared release validation defaults', () => {
  const result = spawnSync(
    'bash',
    [
      '-lc',
      'source scripts/repo-tools.config.sh && printf "%s\\n%s\\n%s\\n" "${COMMITTER_ALLOW_NON_CONVENTIONAL:-}" "${COBUILD_RELEASE_COMMIT_TEMPLATE:-}" "$(basename "$(cobuild_repo_tool_bin cobuild-committer)")"',
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines[0], '');
  assert.equal(lines[1], 'release: v%s');
  assert.equal(lines[2], 'cobuild-committer');
});

test('buildExpectedAttachmentNames normalizes basenames and removes duplicates', () => {
  const names = buildExpectedAttachmentNames([
    '/tmp/Review Bundle.ZIP',
    'nested/review bundle.zip',
    'report.txt',
  ]);
  assert.deepEqual(names, ['review bundle.zip', 'report.txt']);
});

test('summarizeAttachmentVerification rejects hidden-input-only staging', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 0,
      attachmentUiSignature: '',
      attachmentText: '',
      composerText: '',
      uploading: false,
      fileInputReady: true,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 0,
      attachmentUiSignature: '',
    },
    ['audit.zip'],
    1
  );

  assert.equal(summary.confirmed, false);
  assert.equal(summary.inputOnly, true);
  assert.equal(summary.attachedEnough, true);
});

test('summarizeAttachmentVerification accepts real attachment UI progress', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 0,
      attachmentUiCount: 1,
      attachmentUiSignature: 'uploading audit zip',
      attachmentText: 'uploading audit.zip',
      composerText: '',
      uploading: true,
      fileInputReady: false,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 0,
      attachmentUiSignature: '',
    },
    ['audit.zip'],
    1
  );

  assert.equal(summary.confirmed, true);
  assert.equal(summary.uploading, true);
  assert.equal(summary.attachmentUiProgressed, true);
});

test('summarizeAttachmentVerification accepts filename visibility when count matches', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 0,
      attachmentUiSignature: '',
      attachmentText: '',
      composerText: 'Attachment ready: audit.zip',
      uploading: false,
      fileInputReady: true,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 0,
      attachmentUiSignature: '',
    },
    ['audit.zip'],
    1
  );

  assert.equal(summary.confirmed, true);
  assert.equal(summary.namesVisible, true);
  assert.match(formatAttachmentVerificationSummary(summary), /attached=1\/1/);
});
