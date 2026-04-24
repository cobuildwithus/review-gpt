import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const cliBin = join(repoRoot, 'dist', 'bin.mjs');
const distThreadCli = new URL('../dist/thread-cli.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const {
  buildChatGptCaptureStateExpression,
} = require('../src/chatgpt-dom-snapshot-shared.js');
const {
  buildExpectedAttachmentNames,
  buildDeepResearchStartClickPoint,
  evaluateAutoSendCommitState,
  formatAttachmentVerificationSummary,
  isRetryableSocketError,
  isLikelyPromptEcho,
  mergeResponseCaptureStates,
  modelPickerLabelMatchesTarget,
  modelPickerSelectionStateMatches,
  modelPickerTextHasWord,
  extractConversationHref,
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
  mkdirSync(join(root, 'src'), { recursive: true });

  writeFileSync(join(root, '.gitignore'), 'audit-packages/\n');
  writeFileSync(join(root, 'src', 'audit-source.ts'), 'export const auditSource = true;\n');

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
rm -f "$zip_path"
(cd "$PWD" && zip -q "$zip_path" src/audit-source.ts)
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

function listZipEntries(zipPath) {
  const result = spawnSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  for (;;) {
    if (existsSync(filePath)) {
      return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('stages inline custom prompt in dry-run mode', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt', 'custom prompt line']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Custom prompt chunks: 1/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
  assert.match(result.stdout, /Repomix attachment: .*repo\.repomix\.zip/);
  assert.match(result.stdout, /ZIP file: .*repo\.snapshot\.zip/);
  assert.match(result.stdout, /BASE_COMMIT: [0-9a-f]{40}/);
  assert.match(result.stdout, /ChatGPT mode: chat/);
  assert.match(result.stdout, /Draft model target: gpt-5\.4-pro/);
  assert.match(result.stdout, /Draft thinking target: current/);
  assert.match(result.stdout, /Draft send: disabled/);
  assert.match(result.stdout, /Response capture: disabled/);
  assert.match(result.stdout, /Dry run: browser launch skipped/);
});

test('detached wake launcher survives caller return and writes to its own log', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-detach-'));
  const markerPath = join(root, 'marker.txt');
  const logPath = join(root, 'wake.log');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { launchDetachedWakeProcess } = await import(distThreadCli);
  const { wakePid } = launchDetachedWakeProcess({
    args: [
      '-e',
      `setTimeout(() => {
        require('node:fs').appendFileSync(${JSON.stringify(logPath)}, 'child-finished\\n');
        require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ok\\n');
        process.exit(0);
      }, 150);`,
    ],
    cwd: root,
    env: process.env,
    logPath,
  });

  assert.equal(typeof wakePid, 'number');
  assert.equal(wakePid > 0, true);

  await waitForFile(markerPath);

  assert.equal(readFileSync(markerPath, 'utf8'), 'ok\n');
  assert.match(readFileSync(logPath, 'utf8'), /child-finished/u);
});

test('runs package script through bash even when wrapper is not executable', (t) => {
  const root = createFixtureRepo({ packageScriptMode: 0o644 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix attachment: .*repo\.repomix\.zip/);
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
  assert.match(result.stdout, /Repomix attachment: .*repo\.repomix\.zip/);
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
  assert.doesNotMatch(result.stdout, /--prompt-only/u);
  assert.match(result.stdout, /skills add\s+Sync skill files to agents/);
});

test('root help includes the thread subcommand group', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /delay\s+Schedule a delayed top-level review-gpt run/u);
  assert.match(result.stdout, /thread\s+Export ChatGPT threads, download patch, diff, or zip attachments, and launch delayed Codex follow-up work\./);
});

test('delay help is available through the incur subcommand tree', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['delay', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cobuild-review-gpt delay \[preset\] \[options\]/);
  assert.match(result.stdout, /--delay <string>/);
  assert.match(result.stdout, /--retry-attempts <number>/);
  assert.match(result.stdout, /--retry-delay <string>/);
  assert.match(result.stdout, /--label <string>/);
});

test('thread wake help is available through the incur subcommand tree', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['thread', 'wake', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cobuild-review-gpt thread wake \[options\]/);
  assert.match(result.stdout, /--codex-home <string>/);
  assert.match(result.stdout, /--detach <boolean>/);
  assert.match(result.stdout, /--poll-interval <string>/);
  assert.match(result.stdout, /--poll-timeout <string>/);
  assert.match(result.stdout, /--poll-until-complete <boolean>/);
  assert.match(result.stdout, /--recursive-depth <number>/);
  assert.match(result.stdout, /--recursive-prompt <string>/);
  assert.match(result.stdout, /--resume-prompt <string>/);
  assert.match(result.stdout, /--skip-resume <boolean>/);
  assert.match(result.stdout, /--tab-lifecycle <keep\|close-created>/);
});

test('delay runs a dry-run preset after the scheduled delay and records status and logs', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
review_gpt_register_dir_preset "security" "security-audit.md" "Security review." "security-audit"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, [
    'delay',
    'security',
    '--config',
    'scripts/review-gpt.config.sh',
    '--delay',
    '0s',
    '--retry-attempts',
    '1',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const delayRoot = join(root, 'output-packages', 'review-gpt-delay');
  const [runDirEntry] = readdirSync(delayRoot);
  assert.ok(runDirEntry);
  const runDir = join(delayRoot, runDirEntry);
  const statusPayload = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8'));
  assert.equal(statusPayload.state, 'succeeded');
  assert.equal(statusPayload.attemptCount, 1);
  assert.equal(statusPayload.responseFile, '');

  const log = readFileSync(join(runDir, 'run.log'), 'utf8');
  assert.match(log, /Prompt presets: security/u);
  assert.match(log, /Draft send: enabled \(auto-submit\)/u);
  assert.match(log, /Dry run: browser launch skipped/u);
});

test('delay follow-ups on an existing thread default to wait mode, a response file, and the built-in prompt', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, [
    'delay',
    '--config',
    'scripts/review-gpt.config.sh',
    '--chat-url',
    'https://chatgpt.com/c/example-thread',
    '--delay',
    '0s',
    '--retry-attempts',
    '1',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const delayRoot = join(root, 'output-packages', 'review-gpt-delay');
  const [runDirEntry] = readdirSync(delayRoot);
  assert.ok(runDirEntry);
  const runDir = join(delayRoot, runDirEntry);
  const statusPayload = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8'));
  assert.equal(statusPayload.state, 'succeeded');
  assert.match(statusPayload.responseFile, /output-packages\/review-gpt-delay\/.*\/response\.md$/u);

  const log = readFileSync(join(runDir, 'run.log'), 'utf8');
  assert.match(log, /Custom prompt chunks: 1/u);
  assert.match(log, /Response capture: enabled \(600000ms timeout\)/u);
  assert.match(log, /Wait behavior: block until the assistant finishes or the wait timeout is hit\./u);
  assert.match(log, /Response file: .*response\.md/u);
  assert.match(log, /ChatGPT URL: https:\/\/chatgpt\.com\/c\/example-thread/u);
});

test('thread diagnose help is available through the incur subcommand tree', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['thread', 'diagnose', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cobuild-review-gpt thread diagnose \[options\]/);
  assert.match(result.stdout, /--command-label <string>/);
  assert.match(result.stdout, /--log-file <string>/);
  assert.match(result.stdout, /--receipt-path <string>/);
});

test('detached wake command args preserve recursive prompt overrides', async (t) => {
  const { buildDetachedWakeCommandArgs } = await import(distThreadCli);
  const args = buildDetachedWakeCommandArgs({
    browserEndpoint: 'http://127.0.0.1:9222',
    chatUrl: 'https://chatgpt.com/c/example-thread',
    delay: '0s',
    detach: false,
    downloadTimeoutMs: 30000,
    fullAuto: false,
    outputDir: '/tmp/output',
    pollInterval: '1m',
    pollJitter: '1m',
    pollUntilComplete: true,
    recursiveDepth: 1,
    recursivePrompt: 'apply the returned plan cleanly and attach a patch',
    repoDir: '/tmp/repo',
    sessionId: 'session-123',
    skipResume: false,
    tabLifecycle: 'close-created',
  });

  const recursivePromptIndex = args.indexOf('--recursive-prompt');
  assert.notEqual(recursivePromptIndex, -1);
  assert.equal(args[recursivePromptIndex + 1], 'apply the returned plan cleanly and attach a patch');
  const tabLifecycleIndex = args.indexOf('--tab-lifecycle');
  assert.notEqual(tabLifecycleIndex, -1);
  assert.equal(args[tabLifecycleIndex + 1], 'close-created');
});

test('thread export rejects a non-conversation chat URL before touching the browser', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['thread', 'export', '--chat-url', 'https://chatgpt.com/', '--output', 'out.json']);
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Expected a full ChatGPT conversation URL like https:\/\/chatgpt\.com\/c\/<thread-id>/,
  );
});

test('evaluateAutoSendCommitState treats a cleared composer with a new prompt turn as committed', () => {
  const result = evaluateAutoSendCommitState({
    baselineSnapshot: {
      turnCount: 4,
      userTurnSignatures: ['older prompt'],
    },
    promptCandidates: ['new prompt body for review'],
    state: {
      assistantVisible: false,
      composerHasText: false,
      inConversation: true,
      recentUserTurnSignatures: ['older prompt', 'new prompt body for review and patch'],
      stopVisible: false,
      turnsCount: 5,
    },
  });

  assert.equal(result.committed, true);
  assert.equal(result.newUserTurnSignature, 'new prompt body for review and patch');
});

test('evaluateAutoSendCommitState prefers the latest unseen prompt-matching user turn', () => {
  const result = evaluateAutoSendCommitState({
    baselineSnapshot: {
      turnCount: 36,
      userTurnSignatures: [
        'repo repomix 188 xml file repo snapshot 195 zip zip archive check my changes around the target area addressed in this thread for bugs issues before production then review the same area thoroughly for architecture simplification we are greenfield and want the simplest best long term architecture return a patch or diff a',
      ],
    },
    promptCandidates: [
      'check my changes around the target area addressed in this thread for bugs issues before production then review the same area thoroughly for architecture simplification',
    ],
    state: {
      assistantVisible: true,
      composerHasText: false,
      inConversation: true,
      recentUserTurnSignatures: [
        'repo repomix 175 xml file repo snapshot 182 zip zip archive pasted text 2 txt document we support cloudflare email sending for our hosted app flow can you review their blog post and see if our implementation is canonical and in the best simplest shape and architecture it can be in then lets discuss anything you think w',
        'as a side note afaik we did raw mime specific for a reason since we are scoping users to their accounts with reply aliases i think but might be wrong there but worth double checking',
        'repo repomix 176 xml file repo snapshot 183 zip zip archive please review your idea and plan thoroughly against our code ensure its correct and gets us towards the best minimal complexity simplest long term architecture for our goals of letting murph reply talk to you over cloudflare email service for all of our hosted',
        'repo repomix 180 xml file repo snapshot 187 zip zip archive pasted text 3 txt document please implement your plan 1 8 incredibly thoroughly and return a patch file with the code changes',
        'repo repomix 188 xml file repo snapshot 195 zip zip archive check my changes around the target area addressed in this thread for bugs issues before production then review the same area thoroughly for architecture simplification we are greenfield and want the simplest best long term architecture return a patch or diff a',
        'repo repomix 594 xml file repo snapshot 614 zip zip archive check my changes around the target area addressed in this thread for bugs issues before production then review the same area thoroughly for architecture simplification we are greenfield and want the simplest best long term architecture return a patch or diff a',
      ],
      stopVisible: true,
      turnsCount: 37,
    },
  });

  assert.equal(result.committed, true);
  assert.equal(
    result.newUserTurnSignature,
    'repo repomix 594 xml file repo snapshot 614 zip zip archive check my changes around the target area addressed in this thread for bugs issues before production then review the same area thoroughly for architecture simplification we are greenfield and want the simplest best long term architecture return a patch or diff a',
  );
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

test('draft target selection prefers reusing specific chat routes before opening duplicate tabs', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /function shouldPreferExistingTarget\(desiredUrl\)/u);
  assert.match(
    source,
    /if \(shouldPreferExistingTarget\(desiredUrl\)\) \{\s+const existing = await pickTarget\(desiredUrl\);\s+if \(existing\) return existing;\s+\} else \{\s+const created = await openNewTarget\(desiredUrl\);\s+if \(created\) \{\s+return created;\s+\}\s+\}/u,
  );
});

test('extracts canonical conversation URLs from thread locations only', () => {
  assert.equal(extractConversationHref('https://chatgpt.com/'), '');
  assert.equal(
    extractConversationHref('https://chatgpt.com/c/abc123?model=gpt-5.4-pro'),
    'https://chatgpt.com/c/abc123',
  );
  assert.equal(
    extractConversationHref('/c/xyz789/', 'https://chatgpt.com'),
    'https://chatgpt.com/c/xyz789',
  );
});

test('top-level positional preset shorthand is handled through incur args instead of argv preprocessing', () => {
  const source = readFileSync(join(repoRoot, 'src', 'bin.mts'), 'utf8');
  assert.match(source, /args:\s*z\.object\(\{\s*preset:\s*z\.string\(\)\.optional\(\)/u);
  assert.doesNotMatch(source, /preprocessPresetShorthandArgs/);
});

test('artifact prompt boilerplate is not injected by default', () => {
  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');
  assert.doesNotMatch(source, /Use repo\.repomix\.xml as the primary review artifact./);
  assert.doesNotMatch(source, /Use repo\.snapshot\.zip only as a fidelity fallback\/source of truth./);
  assert.doesNotMatch(source, /Generate unified diff patches against BASE_COMMIT=/);
});

test('model selection flow treats the composer chip as a valid completion signal', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const getComposerChipLabel = \(\) => \{/);
  assert.match(source, /const currentSelectionLabel = \(\) => getComposerChipLabel\(\) \|\| getButtonLabel\(\);/);
  assert.match(source, /finish\(\{ status: 'switched', label: currentSelectionLabel\(\) \|\| match\.label \}\);/);
  assert.match(source, /const collectFallbackOptionNodes = \(\) =>/);
  assert.match(source, /status: 'selection-timeout'/);
});

test('autosend waits for a stable conversation URL before reporting it', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const waitForConversationStateAfterSend = async/u);
  assert.match(source, /stableConversationCount >= 2/u);
  assert.match(source, /sendResult\?\.conversationHref/u);
});

test('parent cli emits stable thread summary lines after autosend', () => {
  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');
  assert.match(source, /ChatGPT thread URL:/);
  assert.match(source, /ChatGPT thread ID:/);
});

test('attachment upload stages files individually before verification', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /for \(let index = 0; index < filesToAttach\.length; index \+= 1\)/);
  assert.match(source, /files:\s*\[filesToAttach\[index\]\]/);
  assert.match(source, /\}\s+\n\s*verification = await verifyDraftAttachments/u);
});

test('attachment input selection prefers upload-files over image-only inputs', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /if \(id === 'upload files'\) score \+= 1000;/);
  assert.match(source, /if \(id === 'upload photos' \|\| id === 'upload camera'\) score -= 1000;/);
  assert.match(source, /const imageOnlyAccept =/);
  assert.match(source, /if \(imageOnlyAccept\) score -= 500;/);
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

test('accepts explicit boolean values through incur parsing', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', 'true', '--wait', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft send: enabled \(auto-submit\)/);
  assert.match(result.stdout, /Response capture: enabled \(600000ms timeout\)/);
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

test('accepts positional preset shorthand tokens for the top-level command', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
review_gpt_register_dir_preset "simplify" "simplify.md" "Complexity pass." "complexity"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'scripts', 'chatgpt-review-presets', 'simplify.md'), 'Simplify prompt.\n');

  const result = runCli(root, ['simplify', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt presets: simplify/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
});

test('loads prompt content from --prompt-file', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt-file', 'scripts/chatgpt-review-presets/security-audit.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt presets: \(none\)/);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
});

test('dry-run stages the compressed repomix attachment and snapshot zip', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt staging: none/);
  assert.match(result.stdout, /Repomix attachment: /);
  assert.match(result.stdout, /ZIP file: /);
  assert.match(result.stdout, /BASE_COMMIT: /);

  const repomixAttachmentPath = join(root, 'audit-packages', 'repo.repomix.zip');
  assert.equal(existsSync(repomixAttachmentPath), true);
  assert.deepEqual(listZipEntries(repomixAttachmentPath), ['repo.repomix.xml']);
});

test('config can keep the raw repomix xml attachment', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
repomix_attachment_format="xml"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repomix attachment: .*repo\.repomix\.xml/);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.zip')), false);
});

test('config can disable repomix attachment entirely', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
repomix_attachment_format="none"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.zip')), false);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.xml')), false);
});

test('repomix xml is bounded to the packaged manifest by default', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'src', 'extra.ts'), 'export const extra = true;\n');
  writeFileSync(join(root, '.env'), 'TOP_SECRET=1\n');
  writeFileSync(join(root, '.env.local'), 'ALSO_SECRET=1\n');
  writeFileSync(
    join(root, 'node_modules', 'left-pad', 'index.js'),
    'module.exports = "secret dependency";\n',
  );

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);

  const repomixPath = join(root, 'audit-packages', 'repo.repomix.xml');
  assert.equal(existsSync(repomixPath), true);
  const xml = readFileSync(repomixPath, 'utf8');
  assert.match(xml, /src\/audit-source\.ts|export const auditSource = true/);
  assert.doesNotMatch(xml, /src\/extra\.ts|export const extra = true/);
  assert.doesNotMatch(xml, /TOP_SECRET=1/);
  assert.doesNotMatch(xml, /ALSO_SECRET=1/);
  assert.doesNotMatch(xml, /node_modules\/left-pad|secret dependency/);
});

test('repomix includes packaged output-packages content by default', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, '.gitignore'), 'audit-packages/\noutput-packages/\n');
  mkdirSync(join(root, 'output-packages', 'research'), { recursive: true });
  writeFileSync(join(root, 'output-packages', 'research', 'context.md'), 'whole-body context\n');
  writeFileSync(
    join(root, 'scripts', 'package-audit-context.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
zip_path="$PWD/audit-packages/test-audit.zip"
rm -f "$zip_path"
(cd "$PWD" && zip -q "$zip_path" output-packages/research/context.md)
echo "Audit package created."
echo "Included files: 1"
echo "ZIP: $zip_path (1K)"
`,
  );
  chmodSync(join(root, 'scripts', 'package-audit-context.sh'), 0o755);

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);

  const xml = readFileSync(join(root, 'audit-packages', 'repo.repomix.xml'), 'utf8');
  assert.match(xml, /output-packages\/research\/context\.md|whole-body context/);
});

test('consuming repos can opt into repomix ignore patterns', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
repomix_ignore_patterns=(
  "output-packages/**"
)
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'output-packages', 'research'), { recursive: true });
  writeFileSync(join(root, 'output-packages', 'research', 'context.md'), 'whole-body context\n');
  writeFileSync(
    join(root, 'scripts', 'package-audit-context.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
zip_path="$PWD/audit-packages/test-audit.zip"
rm -f "$zip_path"
(cd "$PWD" && zip -q "$zip_path" output-packages/research/context.md)
echo "Audit package created."
echo "Included files: 1"
echo "ZIP: $zip_path (1K)"
`,
  );
  chmodSync(join(root, 'scripts', 'package-audit-context.sh'), 0o755);

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);

  const xml = readFileSync(join(root, 'audit-packages', 'repo.repomix.xml'), 'utf8');
  assert.doesNotMatch(xml, /output-packages\/research\/context\.md|whole-body context/);
});

test('rejects removed prompt-only flag', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--prompt-only', 'true']);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown flag: --prompt-only|Unknown option '--prompt-only'|Unexpected argument '--prompt-only'|did you mean/u);
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

test('standard response wait ignores copy visibility until the response is stable', () => {
  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Draft answer', hasCopyButton: true },
      generationActive: false,
      stableCount: 1,
      stablePollsRequired: 2,
      isDeepResearchMode: false,
      sawGenerationActive: false,
    }),
    false
  );

  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Draft answer', hasCopyButton: true },
      generationActive: false,
      stableCount: 2,
      stablePollsRequired: 2,
      isDeepResearchMode: false,
      sawGenerationActive: false,
    }),
    true
  );
});

test('deep research response wait finishes only after stable completion following active research', () => {
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
    false
  );

  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Final report', hasCopyButton: true },
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
      stableCount: 4,
      stablePollsRequired: 4,
      isDeepResearchMode: true,
      sawGenerationActive: true,
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

test('thread capture state preserves full assistant text without a 20k export cap', () => {
  const longText = 'A'.repeat(28_500);
  const assistantNode = {
    innerText: longText,
    textContent: longText,
    parentElement: null,
    querySelector: () => null,
  };
  const userNode = {
    compareDocumentPosition(node) {
      return node === assistantNode ? 4 : 0;
    },
  };
  const root = {
    innerText: `${longText}\n\nuser prompt`,
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="assistant"')) {
        return [assistantNode];
      }
      if (selector.includes('data-message-author-role="user"')) {
        return [userNode];
      }
      return [];
    },
  };

  const captureState = vm.runInNewContext(buildChatGptCaptureStateExpression(), {
    URL,
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
    },
    document: {
      body: root,
      querySelector: (selector) => (selector === 'main' ? root : null),
      readyState: 'complete',
      title: 'Thread',
    },
    location: {
      href: 'https://chatgpt.com/c/example-thread',
    },
    window: {
      getComputedStyle: () => ({
        display: 'block',
        visibility: 'visible',
      }),
    },
  });

  assert.equal(captureState.assistantSnapshots.length, 1);
  assert.equal(captureState.assistantSnapshots[0]?.text.length, longText.length);
  assert.equal(captureState.assistantSnapshots[0]?.text, longText);
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

test('model picker accepts generic thinking and instant labels for gpt-5.2 aliases', () => {
  assert.equal(modelPickerTextHasWord('ThinkingFor complex questions', 'thinking'), true);
  assert.equal(modelPickerTextHasWord('InstantFor everyday chats', 'instant'), true);
  assert.equal(
    modelPickerLabelMatchesTarget('ThinkingFor complex questions', {
      desiredVersion: '5-2',
      wantsPro: false,
      wantsInstant: false,
      wantsThinking: true,
    }),
    true
  );
  assert.equal(
    modelPickerLabelMatchesTarget('InstantFor everyday chats', {
      desiredVersion: '5-2',
      wantsPro: false,
      wantsInstant: true,
      wantsThinking: false,
    }),
    true
  );
  assert.equal(
    modelPickerLabelMatchesTarget('ThinkingFor complex questions', {
      desiredVersion: '5-4',
      wantsPro: false,
      wantsInstant: false,
      wantsThinking: true,
    }),
    true
  );
  assert.equal(
    modelPickerLabelMatchesTarget('Pro Research-grade intelligence', {
      desiredVersion: '5-2',
      wantsPro: false,
      wantsInstant: false,
      wantsThinking: true,
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

test('summarizeAttachmentVerification does not confirm attachments while uploads are still in progress', () => {
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

  assert.equal(summary.confirmed, false);
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

test('summarizeAttachmentVerification accepts sequential uploads once all expected filenames are visible', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 3,
      attachmentUiSignature: 'repo repomix zip repo snapshot zip remove',
      attachmentText: 'repo.repomix.zip repo.snapshot.zip',
      composerText: '',
      uploading: false,
      fileInputReady: true,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 3,
      attachmentUiSignature: 'repo repomix zip repo snapshot zip remove',
    },
    ['repo.repomix.zip', 'repo.snapshot.zip'],
    2
  );

  assert.equal(summary.confirmed, true);
  assert.equal(summary.namesVisible, true);
  assert.equal(summary.attachedEnough, false);
});

test('summarizeAttachmentVerification accepts staged multi-file uploads when the file input undercounts', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 3,
      attachmentUiSignature: 'repo repomix zip repo snapshot zip remove',
      attachmentText: '',
      composerText: '',
      uploading: false,
      fileInputReady: true,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 1,
      attachmentUiSignature: 'existing attachment',
    },
    ['repo.repomix.zip', 'repo.snapshot.zip'],
    2
  );

  assert.equal(summary.confirmed, true);
  assert.equal(summary.namesVisible, false);
  assert.equal(summary.attachedCount, 1);
  assert.equal(summary.effectiveAttachedCount, 2);
  assert.equal(summary.attachedEnough, true);
  assert.match(formatAttachmentVerificationSummary(summary), /attached=2\/2/);
});

test('autosend waits for send-button-disabled states instead of failing immediately', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const waitForAutoSendReadiness = async/u);
  assert.match(source, /if \(buttonAttempt\?\.status === 'send-button-disabled'\)/u);
});

test('autosend uses the configured timeout instead of a hidden 30 second cap', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const sendDeadline = Date\.now\(\) \+ Math\.max\(8_000, timeoutMs\);/u);
  assert.doesNotMatch(source, /const sendDeadline = Date\.now\(\) \+ Math\.max\(8_000, Math\.min\(30_000, timeoutMs\)\);/u);
});
