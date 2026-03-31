import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const cliBin = join(repoRoot, 'dist', 'bin.mjs');
const require = createRequire(import.meta.url);
const {
  buildExpectedAttachmentNames,
  buildDeepResearchStartClickPoint,
  formatAttachmentVerificationSummary,
  isRetryableSocketError,
  isLikelyPromptEcho,
  mergeResponseCaptureStates,
  modelPickerLabelMatchesTarget,
  modelPickerSelectionStateMatches,
  modelPickerTextHasWord,
  normalizeResponseText,
  sanitizeDeepResearchResponseText,
  responseStatusTextIndicatesBusy,
  scoreDeepResearchStartButtonCandidate,
  selectAssistantResponseCandidate,
  shouldAttemptDeepResearchStartFallback,
  shouldFinishAssistantResponseWait,
  summarizeAttachmentVerification,
} = require('../src/prepare-chatgpt-draft.js');

function createFixtureRepo({ packageScriptMode = 0o755, configBody } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });

  mkdirSync(join(root, 'scripts', 'chatgpt-review-presets'), { recursive: true });
  mkdirSync(join(root, 'audit-packages'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });

  writeFileSync(join(root, '.gitignore'), 'audit-packages/\n');

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

  spawnSync('git', ['config', 'user.name', 'Fixture Agent'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'fixture-agent@users.noreply.github.com'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'chore: seed fixture'], { cwd: root, stdio: 'ignore' });

  return root;
}

function runCli(root, args, { env } = {}) {
  return spawnSync(
    process.execPath,
    [cliBin, '--config', 'scripts/review-gpt.config.sh', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        ...(env ?? {}),
      },
    }
  );
}

function runRawCli(root, args, { env } = {}) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      ...(env ?? {}),
    },
  });
}

test('stages inline custom prompt in dry-run mode', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt', 'custom prompt line']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Custom prompt chunks: 1/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
  assert.match(result.stdout, /Repomix XML: .*repo\.repomix\.xml/);
  assert.match(result.stdout, /ZIP file: .*repo\.snapshot\.zip/);
  assert.match(result.stdout, /BASE_COMMIT: [0-9a-f]{40}/);
  assert.match(result.stdout, /ChatGPT mode: chat/);
  assert.match(result.stdout, /Draft model target: gpt-5\.4-pro/);
  assert.match(result.stdout, /Draft thinking target: current/);
  assert.match(result.stdout, /Draft send: disabled/);
  assert.match(result.stdout, /Response capture: disabled/);
  assert.match(result.stdout, /Dry run: browser launch skipped/);
});

test('runs package script through bash even when wrapper is not executable', (t) => {
  const root = createFixtureRepo({ packageScriptMode: 0o644 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix XML: .*repo\.repomix\.xml/);
  assert.match(result.stdout, /ZIP file: .*repo\.snapshot\.zip/);
});

test('uses the bundled repo-tools packager when package_script is omitted', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix XML: .*repo\.repomix\.xml/);
  assert.match(result.stdout, /ZIP file: .*repo\.snapshot\.zip/);
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

test('wait mode enables send, response capture, and a longer timeout', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--wait']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft send: enabled \(auto-submit\)/);
  assert.match(result.stdout, /Response capture: enabled \(600000ms timeout\)/);
  assert.match(result.stdout, /Wait behavior: block until the assistant finishes or the wait timeout is hit\./);
  assert.match(result.stdout, /Draft timeout: 600000ms/);
});

test('help text explains that wait mode stays attached until completion or timeout', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /--wait <boolean>\s+Auto-submit and stay attached until the assistant finishes or the wait timeout is hit\./
  );
  assert.match(
    result.stdout,
    /--no-zip <boolean>\s+Skip repo artifact packaging \(Repomix XML plus ZIP\) and stage a prompt-only draft\./
  );
  assert.match(result.stdout, /skills add\s+Sync skill files to agents/);
});

test('root help includes the thread subcommand group', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /thread\s+Export ChatGPT threads, download patch, diff, or zip attachments, and resume delayed Codex follow-up work\./);
});

test('thread wake help is available through the incur subcommand tree', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['thread', 'wake', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cobuild-review-gpt thread wake \[options\]/);
  assert.match(result.stdout, /--codex-home <string>/);
  assert.match(result.stdout, /--skip-resume <boolean>/);
});

test('deep research mode targets the dedicated page and skips forced model selection', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--deep-research']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ChatGPT URL: https:\/\/chatgpt\.com\/deep-research/);
  assert.match(result.stdout, /ChatGPT mode: deep-research/);
  assert.match(result.stdout, /Draft model target: current/);
  assert.match(result.stdout, /Draft thinking target: current/);
});

test('treats transient CDP promise collection as retryable', () => {
  assert.equal(isRetryableSocketError(new Error('Promise was collected')), true);
  assert.equal(isRetryableSocketError(new Error('promise WAS collected while waiting')), true);
});

test('selection flows retain their in-page promises until completion', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /__reviewGptDraftModelSelectionPromise/);
  assert.match(source, /__reviewGptDraftThinkingSelectionPromise/);
  assert.match(source, /window\[PENDING_PROMISE_KEY\] = pendingPromise/);
});

test('model selection flow treats the composer chip as a valid completion signal', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const getComposerChipLabel = \(\) => \{/);
  assert.match(source, /const currentSelectionLabel = \(\) => getComposerChipLabel\(\) \|\| getButtonLabel\(\);/);
  assert.match(source, /finish\(\{ status: 'switched', label: currentSelectionLabel\(\) \|\| match\.label \}\);/);
});

test('deep research wait mode uses a much longer timeout budget', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--deep-research', '--wait']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Response capture: enabled \(2400000ms timeout\)/);
  assert.match(
    result.stdout,
    /Deep Research wait: long-running runs stay attached until completion or timeout, even when the UI is quiet\./
  );
  assert.match(result.stdout, /Draft timeout: 2400000ms/);
});

test('computes the deep research start hotspot inside the approval iframe', () => {
  assert.deepEqual(
    buildDeepResearchStartClickPoint({
      left: 100,
      top: 50,
      width: 800,
      height: 600,
    }),
    {
      x: 806,
      y: 498,
    }
  );
});

test('deep research start button scoring prefers the approval-card Start action', () => {
  const startScore = scoreDeepResearchStartButtonCandidate({
    label: 'Start 28',
    disabled: false,
    hasCancelSibling: true,
    hasEditSibling: true,
    withinPlanCard: true,
    isButtonElement: true,
  });
  const genericScore = scoreDeepResearchStartButtonCandidate({
    label: 'Get started',
    disabled: false,
    hasCancelSibling: false,
    hasEditSibling: false,
    withinPlanCard: false,
    isButtonElement: true,
  });

  assert.ok(startScore > genericScore);
  assert.ok(startScore >= 400);
});

test('deep research start fallback waits for the auto-start grace window', () => {
  assert.equal(
    shouldAttemptDeepResearchStartFallback({
      kickoffState: { status: 'start-button-visible' },
      elapsedMs: 15_000,
      graceMs: 60_000,
    }),
    false
  );

  assert.equal(
    shouldAttemptDeepResearchStartFallback({
      kickoffState: { status: 'start-button-visible' },
      elapsedMs: 60_000,
      graceMs: 60_000,
    }),
    true
  );

  assert.equal(
    shouldAttemptDeepResearchStartFallback({
      kickoffState: { status: 'generation-active' },
      elapsedMs: 60_000,
      graceMs: 60_000,
    }),
    false
  );
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
  assert.match(result.stdout, /invalid --chat target/i);
});

test('rejects raw forwarded args via double-dash', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--', '--prompt', 'bad']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forwarding raw Oracle args is no longer supported/);
});

test('rejects preset selection when config does not register any presets', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--preset', 'security']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /unknown preset 'security'/i);
});

test('requires config-registered presets before preset selection works', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
review_gpt_register_dir_preset "security" "security-audit.md" "Security review." "security-audit"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--preset', 'security']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt presets: security/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
});

test('reports no presets when config does not register any', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
browser_chrome_path="scripts/fake-chrome.sh"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--list-presets']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available presets: \(none configured\)/);
});

test('lists repo-registered presets from config and auto-adds all', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
browser_chrome_path="scripts/fake-chrome.sh"
review_gpt_register_preset "simplify" "agent-docs/prompts/simplify.md" "Complexity pass." "complexity"
review_gpt_register_preset "task-finish-review" "agent-docs/prompts/task-finish-review.md" "Final review pass."
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'agent-docs', 'prompts'), { recursive: true });
  writeFileSync(join(root, 'agent-docs', 'prompts', 'simplify.md'), 'Simplify prompt.\n');
  writeFileSync(join(root, 'agent-docs', 'prompts', 'task-finish-review.md'), 'Finish prompt.\n');

  const result = runCli(root, ['--list-presets']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all\s+- Include all registered preset sections\./);
  assert.match(result.stdout, /simplify\s+- Complexity pass\./);
  assert.match(result.stdout, /task-finish-review\s+- Final review pass\./);
  assert.doesNotMatch(result.stdout, /grief-vectors/);
});

test('uses repo-registered presets instead of compatibility defaults when config provides them', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
browser_chrome_path="scripts/fake-chrome.sh"
review_gpt_register_preset "simplify" "agent-docs/prompts/simplify.md" "Complexity pass." "complexity"
review_gpt_register_preset "task-finish-review" "agent-docs/prompts/task-finish-review.md" "Final review pass."
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'agent-docs', 'prompts'), { recursive: true });
  writeFileSync(join(root, 'agent-docs', 'prompts', 'simplify.md'), 'Simplify prompt.\n');
  writeFileSync(join(root, 'agent-docs', 'prompts', 'task-finish-review.md'), 'Finish prompt.\n');

  const allResult = runCli(root, ['--dry-run', '--preset', 'all']);
  assert.equal(allResult.status, 0, allResult.stderr);
  assert.match(allResult.stdout, /Prompt presets: simplify task-finish-review/);

  const securityResult = runCli(root, ['--dry-run', '--preset', 'security']);
  assert.equal(securityResult.status, 1);
  assert.match(securityResult.stdout, /unknown preset 'security'/i);
});

test('loads prompt content from --prompt-file', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt-file', 'scripts/chatgpt-review-presets/security-audit.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt presets: \(none\)/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
});

test('no-zip disables both XML and ZIP repo artifacts', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--no-zip']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt staging: none/);
  assert.match(result.stdout, /Repomix XML: \(disabled via --no-zip\)/);
  assert.match(result.stdout, /ZIP file: \(disabled via --no-zip\)/);
  assert.match(result.stdout, /BASE_COMMIT: \(disabled via --no-zip\)/);
});

test('errors when --prompt-file does not exist', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt-file', 'missing/prompt.md']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /required file not found/i);
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

test('cli model and thinking overrides win over config defaults', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
model="gpt-5.2-pro"
thinking="minimal"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--model', 'gpt-5.2-thinking', '--thinking', 'extended']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft model target: gpt-5\.2-thinking/);
  assert.match(result.stdout, /Draft thinking target: extended/);
});

test('normalizes assistant response text and skips prompt echoes', () => {
  const promptCandidates = ['please review this diff'];
  assert.equal(normalizeResponseText('Line 1\r\n\r\n\r\nLine 2  \n'), 'Line 1\n\nLine 2');
  assert.equal(
    sanitizeDeepResearchResponseText(
      '0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n0\n1\n2\n3\n4\n5\n6\n7\n8\n9\ncitations\nImproving an Atherogenic Particle–Discordant Lipid Profile\nImproving an Atherogenic Particle–Discordant Lipid Profile\nExecutive summary\nBody'
    ),
    'Improving an Atherogenic Particle–Discordant Lipid Profile\nExecutive summary\nBody'
  );
  assert.equal(isLikelyPromptEcho('Please review this diff', promptCandidates), true);

  const candidate = selectAssistantResponseCandidate(
    {
      assistantSnapshots: [
        { signature: 'old', text: 'Older answer', hasCopyButton: false },
        { signature: 'echo', text: 'Please review this diff', hasCopyButton: false },
        { signature: 'fresh', text: 'Here is the review summary.', hasCopyButton: true },
      ],
    },
    ['old'],
    promptCandidates
  );

  assert.equal(candidate.snapshot?.signature, 'fresh');
  assert.equal(candidate.snapshot?.hasCopyButton, true);
});

test('deep research busy detection ignores static labels but catches active progress', () => {
  assert.equal(responseStatusTextIndicatesBusy('Deep research'), false);
  assert.equal(responseStatusTextIndicatesBusy('Research complete'), false);
  assert.equal(responseStatusTextIndicatesBusy('Researching the web'), true);
  assert.equal(responseStatusTextIndicatesBusy('Analysis in progress'), true);
});

test('deep research response wait finishes only after a real completion signal', () => {
  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Research plan', hasCopyButton: false },
      generationActive: false,
      stableCount: 4,
      stablePollsRequired: 4,
      isDeepResearchMode: true,
      sawGenerationActive: false,
    }),
    false
  );

  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Final report', hasCopyButton: true },
      generationActive: false,
      stableCount: 1,
      stablePollsRequired: 4,
      isDeepResearchMode: true,
      sawGenerationActive: false,
    }),
    true
  );

  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Final report', hasCopyButton: false },
      generationActive: false,
      stableCount: 4,
      stablePollsRequired: 4,
      isDeepResearchMode: true,
      sawGenerationActive: true,
    }),
    true
  );
});

test('deep research response state merges sandbox report data into capture state', () => {
  const merged = mergeResponseCaptureStates(
    {
      assistantSnapshots: [{ signature: 'page', text: 'Older page response', hasCopyButton: false }],
      statusTexts: ['Deep research'],
      statusBusy: false,
      stopVisible: false,
    },
    {
      assistantSnapshots: [
        {
          signature: 'report',
          text: '0\n1\n2\n3\n4\n5\ncitations\nResearch completed in 4m\nExecutive summary\nBody',
          hasCopyButton: true,
        },
      ],
      statusTexts: ['Research completed in 4m'],
      statusBusy: false,
      stopVisible: false,
    }
  );

  assert.deepEqual(
    merged.assistantSnapshots.map((snapshot) => snapshot.signature),
    ['page', 'research completed in 4m executive summary body']
  );
  assert.deepEqual(merged.statusTexts, ['Deep research', 'Research completed in 4m']);
  assert.equal(merged.statusBusy, false);
  assert.equal(merged.assistantSnapshots[1]?.text, 'Research completed in 4m\nExecutive summary\nBody');
});

test('model picker accepts compact pro labels for gpt-5.4-pro targets', () => {
  assert.equal(modelPickerTextHasWord('Pro Research-grade intelligence', 'pro'), true);
  assert.equal(
    modelPickerLabelMatchesTarget('Pro Research-grade intelligence', {
      desiredVersion: '5-4',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    true
  );
  assert.equal(
    modelPickerLabelMatchesTarget('GPT 5.2 Pro', {
      desiredVersion: '5-4',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    false
  );
});

test('model picker treats trailing sprite checks as selected rows', () => {
  assert.equal(
    modelPickerSelectionStateMatches({
      hasCheckIcon: false,
      hasTrailingSpriteIcon: true,
      trailingText: '',
    }),
    true
  );
  assert.equal(
    modelPickerSelectionStateMatches({
      hasCheckIcon: false,
      hasTrailingSpriteIcon: true,
      trailingText: 'configure',
    }),
    false
  );
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
