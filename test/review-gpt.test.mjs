import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const cliBin = join(repoRoot, 'dist', 'bin.mjs');
const distReviewGptLib = new URL('../dist/review-gpt-lib.mjs', import.meta.url);
const distThreadCli = new URL('../dist/thread-cli.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const {
  buildChatGptCaptureStateExpression,
  canonicalizeChatGptTurnNodes,
  collectChatGptTurnAttachmentTexts,
  CHATGPT_USER_TURN_ATTACHMENT_SELECTOR,
  chatGptTextIndicatesRateLimit,
  extractModelConfirmationText,
} = require('../src/chatgpt-dom-snapshot-shared.js');
const {
  buildIdleDraftInspectionExpression,
  idleDraftCanClose,
  registerIdleDraftCleanup,
} = require('../src/idle-draft-cleaner.js');
const {
  appConnectorLabelMatchesTarget,
  appConnectorMentionText,
  authStatusIsUnauthenticated,
  appendModelConfirmationPrompt,
  assertMarkedResponseDurationTrusted,
  buildAttachmentNameMatcher,
  buildExpectedAttachmentNames,
  buildDeepResearchStartClickPoint,
  buildThreadCaptureIdentity,
  declaredArtifactCaptureFailure,
  declaredSingleArtifactSha256,
  committedTurnAttachmentVerification,
  createWebSocketOwner,
  ensureDraftThinkingSelected,
  evaluateAutoSendCommitState,
  extractModelConfirmationValue,
  formatModelSelectionFailureMessage,
  formatAttachmentVerificationSummary,
  hardRefreshDue,
  isRetryableSocketError,
  isLikelyPromptEcho,
  markedResponseDurationFailure,
  mergeResponseCaptureStates,
  modelAttestationForSnapshot,
  modelConfirmationFailure,
  modelConfirmationRequired,
  modelPickerControlSelectionProof,
  modelPickerLabelMatchesTarget,
  modelPickerOptionCanTraverseTarget,
  modelPickerOptionMatchesTarget,
  modelPickerOptionIsFinalTarget,
  modelPickerOptionSelectionProof,
  modelPickerSummarySelectionProof,
  modelPickerSelectionStateMatches,
  modelPickerTextHasWord,
  modelPickerUnavailableReason,
  extractConversationHref,
  normalizeAppConnectorText,
  normalizeAttachmentSearchText,
  normalizeResponseText,
  removeConfirmedAttachmentFiles,
  removeModelVerificationEvidenceFile,
  retryTransientUnauthenticatedSession,
  resolveAcceptedConversationAfterSend,
  sanitizeDeepResearchResponseText,
  nextResponseStabilityCount,
  responseStateAssistantFailureText,
  responseStateIndicatesChatGptRateLimit,
  responseStatusTextIndicatesBusy,
  scoreDeepResearchStartButtonCandidate,
  selectAssistantResponseCandidate,
  selectExactAcceptedTarget,
  selectUniqueDeepResearchIframeTarget,
  shouldAttemptDeepResearchStartFallback,
  shouldFinishAssistantResponseWait,
  timeoutSnapshotMissingResponseMarker,
  summarizeAttachmentVerification,
  writeCompletedResponseArtifacts,
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
    if (existsSync(filePath) && readFileSync(filePath, 'utf8').length > 0) {
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
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: .*codebase\.zip/);
  assert.match(result.stdout, /BASE_COMMIT: [0-9a-f]{40}/);
  assert.match(result.stdout, /ChatGPT mode: chat/);
  assert.match(result.stdout, /Draft model target: gpt-5\.6-sol/);
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
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: .*codebase\.zip/);
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
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: .*codebase\.zip/);
});

test('accepts explicit model and independent thinking overrides', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--model', 'gpt-5.2-thinking', '--thinking', 'standard']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft model target: gpt-5\.2-thinking/);
  assert.match(result.stdout, /Draft thinking target: standard/);
});

test('rejects xhigh and legacy extended thinking targets instead of mapping them to Pro', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const thinking of ['xhigh', 'extended']) {
    const result = runCli(root, ['--dry-run', '--model', 'gpt-5.6-sol', '--thinking', thinking]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, new RegExp(`thinking target.*${thinking}.*unsupported`, 'iu'));
    assert.match(output, /use --thinking current with the Pro model/iu);
  }
});

test('accepts explicit ChatGPT app connector overrides', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--app-connector', 'github']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /App connector target: github/);
});

test('connector alias overrides app connector config defaults', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
app_connector="github"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const configResult = runCli(root, ['--dry-run']);
  assert.equal(configResult.status, 0, configResult.stderr);
  assert.match(configResult.stdout, /App connector target: github/);

  const overrideResult = runCli(root, ['--dry-run', '--connector', 'current']);
  assert.equal(overrideResult.status, 0, overrideResult.stderr);
  assert.match(overrideResult.stdout, /App connector target: current/);
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
  assert.match(result.stdout, /Response capture: enabled \(7200000ms timeout\)/);
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
    /--wait\s+Auto-submit and stay attached until the assistant finishes or the wait timeout is hit\./
  );
  assert.match(result.stdout, /--model <string>\s+Draft model target\. gpt-5\.6-sol \(default\) and pro target the current ChatGPT Pro model\./);
  assert.match(result.stdout, /matching MODEL_CONFIRMATION response line and compatible response-model metadata\./);
  assert.match(result.stdout, /--thinking <string>\s+Draft thinking target\. Use current for normal Pro runs; xhigh and legacy extended are unsupported and fail closed\./);
  assert.match(result.stdout, /--app-connector <string>\s+ChatGPT app connector target, such as github\. Alias: --connector\./);
  assert.match(result.stdout, /--connector <string>\s+Alias for --app-connector\./);
  assert.match(result.stdout, /--artifacts\s+Attach repo artifact context\. Use --no-artifacts for connector-only review context\./);
  assert.match(result.stdout, /--zip\s+Attach the repo ZIP\. Use --no-zip to skip artifacts\./);
  assert.match(result.stdout, /--idle-draft-timeout <string>\s+After this grace period, close an unsent draft tab once it is hidden and inactive \(default: 30m; 0 disables cleanup\)\./);
  assert.match(result.stdout, /--minimum-marked-response-time <string>\s+Minimum elapsed time required when a marked concrete-model response lacks compatible response-model metadata \(default: 5m; must be positive\)\./);
  assert.match(result.stdout, /--response-marker <string>\s+Only treat a captured response as final when it contains this exact text; fast marked concrete-model reviews still require compatible response-model metadata or the --minimum-marked-response-time fallback \(use with --wait\)\./);
  assert.doesNotMatch(result.stdout, /--prompt-only/u);
  assert.match(result.stdout, /skills\s+Sync skill files to agents \(add, list\)/);
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
  assert.match(result.stdout, /--model <string>\s+Draft model target\. gpt-5\.6-sol \(default\) and pro target the current ChatGPT Pro model\./);
  assert.match(result.stdout, /matching MODEL_CONFIRMATION response line and compatible response-model metadata\./);
  assert.match(result.stdout, /--thinking <string>\s+Draft thinking target\. Use current for normal Pro runs; xhigh and legacy extended are unsupported and fail closed\./);
  assert.match(result.stdout, /--minimum-marked-response-time <string>\s+Minimum elapsed time required when a marked concrete-model response lacks compatible response-model metadata \(default: 5m; must be positive\)\./);
  assert.match(result.stdout, /--response-marker <string>\s+Only accept a captured response containing this exact completion marker\./);
});

test('thread wake help is available through the incur subcommand tree', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runRawCli(root, ['thread', 'wake', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cobuild-review-gpt thread wake \[options\]/);
  assert.match(result.stdout, /--codex-home <string>/);
  assert.match(result.stdout, /--detach\s+Launch the wake loop in a detached background process/);
  assert.match(result.stdout, /--poll-interval <string>/);
  assert.match(result.stdout, /--poll-timeout <string>/);
  assert.match(result.stdout, /--poll-until-complete\s+Poll until the thread no longer looks busy/);
  assert.match(result.stdout, /--recursive-depth <number>/);
  assert.match(result.stdout, /--recursive-prompt <string>/);
  assert.match(result.stdout, /--resume-prompt <string>/);
  assert.match(result.stdout, /--skip-resume\s+Export and download only/);
  assert.match(result.stdout, /--tab-lifecycle <keep\|close-created\|close-harvested>/);
  assert.match(result.stdout, /default: close-harvested/);
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
  assert.match(log, /Response capture: enabled \(7200000ms timeout\)/u);
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
    captureMetadata: 'audit-packages/review.md.capture.json',
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
  const captureMetadataIndex = args.indexOf('--capture-metadata');
  assert.notEqual(captureMetadataIndex, -1);
  assert.equal(args[captureMetadataIndex + 1], 'audit-packages/review.md.capture.json');
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
  assert.match(result.stdout, /App connector target: current/);
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

test('app connector selection uses native clicks and verifies selected state', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /buildAppConnectorSelectionProbeExpression/);
  assert.match(source, /clickNativePoint/);
  assert.match(source, /Page\.bringToFront/);
  assert.match(source, /click-target/);
  assert.match(source, /already-selected/);
  assert.match(source, /selectDraftAppConnectorByMention/);
  assert.match(source, /buildAppConnectorMentionSuggestionProbeExpression/);
  assert.match(source, /__menu-item/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(source, /const pressNativeEnter = async \(\) =>/);
  assert.match(source, /await pressNativeEnter\(\);/);
  assert.match(source, /preserveComposerPrefix/);
  assert.match(source, /appendDraftComposerPromptNatively/);
  assert.match(source, /Input\.insertText/);
  assert.match(source, /appendDraftComposerPromptNatively\(draftPrompt\)/);
  assert.doesNotMatch(source, /setDraftComposerPrompt\(draftPrompt, \{\s*append:/);
  assert.match(source, /data-inline-selection-pill/);
  assert.match(source, /data-id\^="connector:"/);
  assert.match(source, /dataSymbol === 'ecosystemMention'/);
  assert.match(source, /const findComposerRoot = \(\) => \{/);
  assert.match(source, /composerRoot\.querySelectorAll\('button, \[role="button"\], \[aria-label\], \[aria-haspopup="menu"\], \[data-testid\]'\)/);
  assert.doesNotMatch(source, /Array\.from\(document\.querySelectorAll\(\s*'button, \[role="button"\], \[aria-label\], \[aria-haspopup="menu"\], \[data-testid\]'\s*\)\)/);
});

test('draft target selection always creates a fresh ChatGPT target', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.doesNotMatch(source, /function shouldPreferExistingTarget/u);
  assert.doesNotMatch(source, /async function pickTarget/u);
  assert.doesNotMatch(source, /sameOrigin|sameHost/u);
  assert.match(source, /async function openNewTarget\(desiredUrl, socketOwner\)/u);
  assert.match(source, /Target\.createTarget/u);
  assert.match(source, /background:\s*true/u);
  assert.doesNotMatch(source, /\/json\/new/u);
  assert.match(source, /return await openNewTarget\(desiredUrl, socketOwner\);/u);
  assert.match(source, /Timed out creating a fresh ChatGPT target/u);
});

test('retained draft cleanup can release page focus outside the staging block', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /let releasePageFocusEmulation = async \(\) => \{\};\s+try \{/u);
  assert.match(source, /releasePageFocusEmulation = async \(\) => \{/u);
  assert.doesNotMatch(source, /const releasePageFocusEmulation = async \(\) => \{/u);
  assert.match(source, /await releasePageFocusEmulation\(\);/u);
});

test('idle draft cleanup only closes hidden drafts without active generation', () => {
  assert.equal(idleDraftCanClose({ busy: false, visible: false }), true);
  assert.equal(idleDraftCanClose({ busy: true, visible: false }), false);
  assert.equal(idleDraftCanClose({ busy: false, visible: true }), false);
  assert.equal(idleDraftCanClose(null), false);

  const expression = buildIdleDraftInspectionExpression();
  assert.match(expression, /document\.visibilityState === 'visible'/u);
  assert.match(expression, /document\.querySelectorAll/u);
});

test('idle draft cleanup registration writes a private exact-target lease', (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'review-gpt-idle-drafts-test-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));

  const registered = registerIdleDraftCleanup({
    now: 1_000,
    port: 9_333,
    startWorker: false,
    stateRoot,
    targetId: 'target_ABC-123',
    timeoutMs: 60_000,
  });

  assert.equal(registered, true);
  const leasePath = join(stateRoot, '9333', 'target_ABC-123.json');
  const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.deepEqual(lease, {
    expiresAt: 61_000,
    port: 9_333,
    targetId: 'target_ABC-123',
  });
  assert.equal(statSync(leasePath).mode & 0o777, 0o600);
});

test('zero idle draft timeout disables lease registration', (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'review-gpt-idle-drafts-off-test-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));

  assert.equal(registerIdleDraftCleanup({
    port: 9_334,
    startWorker: false,
    stateRoot,
    targetId: 'target-disabled',
    timeoutMs: 0,
  }), false);
  assert.deepEqual(readdirSync(stateRoot), []);
});

test('extracts canonical conversation URLs from thread locations only', () => {
  assert.equal(extractConversationHref('https://chatgpt.com/'), '');
  assert.equal(
    extractConversationHref(
      'https://chatgpt.com/c/WEB:cce5dd98-0157-4ba5-9394-1b065250e301',
    ),
    '',
  );
  assert.equal(
    extractConversationHref(
      'https://chatgpt.com/c/WEB%3Acce5dd98-0157-4ba5-9394-1b065250e301',
    ),
    '',
  );
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
  assert.match(source, /const MODEL_BUTTON_SELECTORS = \[/);
  assert.match(source, /button\.__composer-pill\[aria-haspopup="menu"\]/);
  assert.match(source, /const findModelButton = \(\) => \{/);
  assert.match(source, /const refreshButton = \(\) => \{/);
  assert.match(source, /const getComposerChipLabel = \(\) => \{/);
  assert.match(source, /if \(!visible\(candidate\)\) continue;/);
  assert.match(source, /const currentSelectionLabel = \(\) => getComposerChipLabel\(\) \|\| getButtonLabel\(\);/);
  assert.match(source, /normalizedLabel === 'advanced'/);
  assert.match(source, /const findBestTraversalOption = \(\) => \{/);
  assert.match(source, /modelPickerSummarySelectionProof\(snapshot, target\)/);
  assert.match(source, /const collectFallbackOptionNodes = \(\) =>/);
  assert.match(source, /status: 'selection-timeout'/);
});

test('autosend waits for a stable conversation URL before reporting it', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const waitForConversationStateAfterSend = async/u);
  assert.match(source, /stableConversationCount >= 2/u);
  assert.match(source, /let observedConversationHref = '';/u);
  const conversationWait = source.slice(
    source.indexOf('const waitForConversationStateAfterSend = async'),
    source.indexOf('const autoSendDraftMessage = async'),
  );
  assert.doesNotMatch(
    conversationWait,
    /if \(isDeepResearchMode\)/u,
    'Deep Research must wait for its canonical conversation URL too',
  );
  const buttonSendBranch = source.slice(
    source.indexOf("if (clickAttempt?.status === 'clicked')"),
    source.indexOf("if (clickAttempt?.status === 'send-button-not-found')"),
  );
  const enterSendBranch = source.slice(
    source.indexOf("if (enterAttempt?.status === 'enter-dispatched')"),
    source.indexOf("lastAttempt = {", source.indexOf("if (enterAttempt?.status === 'enter-dispatched')")),
  );
  for (const branch of [buttonSendBranch, enterSendBranch]) {
    const waitIndex = branch.indexOf('waitForConversationStateAfterSend');
    const retainIndex = branch.indexOf('retainAcceptedSendTarget');
    const persistIndex = branch.indexOf('persistAcceptedSendIdentity');
    assert.ok(retainIndex >= 0, 'send branch must retain ownership immediately after commit');
    assert.ok(waitIndex >= 0, 'send branch must wait for the canonical conversation URL');
    assert.ok(persistIndex >= 0, 'send branch must persist the exact capture identity');
    assert.ok(retainIndex < waitIndex, 'send branch must retain ownership before URL stabilization');
    assert.ok(persistIndex > waitIndex, 'send branch must not validate the URL before stabilization');
  }
  assert.doesNotMatch(
    source,
    /if \(stableConversationHref && committedState\?\.inConversation\)/u,
  );
  assert.doesNotMatch(
    source,
    /String\(sendResult\?\.state\?\.href \|\| ''\)/u,
  );
  assert.match(source, /sendResult\?\.conversationHref/u);
});

test('autosend accepts a canonical conversation URL that appears after commit', async () => {
  const committedState = { href: 'https://chatgpt.com/' };
  let waitCalls = 0;
  const result = await resolveAcceptedConversationAfterSend({
    commitResult: { state: committedState },
    desiredTargetOrigin: 'https://chatgpt.com',
    maxWaitMs: 15_000,
    waitForConversationStateAfterSend: async (state, maxWaitMs) => {
      waitCalls += 1;
      assert.equal(state, committedState);
      assert.equal(maxWaitMs, 15_000);
      return {
        href: 'https://chatgpt.com/c/delayed-thread-id',
        state: {
          href: 'https://chatgpt.com/c/delayed-thread-id',
          inConversation: true,
        },
        status: 'ready',
      };
    },
  });

  assert.equal(waitCalls, 1);
  assert.equal(result.conversationHref, 'https://chatgpt.com/c/delayed-thread-id');
  assert.equal(result.conversationStateResult.status, 'ready');
});

test('parent cli emits stable thread summary lines after autosend', () => {
  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');
  assert.match(source, /ChatGPT thread URL:/);
  assert.match(source, /ChatGPT thread ID:/);
});

test('parent cli preserves a sent thread when response capture fails', async () => {
  const { extractConversationUrlFromDriverOutput } = await import(distReviewGptLib);
  const sentThreadUrl = 'https://chatgpt.com/c/recoverable-thread';
  assert.equal(
    extractConversationUrlFromDriverOutput(
      `Draft auto-send triggered.\nChatGPT conversation URL: ${sentThreadUrl}\nAssistant wait in progress.\nDraft staging failed: socket disconnected\n`,
    ),
    sentThreadUrl,
  );

  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');
  assert.match(source, /ChatGPT accepted the review prompt, but ReviewGPT could not finish response capture/);
  assert.match(source, /Inspect or resume this existing thread before retrying so the review is not sent twice/);
  assert.match(source, /const diagnosticChatUrl = input\.error\.conversationUrl \?\? input\.chatgptUrl/);
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
  assert.match(result.stdout, /Response capture: enabled \(7200000ms timeout\)/);
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
  assert.match(result.stdout, /Response capture: enabled \(7200000ms timeout\)/);
});

test('explicit wait timeout overrides the 120 minute response default', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--wait', '--wait-timeout', '90m']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Response capture: enabled \(5400000ms timeout\)/);
  assert.match(result.stdout, /Draft timeout: 600000ms/);
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

test('dry-run stages only codebase.zip by default', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt staging: none/);
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: .*codebase\.zip/);
  assert.match(result.stdout, /BASE_COMMIT: /);

  assert.equal(existsSync(join(root, 'audit-packages', 'codebase.zip')), true);
  assert.equal(existsSync(join(root, 'audit-packages', 'test-audit.zip')), false);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.zip')), false);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.xml')), false);
});

test('no-zip mode skips package and attachment generation', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--no-zip']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: disabled/);
  assert.match(result.stdout, /BASE_COMMIT: [0-9a-f]{40}/);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.zip')), false);
  assert.equal(existsSync(join(root, 'audit-packages', 'repo.repomix.xml')), false);
  assert.equal(existsSync(join(root, 'audit-packages', 'codebase.zip')), false);
});

test('advertised no-artifacts mode skips package and attachment generation', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--no-artifacts']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: disabled/);
  assert.equal(existsSync(join(root, 'audit-packages', 'codebase.zip')), false);
});

test('advertised no-tests mode is accepted by the parser', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--no-tests']);
  assert.equal(result.status, 0, result.stderr);
});

test('config can disable artifacts and point at a repository connector context', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/missing-package-script.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
app_connector="github"
repo_context_url="https://github.com/example/repo"
attach_artifacts=0
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prompt staging: inline composer prefill/);
  assert.match(result.stdout, /App connector target: github/);
  assert.match(result.stdout, /Repository context URL: https:\/\/github\.com\/example\/repo/);
  assert.doesNotMatch(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: disabled/);
});

test('zip flag can override config-disabled artifacts', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
attach_artifacts=0
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--zip']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Audit package created\./);
  assert.match(result.stdout, /Repomix attachment: disabled/);
  assert.match(result.stdout, /ZIP file: .*codebase\.zip/);
});

test('config can rename the snapshot zip attachment', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
snapshot_attachment_name="review-gpt.repo-snapshot.zip"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ZIP file: .*review-gpt\.repo-snapshot\.zip/);
  assert.equal(existsSync(join(root, 'audit-packages', 'review-gpt.repo-snapshot.zip')), true);
  assert.equal(existsSync(join(root, 'audit-packages', 'test-audit.zip')), false);
  assert.equal(existsSync(join(root, 'audit-packages', 'codebase.zip')), false);
});

test('config rejects snapshot attachment names that are paths', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
snapshot_attachment_name="../codebase.zip"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /snapshot_attachment_name must be a filename, not a path/);
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

test('config can opt into the compressed repomix attachment', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
repomix_attachment_format="zip"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repomix attachment: .*repo\.repomix\.zip/);
  assert.deepEqual(
    listZipEntries(join(root, 'audit-packages', 'repo.repomix.zip')),
    ['repo.repomix.xml'],
  );
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

test('opt-in repomix is bounded to the packaged manifest', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
repomix_attachment_format="zip"
`,
  });
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

test('opt-in repomix includes packaged output-packages content', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_chrome_path="scripts/fake-chrome.sh"
repomix_attachment_format="zip"
`,
  });
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
repomix_attachment_format="zip"
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
  assert.match(result.stdout, /Managed browser background mode: balanced/);
  assert.match(result.stdout, /Managed browser display mode: headful/);
  assert.match(result.stdout, /Managed browser launch mode: foreground/);
  assert.match(result.stdout, /Managed browser close after wait: disabled/);
  assert.match(result.stdout, /Browser binary: .*fake-chrome\.sh/);
});

test('supports closing a dedicated managed browser after a successful wait', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_close_after_wait="true"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--wait']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed browser close after wait: enabled/);
});

test('supports background managed browser launch without changing the default', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_launch_mode="background"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed browser launch mode: background/);
});

test('rejects unknown managed browser launch modes', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_launch_mode="hidden"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /invalid managed_browser_launch_mode.*foreground.*background/iu);
});

test('idle draft cleanup defaults to 30m and accepts CLI or config overrides', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const defaultResult = runCli(root, ['--dry-run']);
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.match(defaultResult.stdout, /Idle draft cleanup: close hidden, inactive unsent drafts after 1800000ms/);

  const cliResult = runCli(root, ['--dry-run', '--idle-draft-timeout', '0']);
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /Idle draft cleanup: disabled/);

  writeFileSync(
    join(root, 'scripts', 'review-gpt.config.sh'),
    `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
idle_draft_timeout_ms="5m"
`,
  );
  const configResult = runCli(root, ['--dry-run']);
  assert.equal(configResult.status, 0, configResult.stderr);
  assert.match(configResult.stdout, /Idle draft cleanup: close hidden, inactive unsent drafts after 300000ms/);
});

test('marked response minimum defaults to 5m and accepts positive CLI or config overrides', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const defaultResult = runCli(root, ['--dry-run', '--wait', '--response-marker', 'REVIEW_COMPLETE']);
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.match(defaultResult.stdout, /Minimum marked response time: 300000ms/);

  const cliResult = runCli(root, [
    '--dry-run',
    '--wait',
    '--response-marker',
    'REVIEW_COMPLETE',
    '--minimum-marked-response-time',
    '90s',
  ]);
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /Minimum marked response time: 90000ms/);

  writeFileSync(
    join(root, 'scripts', 'review-gpt.config.sh'),
    `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
minimum_marked_response_ms="2m"
`,
  );
  const configResult = runCli(root, ['--dry-run', '--wait', '--response-marker', 'REVIEW_COMPLETE']);
  assert.equal(configResult.status, 0, configResult.stderr);
  assert.match(configResult.stdout, /Minimum marked response time: 120000ms/);

  const disabledResult = runCli(root, [
    '--dry-run',
    '--minimum-marked-response-time',
    '0',
  ]);
  assert.notEqual(disabledResult.status, 0);
  assert.match(`${disabledResult.stdout}\n${disabledResult.stderr}`, /must be a positive, finite duration/u);
});

test('supports a headless managed browser display mode', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_display_mode="headless"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed browser display mode: headless/);
});

test('allows --headless to override a headful managed browser config', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_display_mode="headful"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run', '--headless']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed browser display mode: headless/);
});

test('rejects unknown managed browser display modes', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_display_mode="invisible"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /invalid managed_browser_display_mode.*headful.*headless/iu);
});

test('accepts the fully unthrottled managed browser fallback', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_background_mode="unthrottled"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed browser background mode: unthrottled/);
});

test('rejects unknown managed browser background modes', (t) => {
  const root = createFixtureRepo({
    configBody: `#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
preset_dir="scripts/chatgpt-review-presets"
browser_binary_path="scripts/fake-chrome.sh"
managed_browser_background_mode="maximum"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCli(root, ['--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /invalid managed_browser_background_mode.*balanced.*unthrottled/iu);
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

  const result = runCli(root, ['--dry-run', '--model', 'gpt-5.2-thinking', '--thinking', 'standard']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft model target: gpt-5\.2-thinking/);
  assert.match(result.stdout, /Draft thinking target: standard/);
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
        { signature: 'fresh', text: 'Here is the review summary.', hasCopyButton: true, modelSlug: 'gpt-5-6-pro' },
      ],
    },
    ['old'],
    promptCandidates
  );

  assert.equal(candidate.snapshot?.signature, 'fresh');
  assert.equal(candidate.snapshot?.hasCopyButton, true);
  assert.equal(candidate.snapshot?.modelSlug, 'gpt-5-6-pro');
});

test('send commit identity distinguishes a repeated prompt and verifies files on only that turn', () => {
  const baseline = {
    turnCount: 2,
    userTurnIds: ['data-message-id:user-old'],
    userTurnSignatures: ['run the audit'],
  };
  const committedTurn = {
    attachmentTexts: ['Attached file codebase(3).zip'],
    signature: 'run the audit',
    turnId: 'data-message-id:user-new',
    turnIndex: 1,
  };
  const commit = evaluateAutoSendCommitState({
    baselineSnapshot: baseline,
    promptCandidates: ['run the audit'],
    state: {
      assistantVisible: true,
      composerHasText: false,
      inConversation: true,
      recentUserTurns: [
        {
          attachmentTexts: ['Earlier codebase.zip'],
          signature: 'run the audit',
          turnId: 'data-message-id:user-old',
          turnIndex: 0,
        },
        committedTurn,
      ],
      recentUserTurnSignatures: ['run the audit'],
      turnsCount: 3,
    },
  });

  assert.equal(commit.committed, true);
  assert.equal(commit.committedUserTurn?.turnId, 'data-message-id:user-new');
  assert.deepEqual(
    committedTurnAttachmentVerification(commit.committedUserTurn, ['codebase.zip']),
    {
      confirmed: true,
      expectedNames: ['codebase.zip'],
      matchedNames: ['codebase.zip'],
      turnId: 'data-message-id:user-new',
    },
  );
  assert.equal(
    committedTurnAttachmentVerification(
      { ...committedTurn, attachmentTexts: [] },
      ['codebase.zip'],
    ).confirmed,
    false,
  );
});

test('waited capture identity binds the exact response and its artifact controls', () => {
  const assistantSnapshot = {
    assistantTurnId: 'data-message-id:assistant-new',
    assistantTurnIndex: 4,
    precedingUserMessageSignature: 'correct the patch',
    precedingUserTurnId: 'data-message-id:user-new',
    precedingUserTurnIndex: 2,
    signature: 'replacement patch ready',
    text: 'Replacement patch ready.',
  };
  const capture = buildThreadCaptureIdentity({
    assistantSnapshot,
    attachmentButtons: [
      {
        artifactIndexInAssistantTurn: 0,
        assistantTurnId: assistantSnapshot.assistantTurnId,
        assistantTurnIndex: assistantSnapshot.assistantTurnIndex,
        href: 'sandbox:/mnt/data/fix.patch',
        text: 'fix.patch',
      },
    ],
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/thread-new',
    committedUserTurn: {
      signature: 'correct the patch',
      turnId: 'data-message-id:user-new',
      turnIndex: 2,
    },
    targetId: 'target-new',
  });

  assert.equal(capture.browserEndpoint, 'http://127.0.0.1:9333');
  assert.equal(capture.assistantResponse?.assistantTurnId, 'data-message-id:assistant-new');
  assert.equal(capture.artifacts[0]?.artifactIndexInAssistantTurn, 0);
  assert.match(capture.artifacts[0]?.label, /^sha256:[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(capture);
  assert.doesNotMatch(serialized, /correct the patch|replacement patch ready|sandbox:\/mnt\/data\/fix\.patch/iu);
  assert.match(serialized, /sha256:[a-f0-9]{64}/u);
});

test('waited capture rejects a declared patch when no downloadable assistant control exists', () => {
  const assistantSnapshot = {
    assistantTurnId: 'data-message-id:assistant-new',
    assistantTurnIndex: 4,
    precedingUserMessageSignature: 'correct the patch',
    precedingUserTurnId: 'data-message-id:user-new',
    precedingUserTurnIndex: 2,
    signature: 'patch artifact response',
    text: 'Patch artifact: `reviewgpt-coverage.patch`',
  };
  const capture = buildThreadCaptureIdentity({
    assistantSnapshot,
    attachmentButtons: [{
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: assistantSnapshot.assistantTurnId,
      assistantTurnIndex: assistantSnapshot.assistantTurnIndex,
      href: null,
      text: 'reviewgpt-coverage.patch',
    }],
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/thread-new',
    committedUserTurn: {
      signature: 'correct the patch',
      turnId: 'data-message-id:user-new',
      turnIndex: 2,
    },
    targetId: 'target-new',
  });

  assert.deepEqual(capture.artifacts, []);
  assert.match(
    declaredArtifactCaptureFailure(assistantSnapshot.text, []),
    /declared patch artifact reviewgpt-coverage\.patch.*not present.*No downloadable assistant attachment/u,
  );
  assert.equal(
    declaredArtifactCaptureFailure(assistantSnapshot.text, ['reviewgpt-coverage.patch']),
    '',
  );
});

test('waited capture rejects a different attachment when the declared patch is missing', () => {
  const responseText = 'Patch artifact: `reviewgpt-coverage.patch`';

  assert.match(
    declaredArtifactCaptureFailure(responseText, ['citation-notes.md']),
    /declared patch artifact reviewgpt-coverage\.patch.*not present.*citation-notes\.md/u,
  );
  assert.equal(
    declaredArtifactCaptureFailure(responseText, ['reviewgpt-coverage.patch', 'citation-notes.md']),
    '',
  );
});

test('waited capture binds one assistant-declared SHA-256 to one downloadable artifact', () => {
  const contentSha256 = 'a'.repeat(64);
  const assistantSnapshot = {
    assistantTurnId: 'data-message-id:assistant-new',
    assistantTurnIndex: 4,
    precedingUserMessageSignature: 'correct the patch',
    precedingUserTurnId: 'data-message-id:user-new',
    precedingUserTurnIndex: 2,
    signature: 'patch artifact response',
    text: `Download fix.patch\nSHA-256: ${contentSha256}`,
  };
  const capture = buildThreadCaptureIdentity({
    assistantSnapshot,
    attachmentButtons: [{
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: assistantSnapshot.assistantTurnId,
      assistantTurnIndex: assistantSnapshot.assistantTurnIndex,
      behaviorButton: true,
      href: null,
      text: 'fix.patch',
    }],
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/thread-new',
    committedUserTurn: {
      signature: 'correct the patch',
      turnId: 'data-message-id:user-new',
      turnIndex: 2,
    },
    targetId: 'target-new',
  });

  assert.equal(capture.artifacts[0]?.contentSha256, contentSha256);
  assert.equal(declaredSingleArtifactSha256(assistantSnapshot.text, 1), contentSha256);
  assert.equal(
    declaredSingleArtifactSha256(`${assistantSnapshot.text}\nSHA-256: ${'b'.repeat(64)}`, 1),
    '',
  );
});

test('capture sidecar hashes data URLs and signed artifact routes instead of retaining their contents', () => {
  const prompt = 'private prompt prefix must not persist';
  const response = 'private response prefix must not persist';
  const signedHref = 'data:text/plain;base64,c2lnbmVkLXNlY3JldA==?token=private-token';
  const capture = buildThreadCaptureIdentity({
    assistantSnapshot: {
      assistantTurnId: 'data-message-id:assistant',
      assistantTurnIndex: 1,
      precedingUserMessageSignature: prompt,
      precedingUserTurnId: 'data-message-id:user',
      precedingUserTurnIndex: 0,
      signature: response,
      text: response,
    },
    attachmentButtons: [{
      artifactIndexInAssistantTurn: 0,
      assistantTurnId: 'data-message-id:assistant',
      assistantTurnIndex: 1,
      download: true,
      href: signedHref,
      text: 'download private artifact',
    }],
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/private-thread',
    committedUserTurn: { signature: prompt, turnId: 'data-message-id:user', turnIndex: 0 },
    targetId: 'private-target',
  });
  const serialized = JSON.stringify(capture);

  assert.equal(capture.schemaVersion, 2);
  assert.doesNotMatch(serialized, /private prompt prefix|private response prefix|c2lnbmVk|private-token|data:text/iu);
  assert.match(capture.artifacts[0]?.href, /^sha256:[a-f0-9]{64}$/u);
  assert.match(capture.artifacts[0]?.label, /^sha256:[a-f0-9]{64}$/u);
});

test('exact reconnect target selection never falls back to another same-thread tab', () => {
  const targets = [
    {
      id: 'older-target',
      type: 'page',
      url: 'https://chatgpt.com/c/thread-new',
      webSocketDebuggerUrl: 'ws://example/older',
    },
    {
      id: 'accepted-target',
      type: 'page',
      url: 'https://chatgpt.com/c/thread-new?branch=latest',
      webSocketDebuggerUrl: 'ws://example/accepted',
    },
  ];

  assert.equal(
    selectExactAcceptedTarget(targets, 'accepted-target', 'https://chatgpt.com/c/thread-new')?.id,
    'accepted-target',
  );
  assert.equal(
    selectExactAcceptedTarget(targets, 'missing-target', 'https://chatgpt.com/c/thread-new'),
    null,
  );
});

test('direct wait recovery reuses wake target recovery and persists only a validated replacement', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  const threadLibrarySource = readFileSync(join(repoRoot, 'src', 'chatgpt-thread-lib.mts'), 'utf8');
  const reconnectSource = source.slice(
    source.indexOf('const reconnectExactAcceptedTarget = async'),
    source.indexOf('const buildClickDispatcher ='),
  );
  const sharedRecoverySource = threadLibrarySource.slice(
    threadLibrarySource.indexOf('export async function captureThreadTargetSnapshot'),
    threadLibrarySource.indexOf('export async function exportThreadSnapshot'),
  );

  assert.match(reconnectSource, /threadCaptureLibrary\.captureThreadTargetSnapshot\(/u);
  assert.match(reconnectSource, /replacementRecoveryAttempted = true/u);
  assert.match(reconnectSource, /targetId: replacementTargetId/u);
  assert.match(sharedRecoverySource, /ensureTargetLease\([\s\S]*?captureIdentity\.targetId,[\s\S]*?true,/u);
  assert.match(sharedRecoverySource, /scopeCapturedThreadSnapshot\([\s\S]*?captureIdentity,/u);
  assert.match(sharedRecoverySource, /!captureSucceeded && targetLease\.rehydrated/u);
  assert.equal(
    reconnectSource.indexOf('captureThreadTargetSnapshot(') <
      reconnectSource.indexOf('writeThreadCaptureIdentity(captureMetadataFile, replacementCaptureIdentity)'),
    true,
  );
  assert.doesNotMatch(reconnectSource, /selectExactAcceptedTarget\(targets, pageTargetId/u);
});

test('originating Deep Research capture refuses multiple report frames before report identity exists', () => {
  const currentReportFrame = {
    id: 'deep-report-current',
    parentId: 'accepted-target',
    title: 'Deep Research',
    type: 'iframe',
    url: 'https://chatgpt.com/connector_openai_deep_research/report/current',
    webSocketDebuggerUrl: 'ws://example/deep-report-current',
  };
  const staleReportFrame = {
    id: 'deep-report-stale',
    parentId: 'accepted-target',
    title: 'Deep Research',
    type: 'iframe',
    url: 'https://chatgpt.com/connector_openai_deep_research/report/stale',
    webSocketDebuggerUrl: 'ws://example/deep-report-stale',
  };
  const unrelatedFrame = {
    id: 'deep-report-other-tab',
    parentId: 'other-target',
    title: 'Deep Research',
    type: 'iframe',
    url: 'https://chatgpt.com/connector_openai_deep_research/report/other',
    webSocketDebuggerUrl: 'ws://example/deep-report-other-tab',
  };

  assert.equal(
    selectUniqueDeepResearchIframeTarget(
      [unrelatedFrame, currentReportFrame],
      'accepted-target',
    )?.id,
    currentReportFrame.id,
  );
  assert.throws(
    () => selectUniqueDeepResearchIframeTarget(
      [currentReportFrame, staleReportFrame, unrelatedFrame],
      'accepted-target',
    ),
    /resolved to 2 frames before the report identity was known; refusing ambiguous response capture/u,
  );
});

test('one websocket owner closes every driver socket through the bounded shutdown path', async (t) => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class OwnedFakeWebSocket {
    listeners = new Map();

    constructor(url) {
      this.url = url;
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close() {
      this.closed = true;
      for (const listener of this.listeners.get('close') || []) listener({});
    }
  }
  globalThis.WebSocket = OwnedFakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const owner = createWebSocketOwner();
  owner.create('ws://example/one');
  owner.create('ws://example/two');
  await owner.closeAll();

  assert.equal(sockets.length, 2);
  assert.equal(sockets.every((socket) => socket.closed), true);
  assert.match(
    source,
    /if \(acceptedSendProven && operationError && !completedResponseCapture\) \{[\s\S]*?ownedTargetId = '';/u,
  );
  const retainAcceptedSendTargetSource = source.match(
    /const retainAcceptedSendTarget = \(\) => \{[\s\S]*?\n  \};/u,
  )?.[0] ?? '';
  assert.match(retainAcceptedSendTargetSource, /acceptedSendProven = true;/u);
  assert.doesNotMatch(retainAcceptedSendTargetSource, /ownedTargetId = '';/u);
  assert.equal(
    (source.match(/retainAcceptedSendTarget\(\);\s+const acceptedConversation = await resolveAcceptedConversationAfterSend\([\s\S]*?const exactConversationHref = persistAcceptedSendIdentity\(\s+commitResult,\s+acceptedConversation\.conversationHref,\s+\)/gu) || []).length,
    2,
  );
  assert.match(source, /await flushProcessOutput\(\);\s+await socketOwner\.closeAll\(\);/u);
});

test('driver preflight preserves prior recovery metadata until a new send is accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-preserve-capture-'));
  const capturePath = join(root, 'response.capture.json');
  const previousCapture = '{"schemaVersion":1,"targetId":"previous-target"}\n';
  writeFileSync(capturePath, previousCapture, { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(repoRoot, 'src', 'prepare-chatgpt-draft.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORACLE_DRAFT_REMOTE_PORT: '',
      ORACLE_DRAFT_URL: 'https://chatgpt.com/',
      REVIEW_GPT_DRAFT_CAPTURE_METADATA_FILE: capturePath,
    },
  });
  const retainedCapture = readFileSync(capturePath, 'utf8');
  rmSync(root, { force: true, recursive: true });

  assert.notEqual(result.status, 0);
  assert.equal(retainedCapture, previousCapture);
});

test('deep research busy detection ignores static labels but catches active progress', () => {
  assert.equal(responseStatusTextIndicatesBusy('Deep research'), false);
  assert.equal(responseStatusTextIndicatesBusy('Research complete'), false);
  assert.equal(responseStatusTextIndicatesBusy('Researching the web'), true);
  assert.equal(responseStatusTextIndicatesBusy('Analysis in progress'), true);
});

test('response stability only accrues across quiet polls', () => {
  // Stability built while generation is active must not count: an interim
  // status message would otherwise be captured the moment the busy indicator
  // flickers off between tool phases.
  assert.equal(
    nextResponseStabilityCount({
      stableCount: 11,
      candidateMatchesPrevious: true,
      candidateHasText: true,
      generationActive: true,
    }),
    0
  );

  assert.equal(
    nextResponseStabilityCount({
      stableCount: 3,
      candidateMatchesPrevious: true,
      candidateHasText: true,
      generationActive: false,
    }),
    4
  );

  assert.equal(
    nextResponseStabilityCount({
      stableCount: 5,
      candidateMatchesPrevious: false,
      candidateHasText: true,
      generationActive: false,
    }),
    1
  );

  assert.equal(
    nextResponseStabilityCount({
      stableCount: 5,
      candidateMatchesPrevious: false,
      candidateHasText: false,
      generationActive: false,
    }),
    0
  );
});

test('response capture hard-refreshes on a ten-minute cadence', () => {
  const startedAt = 1_000;

  assert.equal(hardRefreshDue(startedAt, startedAt + 599_999), false);
  assert.equal(hardRefreshDue(startedAt, startedAt + 600_000), true);

  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /await cdp\('Page\.reload', \{ ignoreCache: true \}\);/u);
  assert.match(source, /stableCount = 0;\s+continue;/u);
});

test('initial unauthorized auth probe hard-refreshes once before deciding the session is signed out', async () => {
  const calls = [];
  const statuses = [
    { ok: false, status: 401 },
    { ok: true, status: 200 },
  ];
  const recovered = await retryTransientUnauthenticatedSession({
    hardRefresh: async () => calls.push('hard-refresh'),
    onRetry: () => calls.push('retry'),
    probeAuthenticatedSession: async () => {
      calls.push('probe');
      return statuses.shift();
    },
  });

  assert.deepEqual(calls, ['probe', 'retry', 'hard-refresh', 'probe']);
  assert.deepEqual(recovered, {
    authStatus: { ok: true, status: 200 },
    hardRefreshed: true,
  });
  assert.equal(authStatusIsUnauthenticated(recovered.authStatus), false);

  let persistentProbeCount = 0;
  let persistentRefreshCount = 0;
  const persistent = await retryTransientUnauthenticatedSession({
    hardRefresh: async () => {
      persistentRefreshCount += 1;
    },
    probeAuthenticatedSession: async () => {
      persistentProbeCount += 1;
      return { ok: false, status: 403 };
    },
  });
  assert.equal(persistentProbeCount, 2);
  assert.equal(persistentRefreshCount, 1);
  assert.equal(authStatusIsUnauthenticated(persistent.authStatus), true);

  let authenticatedRefreshCount = 0;
  const alreadyAuthenticated = await retryTransientUnauthenticatedSession({
    hardRefresh: async () => {
      authenticatedRefreshCount += 1;
    },
    probeAuthenticatedSession: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(authenticatedRefreshCount, 0);
  assert.equal(alreadyAuthenticated.hardRefreshed, false);

  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  const authRefreshSource = source.slice(
    source.indexOf('const hardRefreshInitialPageForAuthRetry = async'),
    source.indexOf('const readResponseCaptureState = async'),
  );
  assert.match(authRefreshSource, /Page\.reload', \{ ignoreCache: true \}/u);
  assert.match(authRefreshSource, /state\?\.refreshMarker !== refreshMarker/u);
});

test('a deadline snapshot without the completion marker reports the timeout, not a model mismatch', () => {
  // A wait that times out mid-generation captures whatever was on screen,
  // which for a reasoning model is the streamed reasoning summary. That text
  // has no MODEL_CONFIRMATION line yet, so attesting the model before checking
  // the marker reported "did not include MODEL_CONFIRMATION" for an ordinary
  // timeout and sent operators after the prompt or the model selection.
  const reasoningOnlySnapshot = [
    'Inspected and extracted ZIP contents, contracts, and scripts',
    'Identified potential issues',
    'Finalizing answer',
  ].join('\n');

  assert.equal(
    timeoutSnapshotMissingResponseMarker('REVIEW_COMPLETE', reasoningOnlySnapshot),
    true
  );

  // A genuinely complete response is left for the model attestation to judge.
  assert.equal(
    timeoutSnapshotMissingResponseMarker(
      'REVIEW_COMPLETE',
      'Findings: ...\nMODEL_CONFIRMATION: gpt-5.6-sol\nREVIEW_COMPLETE'
    ),
    false
  );

  // No marker requirement leaves the attestation as the only gate.
  assert.equal(timeoutSnapshotMissingResponseMarker('', reasoningOnlySnapshot), false);
});

test('response wait holds out for the completion marker when one is required', () => {
  // An interim status message that stabilizes during quiet polls must not be
  // captured when a completion marker is required and absent.
  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'I will inspect the PR and report back.', hasCopyButton: true },
      generationActive: false,
      stableCount: 12,
      stablePollsRequired: 12,
      isDeepResearchMode: false,
      sawGenerationActive: true,
      responseMarker: 'REVIEW_COMPLETE',
    }),
    false
  );

  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Findings: ...\n\nREVIEW_COMPLETE', hasCopyButton: true },
      generationActive: false,
      stableCount: 12,
      stablePollsRequired: 12,
      isDeepResearchMode: false,
      sawGenerationActive: true,
      responseMarker: 'REVIEW_COMPLETE',
    }),
    true
  );

  // No marker requirement preserves the existing stability-only behavior.
  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: { text: 'Plain answer', hasCopyButton: true },
      generationActive: false,
      stableCount: 12,
      stablePollsRequired: 12,
      isDeepResearchMode: false,
      sawGenerationActive: false,
      responseMarker: '',
    }),
    true
  );
});

test('marked concrete-model reviews use the duration floor only without concrete model evidence', () => {
  assert.match(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: 'REVIEW_COMPLETE',
      responseElapsedMs: 37_000,
    }),
    /37s, below the 5m minimum.*without compatible response-model metadata.*untrusted and was not attested/u,
  );
  assert.equal(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: 'SPECIALIST_REVIEW_COMPLETE',
      responseElapsedMs: 37_000,
      hasConcreteModelEvidence: true,
    }),
    '',
  );
  assert.equal(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: 'REVIEW_COMPLETE',
      responseElapsedMs: 2 * 60 * 1000,
      minimumResponseMs: 2 * 60 * 1000,
    }),
    '',
  );
  assert.match(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: 'REVIEW_COMPLETE',
      responseElapsedMs: 37_000,
      minimumResponseMs: 2 * 60 * 1000,
    }),
    /37s, below the 2m minimum.*untrusted and was not attested/u,
  );
  assert.match(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: 'REVIEW_COMPLETE',
      responseElapsedMs: 37_000,
      minimumResponseMs: 0,
    }),
    /invalid configured duration.*untrusted and was not attested/u,
  );
  assert.equal(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: '',
      responseElapsedMs: 37_000,
    }),
    '',
  );
  assert.equal(
    markedResponseDurationFailure({
      targetModel: 'current',
      responseMarker: 'REVIEW_COMPLETE',
      responseElapsedMs: 37_000,
    }),
    '',
  );
});

test('fast marked responses attest concrete platform model evidence before duration fallback', () => {
  const committedUserTurnSignature = 'review exact specialist packet';
  const attestation = modelAttestationForSnapshot(
    'gpt-5.6-sol',
    {
      modelConfirmationText: 'MODEL_CONFIRMATION: gpt-5.6-sol',
      modelSlug: 'gpt-5-6-pro',
      precedingUserMessageSignature: committedUserTurnSignature,
      text: 'Specialist findings\nMODEL_CONFIRMATION: gpt-5.6-sol\nSPECIALIST_REVIEW_COMPLETE',
    },
    true,
    committedUserTurnSignature,
    37_000,
  );

  assert.equal(attestation.failure, '');
  assert.ok(attestation.evidence);
  assert.equal(
    markedResponseDurationFailure({
      targetModel: 'gpt-5.6-sol',
      responseMarker: 'SPECIALIST_REVIEW_COMPLETE',
      responseElapsedMs: 37_000,
      hasConcreteModelEvidence: Boolean(attestation.evidence),
    }),
    '',
  );

  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  const completionBranch = source.slice(
    source.indexOf(
      'const modelAttestation = modelAttestationForSnapshot(',
      source.indexOf('shouldFinishAssistantResponseWait'),
    ),
    source.indexOf('// A capture snapshot traverses a large live ChatGPT DOM.'),
  );
  assert.match(completionBranch, /hasConcreteModelEvidence: Boolean\(modelAttestation\.evidence\)/u);
  assert.equal(
    completionBranch.indexOf('const modelAttestation = modelAttestationForSnapshot(') <
      completionBranch.indexOf('const responseDurationFailure = markedResponseDurationFailure('),
    true,
  );
});

test('too-fast marked responses throw, preserve diagnostics, and do not emit attestation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-too-fast-'));
  const responsePath = join(root, 'response.md');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => assertMarkedResponseDurationTrusted({
      status: 'response-too-fast',
      responseDurationFailure: 'Assistant response completed below the configured minimum.',
      responseText: 'MODEL_CONFIRMATION: gpt-5.6-sol\nREVIEW_COMPLETE',
    }, responsePath),
    /below the configured minimum/u,
  );
  assert.equal(readFileSync(responsePath, 'utf8'), 'MODEL_CONFIRMATION: gpt-5.6-sol\nREVIEW_COMPLETE\n');
  assert.equal(existsSync(`${responsePath}.model-verification.json`), false);
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
      expectedContentSource: 'deep-research-iframe',
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
      candidate: { text: 'Researching', hasCopyButton: true },
      expectedContentSource: 'deep-research-iframe',
      generationActive: false,
      stableCount: 4,
      stablePollsRequired: 4,
      isDeepResearchMode: true,
      sawGenerationActive: true,
    }),
    false
  );

  assert.equal(
    shouldFinishAssistantResponseWait({
      candidate: {
        contentSource: 'deep-research-iframe',
        text: 'Final report',
        hasCopyButton: true,
      },
      expectedContentSource: 'deep-research-iframe',
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
      candidate: {
        contentSource: 'deep-research-iframe',
        text: 'Final report',
        hasCopyButton: false,
      },
      expectedContentSource: 'deep-research-iframe',
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

test('production Deep Research merge preserves exact waited-turn eligibility through capture identity', () => {
  const driverSource = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  const committedUserTurn = {
    signature: 'audit the browser lifecycle',
    turnId: 'data-message-id:user-deep',
    turnIndex: 2,
  };
  const pageAssistantAnchor = {
    afterLastUserMessage: true,
    assistantTurnId: 'data-message-id:assistant-deep',
    assistantTurnIndex: 3,
    hasCopyButton: false,
    precedingUserMessageSignature: committedUserTurn.signature,
    precedingUserTurnId: committedUserTurn.turnId,
    precedingUserTurnIndex: committedUserTurn.turnIndex,
    signature: 'research workspace',
    text: 'Researching',
  };
  const state = mergeResponseCaptureStates(
    {
      assistantSnapshots: [pageAssistantAnchor],
      attachmentButtons: [{
        artifactIndexInAssistantTurn: 0,
        assistantTurnId: pageAssistantAnchor.assistantTurnId,
        assistantTurnIndex: pageAssistantAnchor.assistantTurnIndex,
        href: 'sandbox:/mnt/data/deep-report.md',
        text: 'deep-report.md',
      }],
      statusBusy: false,
      statusTexts: [],
      stopVisible: false,
    },
    {
      assistantSnapshots: [{
        hasCopyButton: true,
        signature: 'iframe-only-signature',
        text: '0\n1\n2\n3\n4\n5\ncitations\nResearch completed\nExact final report',
      }],
      statusBusy: false,
      statusTexts: ['Research completed'],
      stopVisible: false,
    },
    committedUserTurn,
  );
  const candidate = selectAssistantResponseCandidate(
    state,
    ['research workspace'],
    [],
    true,
    committedUserTurn.signature,
    committedUserTurn.turnId,
    committedUserTurn.turnIndex,
  ).snapshot;

  assert.equal(candidate?.text, 'Research completed\nExact final report');
  assert.equal(candidate?.assistantTurnId, pageAssistantAnchor.assistantTurnId);
  const capture = buildThreadCaptureIdentity({
    assistantSnapshot: candidate,
    attachmentButtons: state.attachmentButtons,
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/deep-thread',
    committedUserTurn,
    targetId: 'deep-target',
  });
  assert.equal(capture.assistantResponse?.assistantTurnId, pageAssistantAnchor.assistantTurnId);
  assert.equal(capture.expectedContentSource, 'deep-research-iframe');
  assert.equal(capture.artifacts.length, 1);
  const acceptedCapture = buildThreadCaptureIdentity({
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/deep-thread',
    committedUserTurn,
    expectedContentSource: 'deep-research-iframe',
    targetId: 'deep-target',
  });
  assert.equal(acceptedCapture.assistantResponse, null);
  assert.equal(acceptedCapture.expectedContentSource, 'deep-research-iframe');
  assert.match(
    driverSource,
    /const state = mergeResponseCaptureStates\(pageState, deepResearchState, committedUserTurn\);/u,
  );
  assert.match(
    driverSource,
    /isDeepResearchMode \? \{ expectedContentSource: 'deep-research-iframe' \} : \{\}/u,
  );
  assert.doesNotMatch(driverSource, /text: reportText\.slice\(0, 20000\)/u);
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
  assert.match(captureState.assistantSnapshots[0]?.assistantTurnId, /^assistant:index:0:signature:/u);
  assert.equal(captureState.assistantSnapshots[0]?.assistantTurnIndex, 0);
  assert.match(captureState.assistantSnapshots[0]?.precedingUserTurnId, /^user:index:0:signature:/u);
  assert.equal(captureState.userSnapshots.length, 1);
  assert.equal(
    captureState.userSnapshots[0]?.turnId,
    captureState.assistantSnapshots[0]?.precedingUserTurnId,
  );
});

test('thread identity collapses nested ChatGPT aliases without merging repeated sibling turns', () => {
  const text = 'review the attached candidate';
  const attribute = (values) => (name) => values[name] || null;
  const repeatedUserNode = {
    contains: () => false,
    getAttribute: attribute({ 'data-message-id': 'repeated-message' }),
    innerText: text,
    textContent: text,
  };
  const innerUserNode = {
    contains: () => false,
    getAttribute: attribute({ 'data-message-id': 'current-message' }),
    innerText: text,
    textContent: text,
  };
  const outerUserNode = {
    contains: (node) => node === innerUserNode,
    getAttribute: attribute({ 'data-turn-id': 'current-turn' }),
    innerText: text,
    textContent: text,
  };

  const groups = canonicalizeChatGptTurnNodes([
    repeatedUserNode,
    outerUserNode,
    innerUserNode,
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.node, repeatedUserNode);
  assert.equal(groups[1]?.node, innerUserNode);
  assert.deepEqual(groups[1]?.aliases, [outerUserNode, innerUserNode]);
});

test('submitted-turn attachment proof accepts filename-only controls, including deduped names', () => {
  const filename = 'journey-candidate(4).zip';
  const attachmentButton = {
    getAttribute: (name) => (name === 'aria-label' ? filename : null),
    href: '',
    innerText: '',
    textContent: '',
  };
  const innerAlias = { querySelectorAll: () => [] };
  const outerAlias = {
    querySelectorAll: (selector) => {
      assert.match(selector, /button\[aria-label\]/u);
      return [attachmentButton];
    },
  };

  const attachmentTexts = collectChatGptTurnAttachmentTexts(
    [outerAlias, innerAlias],
    'https://chatgpt.com/c/example-thread',
    CHATGPT_USER_TURN_ATTACHMENT_SELECTOR,
  );

  assert.deepEqual(attachmentTexts, [filename]);
  assert.equal(
    committedTurnAttachmentVerification(
      { attachmentTexts, turnId: 'data-message-id:user' },
      ['journey-candidate.zip'],
    ).confirmed,
    true,
  );
});

test('submitted-turn attachment proof accepts ChatGPT timestamp-renamed files', () => {
  const filename = 'codebase(20260815-191913).zip';
  const attachmentButton = {
    getAttribute: (name) => (name === 'aria-label' ? filename : null),
    href: '',
    innerText: '',
    textContent: '',
  };
  const aliases = [{ querySelectorAll: () => [attachmentButton] }];

  const attachmentTexts = collectChatGptTurnAttachmentTexts(
    aliases,
    'https://chatgpt.com/c/example-thread',
    CHATGPT_USER_TURN_ATTACHMENT_SELECTOR,
  );

  assert.equal(
    committedTurnAttachmentVerification(
      { attachmentTexts, turnId: 'data-message-id:user' },
      ['codebase.zip'],
    ).confirmed,
    true,
  );
});

test('thread capture uses one stable identity for nested ChatGPT user-turn aliases', () => {
  const text = 'review the attached candidate';
  const attribute = (values) => (name) => values[name] || null;
  const assistantNode = {
    contains: () => false,
    getAttribute: () => null,
    innerText: 'review complete',
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: 'review complete',
  };
  const innerUserNode = {
    compareDocumentPosition: (node) => (node === assistantNode ? 4 : 0),
    contains: () => false,
    getAttribute: attribute({ 'data-message-id': 'current-message' }),
    innerText: text,
    textContent: text,
  };
  const outerUserNode = {
    compareDocumentPosition: (node) => (node === assistantNode ? 4 : 0),
    contains: (node) => node === innerUserNode,
    getAttribute: attribute({ 'data-turn-id': 'current-turn' }),
    innerText: text,
    textContent: text,
  };
  const root = {
    innerText: `${text}\n\nreview complete`,
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="assistant"')) return [assistantNode];
      if (selector.includes('data-message-author-role="user"')) return [outerUserNode, innerUserNode];
      return [];
    },
  };

  const captureState = vm.runInNewContext(buildChatGptCaptureStateExpression(), {
    URL,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    document: {
      body: root,
      querySelector: (selector) => (selector === 'main' ? root : null),
      readyState: 'complete',
      title: 'Thread',
    },
    location: { href: 'https://chatgpt.com/c/example-thread' },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
  });

  assert.equal(captureState.userSnapshots.length, 1);
  assert.equal(captureState.userSnapshots[0]?.turnId, 'data-message-id:current-message');
  assert.equal(captureState.assistantSnapshots[0]?.precedingUserTurnId, 'data-message-id:current-message');
  assert.equal(captureState.assistantSnapshots[0]?.precedingUserTurnIndex, 0);
  const driverSource = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(driverSource, /const userTurnGroups = canonicalizeChatGptTurnNodes/u);
  assert.match(driverSource, /collectChatGptTurnAttachmentTexts\(/u);
});

test('thread capture uses one stable identity for nested ChatGPT assistant-turn aliases', () => {
  const responseText = 'Foul-play assessment: none.\nFROG_FIX_PACKET_COMPLETE';
  const attribute = (values) => (name) => values[name] || null;
  const copyButton = {
    classList: { contains: () => false },
    closest: () => outerAssistantNode,
    getAttribute: () => null,
    hasAttribute: () => false,
    href: '',
    innerText: 'Copy',
    tagName: 'BUTTON',
    textContent: 'Copy',
  };
  const innerAssistantNode = {
    childNodes: [],
    contains: () => false,
    getAttribute: attribute({
      'data-message-id': 'assistant-message',
      'data-message-model-slug': 'gpt-5-6-thinking',
    }),
    innerText: responseText,
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: responseText,
  };
  const outerAssistantNode = {
    childNodes: [],
    contains: (node) => node === innerAssistantNode || node === copyButton,
    getAttribute: attribute({ 'data-turn-id': 'assistant-turn' }),
    innerText: `ChatGPT said:\nWorked for 4m\n${responseText}`,
    querySelector: (selector) => (selector.includes('copy') || selector.includes('Copy') ? copyButton : null),
    querySelectorAll: (selector) => (selector === 'button' || selector === 'button, a' ? [copyButton] : []),
    textContent: `ChatGPT said:\nWorked for 4m\n${responseText}`,
  };
  const userNode = {
    compareDocumentPosition: (node) => (
      node === outerAssistantNode || node === innerAssistantNode || node === copyButton ? 4 : 0
    ),
    contains: () => false,
    getAttribute: attribute({ 'data-message-id': 'user-message' }),
    innerText: 'repair the attached snapshot',
    textContent: 'repair the attached snapshot',
  };
  const root = {
    innerText: `repair the attached snapshot\n\n${responseText}`,
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="assistant"')) {
        return [outerAssistantNode, innerAssistantNode];
      }
      if (selector.includes('data-message-author-role="user"')) return [userNode];
      if (selector === 'button, a') return [copyButton];
      return [];
    },
  };

  const captureState = vm.runInNewContext(buildChatGptCaptureStateExpression(), {
    URL,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    document: {
      body: root,
      querySelector: (selector) => (selector === 'main' ? root : null),
      readyState: 'complete',
      title: 'Thread',
    },
    location: { href: 'https://chatgpt.com/c/example-thread' },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
  });

  assert.equal(captureState.assistantSnapshots.length, 1);
  assert.equal(captureState.assistantSnapshots[0]?.assistantTurnId, 'data-message-id:assistant-message');
  assert.equal(captureState.assistantSnapshots[0]?.assistantTurnIndex, 0);
  assert.equal(captureState.assistantSnapshots[0]?.precedingUserTurnId, 'data-message-id:user-message');
  assert.equal(captureState.assistantSnapshots[0]?.text, responseText);
  assert.equal(captureState.assistantSnapshots[0]?.hasCopyButton, true);
  assert.equal(captureState.assistantSnapshots[0]?.modelSlug, 'gpt-5-6-thinking');
});

test('thread capture state separates ChatGPT assistant failure controls from assistant prose', () => {
  const thinkingFailureButton = {
    classList: {
      contains: () => false,
    },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ height: 20, width: 120 }),
    hasAttribute: () => false,
    href: '',
    innerText: 'Thinking failed',
    tagName: 'BUTTON',
    textContent: 'Thinking failed',
  };
  const stoppedFailureButton = {
    ...thinkingFailureButton,
    innerText: 'Stopped thinking',
    textContent: 'Stopped thinking',
  };
  const assistantText = [
    'I’ll build from the uploaded snapshot only.',
    '',
    'Thinking failed',
  ].join('\n');
  const assistantNode = {
    contains: (node) => node === thinkingFailureButton || node === stoppedFailureButton,
    getAttribute: (name) => (name === 'data-message-model-slug' ? 'gpt-5-5-pro' : null),
    innerText: assistantText,
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'button' ? [thinkingFailureButton, stoppedFailureButton] : []),
    textContent: assistantText,
  };
  thinkingFailureButton.closest = () => assistantNode;
  stoppedFailureButton.closest = () => assistantNode;
  const userNode = {
    compareDocumentPosition(node) {
      return node === assistantNode || node === thinkingFailureButton || node === stoppedFailureButton ? 4 : 0;
    },
  };
  const root = {
    innerText: `user prompt\n\n${assistantText}`,
    querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="assistant"')) {
        return [assistantNode];
      }
      if (selector.includes('data-message-author-role="user"')) {
        return [userNode];
      }
      if (selector === 'button, a') {
        return [thinkingFailureButton, stoppedFailureButton];
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

  assert.deepEqual(Array.from(captureState.assistantFailureTexts), ['Thinking failed', 'Stopped thinking']);
  assert.equal(captureState.assistantSnapshots[0]?.modelSlug, 'gpt-5-5-pro');
  assert.equal(captureState.attachmentButtons.length, 0);
});

test('response guards detect ChatGPT rate limits and assistant failure controls', () => {
  assert.equal(chatGptTextIndicatesRateLimit('Too many requests, please try again later.'), true);
  assert.equal(chatGptTextIndicatesRateLimit('Review complete with no findings.'), false);
  assert.equal(
    responseStateIndicatesChatGptRateLimit({
      assistantFailureTexts: [],
      assistantSnapshots: [],
      bodyText: 'Usage limit reached. Try again after 10:30 PM.',
      statusTexts: [],
    }),
    true,
  );
  assert.equal(responseStateAssistantFailureText({ assistantFailureTexts: ['', 'Stopped thinking'] }), 'Stopped thinking');
});

test('model confirmation contract is appended to waited concrete-model prompts and enforced', () => {
  const prompt = appendModelConfirmationPrompt('Review the PR.', {
    isDeepResearchMode: false,
    responseMarker: 'REVIEW_COMPLETE',
    shouldSend: true,
    shouldWaitForResponse: true,
    targetModel: 'gpt-5.5-pro',
    turnNonce: 'test-turn-nonce',
  });

  assert.match(prompt, /^REVIEW_GPT_TURN_NONCE: test-turn-nonce\n/u);
  assert.match(prompt, /MODEL_CONFIRMATION: gpt-5\.5-pro/u);
  assert.match(prompt, /MODEL_CONFIRMATION: UNKNOWN/u);
  assert.match(prompt, /Include REVIEW_COMPLETE only after the requested work is complete\./u);
  assert.match(prompt, /Do not stop or shorten the requested work/u);
  assert.doesNotMatch(prompt, /\band stop\b/u);
  assert.doesNotMatch(prompt, /reply exactly/u);
  assert.match(prompt, /Review the PR\./u);
  assert.equal(
    appendModelConfirmationPrompt(prompt, {
      isDeepResearchMode: false,
      responseMarker: 'REVIEW_COMPLETE',
      shouldSend: true,
      shouldWaitForResponse: true,
      targetModel: 'gpt-5.5-pro',
      turnNonce: 'test-turn-nonce',
    }),
    prompt,
  );
  assert.match(
    appendModelConfirmationPrompt('Audit MODEL_CONFIRMATION: UNKNOWN behavior.', {
      isDeepResearchMode: false,
      shouldSend: true,
      shouldWaitForResponse: true,
      targetModel: 'gpt-5.5-pro',
      turnNonce: 'collision-proof-nonce',
    }),
    /^REVIEW_GPT_TURN_NONCE: collision-proof-nonce\n/u,
  );
  assert.equal(
    appendModelConfirmationPrompt('Review the PR.', {
      isDeepResearchMode: false,
      shouldSend: true,
      shouldWaitForResponse: false,
      targetModel: 'gpt-5.5-pro',
    }),
    'Review the PR.',
  );
  assert.equal(
    modelConfirmationRequired({
      isDeepResearchMode: false,
      shouldSend: true,
      shouldWaitForResponse: true,
      targetModel: 'gpt-5.5-pro',
    }),
    true,
  );
  assert.equal(extractModelConfirmationValue('MODEL_CONFIRMATION: GPT-5.5-PRO\nREVIEW_COMPLETE'), 'GPT-5.5-PRO');
  assert.equal(modelConfirmationFailure('gpt-5.5-pro', 'MODEL_CONFIRMATION: GPT-5.5-PRO\nREVIEW_COMPLETE'), '');
  assert.match(
    modelConfirmationFailure('gpt-5.5-pro', 'MODEL_CONFIRMATION: GPT-5.5-mini\nREVIEW_COMPLETE'),
    /expected gpt-5\.5-pro/u,
  );
  assert.match(modelConfirmationFailure('gpt-5.5-pro', 'REVIEW_COMPLETE'), /did not include MODEL_CONFIRMATION/u);
  assert.equal(
    modelConfirmationFailure('gpt-5.6-sol', 'MODEL_CONFIRMATION: GPT-5.6 Sol\nREVIEW_COMPLETE'),
    '',
  );
  assert.match(
    modelConfirmationFailure('gpt-5.6-sol', 'MODEL_CONFIRMATION: UNKNOWN\nREVIEW_COMPLETE'),
    /confirmed model UNKNOWN, expected gpt-5\.6-sol/u,
  );
  assert.equal(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: UNKNOWN\nREVIEW_COMPLETE',
      'gpt-5-6-pro',
    ),
    '',
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: UNKNOWN\nREVIEW_COMPLETE',
      '',
      5 * 60 * 1000 - 1,
    ),
    /confirmed model UNKNOWN, expected gpt-5\.6-sol/u,
  );
  assert.equal(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: UNKNOWN\nREVIEW_COMPLETE',
      'gpt-5-6-pro',
      5 * 60 * 1000,
    ),
    '',
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: UNKNOWN\nREVIEW_COMPLETE',
      'gpt-5-5-pro',
      40 * 60 * 1000,
    ),
    /DOM reported model gpt-5-5-pro, expected gpt-5\.6-sol/u,
  );
  assert.match(
    modelConfirmationFailure('gpt-5.6-sol', 'REVIEW_COMPLETE', 'gpt-5-6-pro', 40 * 60 * 1000),
    /did not include MODEL_CONFIRMATION/u,
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: UNKNOWN\nMODEL_CONFIRMATION: gpt-5.6-sol',
      'gpt-5-6-pro',
    ),
    /multiple MODEL_CONFIRMATION lines/u,
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      '```text\nMODEL_CONFIRMATION: gpt-5.6-sol\n```',
      'gpt-5-6-pro',
    ),
    /did not include MODEL_CONFIRMATION/u,
  );
  assert.equal(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: GPT-5.6 Sol\nREVIEW_COMPLETE',
      'gpt-5-6-pro',
    ),
    '',
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: gpt-5.6-sol\nREVIEW_COMPLETE',
      'gpt-5-5-pro',
    ),
    /DOM reported model gpt-5-5-pro, expected gpt-5\.6-sol/u,
  );
  assert.equal(modelConfirmationFailure('pro', 'MODEL_CONFIRMATION: pro', 'gpt-5-6-pro'), '');
  assert.match(
    modelConfirmationFailure('pro', 'MODEL_CONFIRMATION: pro', 'gpt-5-5-pro'),
    /DOM reported model gpt-5-5-pro, expected pro/u,
  );
  assert.match(
    modelConfirmationFailure('pro', 'MODEL_CONFIRMATION: pro', 'gpt-5-6-instant'),
    /DOM reported model gpt-5-6-instant, expected pro/u,
  );
});

test('GPT-5.6 Sol accepts its current response slug alias and rejects different models', () => {
  assert.equal(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: GPT-5.6 Sol\nREVIEW_COMPLETE',
      'gpt-5-6-thinking',
    ),
    '',
  );
  assert.equal(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: UNKNOWN\nREVIEW_COMPLETE',
      'gpt-5-6-thinking',
    ),
    '',
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: GPT-5.6 Sol\nREVIEW_COMPLETE',
      'gpt-5-5-thinking',
    ),
    /DOM reported model gpt-5-5-thinking, expected gpt-5\.6-sol/u,
  );
  assert.match(
    modelConfirmationFailure(
      'gpt-5.6-sol',
      'MODEL_CONFIRMATION: GPT-5.6 Sol\nREVIEW_COMPLETE',
      'gpt-5-6-instant',
    ),
    /DOM reported model gpt-5-6-instant, expected gpt-5\.6-sol/u,
  );
  assert.equal(
    modelConfirmationFailure(
      'gpt-5.6-thinking',
      'MODEL_CONFIRMATION: GPT-5.6 Thinking\nREVIEW_COMPLETE',
      'gpt-5-6-thinking',
    ),
    '',
  );
});

test('model confirmation extraction accepts only visible standalone rendered lines', () => {
  const textNode = (value) => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, childNodes = [], options = {}) => ({
    childNodes,
    display: options.display || '',
    hidden: Boolean(options.hidden),
    nodeType: 1,
    tagName,
    getAttribute(name) {
      return name === 'aria-hidden' && options.ariaHidden ? 'true' : null;
    },
  });
  const styleFor = (node) => ({
    display: node.display || 'inline',
    visibility: 'visible',
  });

  const validConfirmation = element('DIV', [
    element('P', [textNode('Report ready')], { display: 'block' }),
    element('P', [
      element('STRONG', [textNode('MODEL_CONFIRMATION:')]),
      element('EM', [textNode(' UNKNOWN')]),
    ], { display: 'block' }),
  ], { display: 'block' });
  assert.equal(
    extractModelConfirmationText(validConfirmation, styleFor),
    'Report ready\nMODEL_CONFIRMATION: UNKNOWN',
  );

  const excludedContainers = element('DIV', [
    element('BLOCKQUOTE', [textNode('MODEL_CONFIRMATION: gpt-5.6-sol')], { display: 'block' }),
    element('PRE', [textNode('MODEL_CONFIRMATION: gpt-5.6-sol')], { display: 'block' }),
    element('CODE', [textNode('MODEL_CONFIRMATION: gpt-5.6-sol')]),
  ], { display: 'block' });
  assert.equal(extractModelConfirmationText(excludedContainers, styleFor), '');

  for (const decoy of [
    element('SPAN', [
      textNode('prefix'),
      element('CODE', [textNode('ignored')]),
      textNode('MODEL_CONFIRMATION: UNKNOWN'),
    ]),
    element('SPAN', [
      textNode('prefix'),
      element('DIV', [textNode('ignored')], { display: 'block', hidden: true }),
      textNode('MODEL_CONFIRMATION: UNKNOWN'),
    ]),
  ]) {
    assert.match(
      modelConfirmationFailure(
        'gpt-5.6-sol',
        extractModelConfirmationText(decoy, styleFor),
        'gpt-5-6-pro',
      ),
      /did not include MODEL_CONFIRMATION/u,
    );
  }
});

test('model attestation binds evidence to the committed user turn and exact response bytes', () => {
  const committedUserTurnSignature = 'review the exact pull request';
  const responseText = 'Report\r\nDone\u00a0';
  const responseBytes = 'Report\nDone\n';
  const validSnapshot = {
    afterLastUserMessage: false,
    modelConfirmationText: 'MODEL_CONFIRMATION: UNKNOWN',
    modelSlug: 'gpt-5-6-pro',
    precedingUserMessageSignature: committedUserTurnSignature,
    precedingUserTurnId: 'data-message-id:committed-user',
    precedingUserTurnIndex: 4,
    signature: 'fresh-response',
    text: responseText,
  };
  const concurrentSnapshot = {
    ...validSnapshot,
    afterLastUserMessage: true,
    precedingUserMessageSignature: 'another concurrent prompt',
    precedingUserTurnId: 'data-message-id:concurrent-user',
    precedingUserTurnIndex: 5,
    signature: 'concurrent-response',
  };
  const repeatedPromptSnapshot = {
    ...validSnapshot,
    precedingUserTurnId: 'data-message-id:older-user',
    precedingUserTurnIndex: 2,
    signature: 'older-repeated-prompt-response',
  };

  assert.equal(
    selectAssistantResponseCandidate(
      { assistantSnapshots: [validSnapshot, concurrentSnapshot, repeatedPromptSnapshot] },
      [],
      [],
      true,
      committedUserTurnSignature,
      'data-message-id:committed-user',
      4,
    ).snapshot?.signature,
    'fresh-response',
  );
  assert.equal(
    selectAssistantResponseCandidate(
      { assistantSnapshots: [concurrentSnapshot] },
      [],
      [],
      true,
      committedUserTurnSignature,
      'data-message-id:committed-user',
      4,
    ).snapshot,
    null,
  );
  assert.equal(
    selectAssistantResponseCandidate(
      { assistantSnapshots: [repeatedPromptSnapshot] },
      [],
      [],
      true,
      committedUserTurnSignature,
      'data-message-id:committed-user',
      4,
    ).snapshot,
    null,
  );

  assert.deepEqual(
    modelAttestationForSnapshot(
      'gpt-5.6-sol',
      validSnapshot,
      true,
      committedUserTurnSignature,
    ),
    {
      evidence: {
        schemaVersion: 1,
        requestedModel: 'gpt-5.6-sol',
        responseModelSlug: 'gpt-5-6-pro',
        responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
      },
      failure: '',
    },
  );
  assert.match(
    modelAttestationForSnapshot(
      'gpt-5.6-sol',
      concurrentSnapshot,
      true,
      committedUserTurnSignature,
    ).failure,
    /not bound to the committed user turn/u,
  );
  assert.match(
    modelAttestationForSnapshot(
      'gpt-5.6-sol',
      { ...validSnapshot, modelSlug: '' },
      true,
      committedUserTurnSignature,
      5 * 60 * 1000 - 1,
    ).failure,
    /confirmed model UNKNOWN/u,
  );
  assert.deepEqual(
    modelAttestationForSnapshot(
      'gpt-5.6-sol',
      { ...validSnapshot, modelSlug: '' },
      true,
      committedUserTurnSignature,
      5 * 60 * 1000,
    ),
    { evidence: null, failure: '' },
  );
});

test('completed response evidence is atomic, private, and independently invalidated', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-attestation-'));
  const responseFile = join(root, 'response.md');
  const evidenceFile = `${responseFile}.model-verification.json`;
  const responseText = 'Report\r\nDone\u00a0';
  const responseBytes = 'Report\nDone\n';
  const evidence = {
    schemaVersion: 1,
    requestedModel: 'gpt-5.6-sol',
    responseModelSlug: 'gpt-5-6-pro',
    responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(
    writeCompletedResponseArtifacts(responseFile, responseText, evidence),
    {
      captureMetadataPath: '',
      evidencePath: evidenceFile,
      evidenceWarning: '',
      responseFilePath: responseFile,
    },
  );
  assert.equal(readFileSync(responseFile, 'utf8'), responseBytes);
  assert.deepEqual(JSON.parse(readFileSync(evidenceFile, 'utf8')), evidence);
  assert.equal(statSync(responseFile).mode & 0o777, 0o600);
  assert.equal(statSync(evidenceFile).mode & 0o777, 0o600);

  const capturedResponseFile = join(root, 'captured-response.md');
  const captureMetadataFile = `${capturedResponseFile}.capture.json`;
  const captureIdentity = {
    artifacts: [],
    assistantResponse: {
      assistantTurnId: 'data-message-id:assistant',
      assistantTurnIndex: 1,
      precedingUserMessageSignature: 'review',
      precedingUserTurnId: 'data-message-id:user',
      precedingUserTurnIndex: 0,
      responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
      signature: 'report done',
    },
    browserEndpoint: 'http://127.0.0.1:9333',
    chatUrl: 'https://chatgpt.com/c/thread',
    committedUserTurn: {
      signature: 'review',
      turnId: 'data-message-id:user',
      turnIndex: 0,
    },
    schemaVersion: 1,
    targetId: 'target',
  };
  assert.deepEqual(
    writeCompletedResponseArtifacts(
      capturedResponseFile,
      responseText,
      null,
      captureIdentity,
      captureMetadataFile,
    ),
    {
      captureMetadataPath: captureMetadataFile,
      evidencePath: '',
      evidenceWarning: '',
      responseFilePath: capturedResponseFile,
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(captureMetadataFile, 'utf8')), captureIdentity);
  assert.equal(statSync(captureMetadataFile).mode & 0o777, 0o600);

  assert.equal(removeModelVerificationEvidenceFile(responseFile), evidenceFile);
  assert.equal(existsSync(evidenceFile), false);
  assert.equal(readFileSync(responseFile, 'utf8'), responseBytes);

  assert.throws(
    () => writeCompletedResponseArtifacts(responseFile, responseText, {
      ...evidence,
      responseSha256: '0'.repeat(64),
    }),
    /digest did not match/u,
  );

  const responseWithUnavailableEvidence = join(root, 'response-with-warning.md');
  const unavailableEvidencePath = `${responseWithUnavailableEvidence}.model-verification.json`;
  mkdirSync(unavailableEvidencePath);
  const warningResult = writeCompletedResponseArtifacts(
    responseWithUnavailableEvidence,
    responseText,
    evidence,
  );
  assert.equal(warningResult.responseFilePath, responseWithUnavailableEvidence);
  assert.equal(warningResult.evidencePath, '');
  assert.match(warningResult.evidenceWarning, /Optional model verification was not persisted/u);
  assert.equal(readFileSync(responseWithUnavailableEvidence, 'utf8'), responseBytes);
  assert.deepEqual(readdirSync(root).filter((entry) => entry.endsWith('.tmp')), []);
});

test('model picker accepts compact pro labels for gpt-5.5-pro targets', () => {
  assert.equal(modelPickerTextHasWord('Pro Research-grade intelligence', 'pro'), true);
  assert.equal(
    modelPickerLabelMatchesTarget('Pro Research-grade intelligence', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    true
  );
  assert.equal(
    modelPickerLabelMatchesTarget('GPT 5.2 Pro', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    false
  );
  assert.equal(
    modelPickerLabelMatchesTarget('Extended Pro', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    false
  );
  assert.equal(
    modelPickerLabelMatchesTarget('Pro Extended', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    false
  );
});

test('gpt-5.6-sol requires checked model proof and does not trust a bare Pro composer control', async () => {
  const fixture = JSON.parse(
    readFileSync(join(repoRoot, 'test', 'fixtures', 'chatgpt-current-pro-picker.json'), 'utf8')
  );
  const solAliasTarget = {
    desiredVersion: '5-6',
    wantsPro: false,
    wantsSol: true,
    wantsInstant: false,
    wantsThinking: false,
  };
  const proTarget = {
    desiredVersion: '',
    wantsPro: true,
    wantsSol: false,
    wantsInstant: false,
    wantsThinking: false,
  };
  const [proRow] = fixture.modelPickerRows;

  assert.equal(fixture.composerPill.text, 'Pro');
  assert.equal(fixture.composerPill.visible, true);
  assert.deepEqual(fixture.thinkingEffortRows, []);
  assert.deepEqual(fixture.thinkingEffortActions, []);
  assert.equal(modelPickerLabelMatchesTarget(fixture.composerPill.text, solAliasTarget), true);
  assert.equal(modelPickerLabelMatchesTarget(fixture.composerPill.text, proTarget), true);
  assert.equal(modelPickerControlSelectionProof(fixture.composerPill, solAliasTarget), false);
  assert.equal(modelPickerControlSelectionProof(fixture.composerPill, proTarget), false);
  assert.equal(modelPickerControlSelectionProof(fixture.disabledComposerPill, solAliasTarget), false);
  assert.equal(modelPickerOptionMatchesTarget(proRow.text, proRow.dataTestId, solAliasTarget), true);
  assert.equal(modelPickerOptionMatchesTarget(proRow.text, proRow.dataTestId, proTarget), true);
  assert.equal(modelPickerOptionIsFinalTarget(proRow.text, proRow.dataTestId, solAliasTarget, false), true);
  assert.equal(modelPickerSelectionStateMatches(proRow.selection), true);
  for (const target of [solAliasTarget, proTarget]) {
    assert.equal(
      modelPickerOptionSelectionProof(
        {
          label: proRow.text,
          opensSubmenu: false,
          selected: modelPickerSelectionStateMatches(proRow.selection),
          testId: proRow.dataTestId,
          unavailable: false,
          visible: proRow.visible,
        },
        target
      ),
      true
    );
  }

  let thinkingExpressionBuilds = 0;
  let thinkingEvaluations = 0;
  const thinkingSelection = await ensureDraftThinkingSelected(
    'current',
    async () => {
      thinkingEvaluations += 1;
      return { status: 'selection-error' };
    },
    () => {
      thinkingExpressionBuilds += 1;
      return 'thinking-menu-expression';
    }
  );
  assert.deepEqual(thinkingSelection, { ok: true, label: 'current', skipped: true });
  assert.equal(thinkingExpressionBuilds, 0);
  assert.equal(thinkingEvaluations, 0);

  for (const staleLabel of ['Extended Pro', 'Pro Extended']) {
    assert.equal(modelPickerLabelMatchesTarget(staleLabel, solAliasTarget), false);
    assert.equal(modelPickerOptionMatchesTarget(staleLabel, 'model-switcher-extended-pro', solAliasTarget), false);
  }
  assert.equal(modelPickerLabelMatchesTarget('GPT-5.6 Sol', solAliasTarget), true);
  assert.equal(modelPickerOptionMatchesTarget('GPT-5.6 Sol', '', solAliasTarget), true);
  assert.equal(modelPickerOptionIsFinalTarget('GPT-5.6 Sol', '', solAliasTarget, false), true);
  assert.equal(modelPickerOptionMatchesTarget('GPT-5.5 Pro', 'model-switcher-gpt-5-5-pro', solAliasTarget), false);
  assert.equal(modelPickerLabelMatchesTarget('GPT-5.6 Pro', proTarget), true);
  assert.equal(modelPickerLabelMatchesTarget('GPT-5.5 Pro', proTarget), false);
  assert.equal(modelPickerOptionMatchesTarget('GPT-5.6 Pro', 'model-switcher-gpt-5-6-pro', proTarget), true);
  assert.equal(modelPickerOptionMatchesTarget('GPT-5.5 Pro', 'model-switcher-gpt-5-5-pro', proTarget), false);
  for (const staleRow of fixture.staleModelPickerRows) {
    for (const target of [solAliasTarget, proTarget]) {
      const opensSubmenu = staleRow.ariaHaspopup === 'menu';
      assert.equal(
        modelPickerOptionIsFinalTarget(staleRow.text, staleRow.dataTestId, target, opensSubmenu),
        false
      );
      assert.equal(
        modelPickerOptionSelectionProof(
          {
            label: staleRow.text,
            opensSubmenu,
            selected: modelPickerSelectionStateMatches(staleRow.selection),
            testId: staleRow.dataTestId,
            unavailable: false,
            visible: staleRow.visible,
          },
          target
        ),
        false
      );
    }
  }

  for (const override of [
    { opensSubmenu: true },
    { selected: false },
    { unavailable: true },
    { visible: false },
  ]) {
    assert.equal(
      modelPickerOptionSelectionProof(
        {
          label: proRow.text,
          opensSubmenu: false,
          selected: modelPickerSelectionStateMatches(proRow.selection),
          testId: proRow.dataTestId,
          unavailable: false,
          visible: proRow.visible,
          ...override,
        },
        solAliasTarget
      ),
      false
    );
  }
});

test('advanced picker proves and traverses the explicit GPT-5.6 Sol model without touching effort', () => {
  const fixture = JSON.parse(
    readFileSync(join(repoRoot, 'test', 'fixtures', 'chatgpt-advanced-sol-picker.json'), 'utf8')
  );
  const solAliasTarget = {
    desiredVersion: '5-6',
    wantsPro: false,
    wantsSol: true,
    wantsInstant: false,
    wantsThinking: false,
  };
  const proTarget = {
    desiredVersion: '',
    wantsPro: true,
    wantsSol: false,
    wantsInstant: false,
    wantsThinking: false,
  };
  const instantTarget = {
    desiredVersion: '5-5',
    wantsPro: false,
    wantsSol: false,
    wantsInstant: true,
    wantsThinking: false,
  };
  const thinkingTarget = {
    desiredVersion: '5-5',
    wantsPro: false,
    wantsSol: false,
    wantsInstant: false,
    wantsThinking: true,
  };
  const [advancedRow, modelSummaryRow, effortSummaryRow] = fixture.modelPickerRows;
  const [selectedSolRow, wrongVersionRow] = fixture.modelSubmenuRows;

  assert.equal(fixture.composerPill.text, 'High');
  assert.equal(modelPickerLabelMatchesTarget(fixture.composerPill.text, solAliasTarget), false);
  assert.equal(modelPickerLabelMatchesTarget(advancedRow.text, solAliasTarget), false);

  for (const target of [solAliasTarget, proTarget, instantTarget, thinkingTarget]) {
    assert.equal(
      modelPickerOptionCanTraverseTarget(
        advancedRow.text,
        advancedRow.dataTestId ?? '',
        target,
        advancedRow.ariaHaspopup === 'menu'
      ),
      true
    );
  }

  for (const target of [instantTarget, thinkingTarget]) {
    assert.equal(modelPickerOptionMatchesTarget(modelSummaryRow.text, '', target), false);
    assert.equal(modelPickerOptionCanTraverseTarget(modelSummaryRow.text, '', target, true), true);
    assert.equal(
      modelPickerSummarySelectionProof(
        {
          label: modelSummaryRow.text,
          opensSubmenu: true,
          unavailable: false,
          visible: modelSummaryRow.visible,
        },
        target
      ),
      false
    );
  }

  for (const target of [solAliasTarget, proTarget]) {
    assert.equal(modelPickerOptionMatchesTarget(modelSummaryRow.text, '', target), true);
    assert.equal(modelPickerOptionCanTraverseTarget(modelSummaryRow.text, '', target, true), true);
    assert.equal(
      modelPickerSummarySelectionProof(
        {
          label: modelSummaryRow.text,
          opensSubmenu: true,
          unavailable: false,
          visible: modelSummaryRow.visible,
        },
        target
      ),
      true
    );
    assert.equal(
      modelPickerOptionSelectionProof(
        {
          label: modelSummaryRow.text,
          opensSubmenu: true,
          selected: false,
          testId: '',
          unavailable: false,
          visible: modelSummaryRow.visible,
        },
        target
      ),
      true
    );
    assert.equal(modelPickerOptionMatchesTarget(selectedSolRow.text, '', target), true);
    assert.equal(modelPickerOptionIsFinalTarget(selectedSolRow.text, '', target, false), true);
    assert.equal(
      modelPickerOptionSelectionProof(
        {
          label: selectedSolRow.text,
          opensSubmenu: false,
          selected: modelPickerSelectionStateMatches({
            ariaChecked: selectedSolRow.ariaChecked,
            dataState: selectedSolRow.dataState,
          }),
          testId: '',
          unavailable: false,
          visible: selectedSolRow.visible,
        },
        target
      ),
      true
    );
  }

  assert.equal(modelPickerOptionMatchesTarget(effortSummaryRow.text, '', solAliasTarget), false);
  assert.equal(modelPickerOptionCanTraverseTarget(effortSummaryRow.text, '', solAliasTarget, true), false);
  assert.equal(
    modelPickerSummarySelectionProof(
      {
        label: effortSummaryRow.text,
        opensSubmenu: true,
        unavailable: false,
        visible: effortSummaryRow.visible,
      },
      solAliasTarget
    ),
    false
  );
  assert.equal(modelPickerOptionMatchesTarget(wrongVersionRow.text, '', solAliasTarget), false);
  assert.equal(modelPickerOptionMatchesTarget('GPT-5.5 Sol', '', solAliasTarget), false);
  assert.equal(modelPickerOptionMatchesTarget('GPT-15.6 Sol', '', solAliasTarget), false);
  assert.equal(modelPickerOptionMatchesTarget('GPT-5.60 Sol', '', solAliasTarget), false);
  assert.equal(modelPickerLabelMatchesTarget('GPT-15.6 Sol', solAliasTarget), false);
  assert.equal(modelPickerLabelMatchesTarget('GPT-5.60 Sol', solAliasTarget), false);
  assert.equal(
    modelPickerSummarySelectionProof(
      {
        label: 'ModelGPT-5.5GPT-5.6 Sol',
        opensSubmenu: true,
        unavailable: false,
        visible: true,
      },
      solAliasTarget
    ),
    false
  );
  assert.equal(
    modelPickerSummarySelectionProof(
      {
        label: 'Model',
        opensSubmenu: true,
        testId: 'model-switcher-pro-submenu',
        unavailable: false,
        visible: true,
      },
      solAliasTarget
    ),
    false
  );
  assert.equal(
    modelPickerLabelMatchesTarget('GPT-5.6 Sol Extended Pro', solAliasTarget),
    false
  );
  assert.equal(
    modelPickerOptionMatchesTarget('GPT-5.6 Sol Extended Pro', '', solAliasTarget),
    false
  );
  assert.equal(modelPickerOptionCanTraverseTarget('GPT-5.6 Sol', '', solAliasTarget, true), true);
  assert.equal(modelPickerOptionCanTraverseTarget('Pro', 'model-switcher-pro-submenu', solAliasTarget, true), false);
  assert.equal(modelPickerOptionCanTraverseTarget('ModelGPT-5.5', '', solAliasTarget, true), true);

  for (const override of [
    { visible: false },
    { unavailable: true },
    { opensSubmenu: false },
  ]) {
    assert.equal(
      modelPickerSummarySelectionProof(
        {
          label: modelSummaryRow.text,
          opensSubmenu: true,
          unavailable: false,
          visible: true,
          ...override,
        },
        solAliasTarget
      ),
      false
    );
  }
});

test('Mountain compact picker routes model proof through Advanced and never through slider or Effort', () => {
  const fixture = JSON.parse(
    readFileSync(join(repoRoot, 'test', 'fixtures', 'chatgpt-mountain-compact-picker.json'), 'utf8')
  );
  const solAliasTarget = {
    desiredVersion: '5-6',
    wantsPro: false,
    wantsSol: true,
    wantsInstant: false,
    wantsThinking: false,
  };
  const [slider, advancedRow] = fixture.compactPickerRows;
  const [modelSummaryRow, effortSummaryRow] = fixture.advancedPickerRows;

  assert.equal(fixture.composerPill.text, 'Pro');
  assert.equal(modelPickerControlSelectionProof(fixture.composerPill, solAliasTarget), false);
  assert.equal(slider.role, 'slider');
  assert.equal(slider.ariaValueNow, slider.ariaValueMax);
  assert.equal(slider.ariaValueText, '');
  assert.equal(
    modelPickerControlSelectionProof(
      {
        label: slider.ariaValueNow,
        role: slider.role,
        visible: slider.visible,
      },
      solAliasTarget
    ),
    false
  );
  assert.equal(
    modelPickerOptionSelectionProof(
      {
        label: fixture.composerPill.text,
        opensSubmenu: false,
        role: slider.role,
        selected: true,
        testId: '',
        unavailable: false,
        visible: slider.visible,
      },
      solAliasTarget
    ),
    false
  );
  assert.equal(advancedRow.text, 'Advanced');
  assert.equal(advancedRow.role, 'menuitem');
  assert.equal(advancedRow.ariaHaspopup, '');
  assert.equal(
    modelPickerOptionCanTraverseTarget(
      advancedRow.text,
      '',
      solAliasTarget,
      advancedRow.ariaHaspopup === 'menu'
    ),
    true
  );
  assert.equal(modelPickerOptionMatchesTarget(effortSummaryRow.text, '', solAliasTarget), false);
  assert.equal(modelPickerOptionCanTraverseTarget(effortSummaryRow.text, '', solAliasTarget, true), false);
  assert.equal(
    modelPickerSummarySelectionProof(
      {
        label: effortSummaryRow.text,
        opensSubmenu: true,
        unavailable: false,
        visible: effortSummaryRow.visible,
      },
      solAliasTarget
    ),
    false
  );
  assert.equal(
    modelPickerSummarySelectionProof(
      {
        label: modelSummaryRow.text,
        opensSubmenu: true,
        unavailable: false,
        visible: modelSummaryRow.visible,
      },
      solAliasTarget
    ),
    true
  );
});

test('model picker flow ignores hidden inert Advanced panels until they become interactive', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');

  assert.match(source, /for \(let current = node; current instanceof HTMLElement; current = current\.parentElement\)/u);
  assert.match(source, /current\.hasAttribute\('inert'\)/u);
  assert.match(source, /current === node && style\.pointerEvents === 'none'/u);
  assert.match(source, /modelPickerControlLabelCanProveTarget\(modelButtonLabel\(currentButton\), targetDescriptor\)/u);
  assert.match(source, /modelPickerOptionElementCanParticipate\(\{/u);
  assert.match(source, /if \(!dispatched && typeof target\.click === 'function'\)/u);
});

test('app connector matching accepts current ChatGPT GitHub labels', () => {
  assert.equal(normalizeAppConnectorText('GitHub'), 'git hub');
  assert.equal(appConnectorLabelMatchesTarget('GitHub', 'github'), true);
  assert.equal(appConnectorLabelMatchesTarget('GitHub', 'GitHub'), true);
  assert.equal(appConnectorLabelMatchesTarget('OpenAI Platform', 'github'), false);
  assert.equal(appConnectorMentionText('github'), '@github');
  assert.equal(appConnectorMentionText('GitHub'), '@github');
  assert.equal(appConnectorMentionText('gh'), '@github');
});

test('model picker accepts the current Latest menu labels', () => {
  assert.equal(modelPickerTextHasWord('In tant', 'instant'), true);
  assert.equal(modelPickerTextHasWord('Late t', 'latest'), true);
  assert.equal(
    modelPickerOptionMatchesTarget('In tant', 'model-switcher-gpt-5-3', {
      desiredVersion: '5-5',
      wantsPro: false,
      wantsInstant: true,
      wantsThinking: false,
    }),
    true
  );
  assert.equal(
    modelPickerOptionMatchesTarget('Thinking\u2022 Standard', 'model-switcher-gpt-5-5-thinking', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    false
  );
  assert.equal(
    modelPickerOptionMatchesTarget('Pro\u2022 Extended', 'model-switcher-gpt-5-5-pro', {
      desiredVersion: '5-5',
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

test('model picker option scoring rejects Pro rows for non-Pro aliases', () => {
  const nonPro55 = {
    desiredVersion: '5-5',
    wantsPro: false,
    wantsInstant: false,
    wantsThinking: false,
  };
  assert.equal(
    modelPickerOptionMatchesTarget('ProResearch-grade intelligence', 'model-switcher-gpt-5-5-pro', nonPro55),
    false
  );
  assert.equal(
    modelPickerOptionMatchesTarget('Extended Pro', 'model-switcher-extended-pro', nonPro55),
    false
  );
  assert.equal(
    modelPickerOptionMatchesTarget('Extended Pro', 'model-switcher-extended-pro', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    false
  );
  assert.equal(
    modelPickerOptionMatchesTarget('ProResearch-grade intelligence', 'model-switcher-gpt-5-5-pro', {
      desiredVersion: '5-5',
      wantsPro: true,
      wantsInstant: false,
      wantsThinking: false,
    }),
    true
  );
  assert.equal(
    modelPickerOptionMatchesTarget('InstantFor everyday chats', 'model-switcher-gpt-5-5', {
      desiredVersion: '5-5',
      wantsPro: false,
      wantsInstant: false,
      wantsThinking: false,
    }),
    true
  );
  assert.equal(
    modelPickerOptionMatchesTarget('InstantFor everyday chats', 'model-switcher-gpt-5-5', {
      desiredVersion: '',
      wantsPro: false,
      wantsInstant: true,
      wantsThinking: false,
    }),
    true
  );
});

test('model picker requires explicit selected semantics instead of a decorative sprite', () => {
  assert.equal(
    modelPickerSelectionStateMatches({
      hasCheckIcon: false,
      hasTrailingSpriteIcon: true,
      trailingText: '',
    }),
    false
  );
  assert.equal(
    modelPickerSelectionStateMatches({
      hasCheckIcon: true,
    }),
    true
  );
});

test('model picker reports rate-limited Pro rows as unavailable', () => {
  assert.equal(
    modelPickerUnavailableReason('Limit reached. Try again after 2:37 PM.'),
    'Limit reached. Try again after 2:37 PM.'
  );
  assert.equal(
    formatModelSelectionFailureMessage('gpt-5.5-pro', {
      ok: false,
      reason: 'model-unavailable',
      details: {
        reason: 'Limit reached. Try again after 2:37 PM.',
        source: 'page-message',
      },
    }),
    'Requested ChatGPT model is not available (gpt-5.5-pro): Limit reached. Try again after 2:37 PM.'
  );
  assert.equal(
    formatModelSelectionFailureMessage('gpt-5.5-pro', {
      ok: false,
      reason: 'model-unavailable',
      details: {
        reason: 'Requested model option is disabled in ChatGPT.',
        source: 'option-disabled',
      },
    }),
    'Requested ChatGPT model is not available (gpt-5.5-pro): Requested model option is disabled in ChatGPT.'
  );
});

test('model picker selection flow has an explicit unavailable-model failure path', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /status: 'model-unavailable'/);
  assert.match(source, /hoverOption/);
  assert.match(source, /optionUnavailableDetails/);
  assert.match(source, /collectVisibleUnavailableMessages/);
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

test('removeConfirmedAttachmentFiles deletes only the requested files and deduplicates paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-cleanup-'));
  const firstPath = join(root, 'codebase.zip');
  const secondPath = join(root, 'keep.zip');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(firstPath, 'generated');
  writeFileSync(secondPath, 'keep');

  const result = removeConfirmedAttachmentFiles([firstPath, firstPath]);

  assert.deepEqual(result, { failedCount: 0, removedCount: 1 });
  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), true);
});

test('removeConfirmedAttachmentFiles warns without recursively deleting unexpected directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-cleanup-'));
  const warnings = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = removeConfirmedAttachmentFiles([root], (message) => warnings.push(message));

  assert.deepEqual(result, { failedCount: 1, removedCount: 0 });
  assert.equal(existsSync(root), true);
  assert.match(warnings[0], /Could not remove confirmed local attachment/);
});

test('draft cleanup retains waited attachments through response capture', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /REVIEW_GPT_DRAFT_CLEANUP_FILES/u);
  assert.match(
    source,
    /if \(shouldWaitForResponse\) \{[\s\S]*waitedAttachmentCleanupPending = true;[\s\S]*\} else \{[\s\S]*cleanupConfirmedDraftAttachments\('the send'\);[\s\S]*if \(waitedAttachmentCleanupPending\) \{[\s\S]*cleanupConfirmedDraftAttachments\('the response capture'\);/u,
  );
});

test('non-dry runs isolate generated attachments by run before browser staging', () => {
  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');
  assert.match(source, /mkdtempSync\(join\(tmpdir\(\), 'review-gpt-attachments-'\)\)/u);
  assert.match(source, /prepareChatgptDraft\([\s\S]*attachmentPaths,[\s\S]*cleanupFilePaths,/u);
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

test('summarizeAttachmentVerification rejects prompt text that merely names the expected artifact', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 0,
      attachmentUiSignature: '',
      attachmentText: '',
      composerText: 'Use `audit.zip` as the sole repository-content source.',
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
  assert.equal(summary.namesVisible, false);
  assert.match(formatAttachmentVerificationSummary(summary), /attached=1\/1/);
});

test('summarizeAttachmentVerification confirms attachments through composer tile accessible names', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 1,
      attachmentUiSignature: 'remove file 1 audit zip',
      attachmentText: 'Remove file 1: audit.zip',
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

  assert.equal(summary.confirmed, true);
  assert.equal(summary.namesVisible, true);
});

test('summarizeAttachmentVerification tolerates the deduped filename ChatGPT assigns a repeat upload', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 1,
      attachmentUiSignature: 'remove file 1 codebase 942 zip',
      attachmentText: 'Remove file 1: codebase(942).zip',
      composerText: '',
      uploading: false,
      fileInputReady: true,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 0,
      attachmentUiSignature: '',
    },
    ['codebase.zip'],
    1
  );

  assert.equal(summary.confirmed, true);
  assert.equal(summary.namesVisible, true);
});

test('buildAttachmentNameMatcher accepts deduped names but not unrelated attachments', () => {
  const matcher = buildAttachmentNameMatcher('codebase.zip');

  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: codebase.zip')), true);
  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: codebase(942).zip')), true);
  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: codebase(20260815-191913).zip')), true);
  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: codebase(20260815191913).zip')), true);
  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: codebase(2026-08-15).zip')), false);
  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: codebase.tar.gz')), false);
  assert.equal(matcher.test(normalizeAttachmentSearchText('Remove file 1: repo.repomix.zip')), false);
});

test('composer attachment signals read accessible names so icon-only tiles expose filenames', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /const ariaLabel = normalize\(node\.getAttribute\?\.\('aria-label'\)\);/u);
  assert.match(source, /\[ariaLabel, node\.innerText \|\| node\.textContent \|\| ''\]\.filter\(Boolean\)\.join\(' '\)/u);
});

test('draft-only staging retains generated attachments instead of cancelling the upload', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.match(source, /Retained generated local attachment artifact\(s\) for the unsent draft\./u);
  assert.match(source, /if \(!shouldSend\) \{[\s\S]*?retainedIdleDraftTargetId = ownedTargetId;/u);
  assert.match(source, /registerIdleDraftCleanup\(\{[\s\S]*?targetId: retainedIdleDraftTargetId/u);
  assert.doesNotMatch(source, /cleanupConfirmedDraftAttachments\('the upload'\)/u);
  assert.match(source, /cleanupConfirmedDraftAttachments\('the send'\)/u);
  assert.match(source, /cleanupConfirmedDraftAttachments\('the response capture'\)/u);
});

test('summarizeAttachmentVerification accepts sequential uploads once all expected filenames are visible', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 1,
      attachmentUiCount: 3,
      attachmentUiSignature: 'repo repomix zip repo snapshot zip remove',
      attachmentText: 'repo repomix zip repo snapshot zip',
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

test('summarizeAttachmentVerification rejects upload ui progress without visible expected filenames', () => {
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

  assert.equal(summary.confirmed, false);
  assert.equal(summary.namesVisible, false);
  assert.equal(summary.attachedCount, 1);
  assert.equal(summary.effectiveAttachedCount, 2);
  assert.equal(summary.attachedEnough, true);
  assert.match(formatAttachmentVerificationSummary(summary), /attached=2\/2/);
});

test('summarizeAttachmentVerification matches visible filenames through normalized composer text', () => {
  const summary = summarizeAttachmentVerification(
    {
      attachedCount: 0,
      attachmentUiCount: 2,
      attachmentUiSignature: 'repo repomix zip repo snapshot zip',
      attachmentText: 'Repo Repomix ZIP Repo Snapshot ZIP',
      composerText: '',
      uploading: false,
      fileInputReady: true,
      readyState: 'complete',
    },
    {
      attachmentUiCount: 0,
      attachmentUiSignature: '',
    },
    ['repo.repomix.zip', 'repo.snapshot.zip'],
    2
  );

  assert.equal(summary.confirmed, true);
  assert.equal(summary.namesVisible, true);
  assert.equal(summary.attachedEnough, true);
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

test('draft staging confirms attachments before placing review text in the composer', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  const attachmentStage = source.indexOf("currentStage = 'attachments'");
  const promptStage = source.indexOf("currentStage = 'prompt-prefill'");

  assert.notEqual(attachmentStage, -1);
  assert.notEqual(promptStage, -1);
  assert.equal(attachmentStage < promptStage, true);
});

test('draft automation closes its unsent owned target on ordinary termination signals', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');

  assert.match(source, /installOwnedTargetSignalCleanup/u);
  assert.match(source, /\['SIGINT', 'SIGTERM', 'SIGHUP'\]/u);
  assert.match(source, /const closeOwnedTargetOnSignal = async \(\) =>/u);
  assert.match(source, /await closeBackgroundTarget\(ownedTargetId, socketOwner\)/u);
  assert.match(source, /acceptedSendProven = true;[\s\S]*?ownedTargetSignalCleanup = null;/u);
});

test('draft automation keeps fresh targets background except connector native input', () => {
  const source = readFileSync(join(repoRoot, 'src', 'prepare-chatgpt-draft.js'), 'utf8');
  assert.doesNotMatch(source, /REVIEW_GPT_ALLOW_BROWSER_FOREGROUND/u);
  assert.doesNotMatch(source, /\/json\/new/u);
  assert.doesNotMatch(source, /bringPageToFront/u);
  assert.match(source, /background:\s*true/u);
  assert.match(source, /const activateCurrentPageForNativeInput = async/u);
  assert.match(source, /Page\.bringToFront/u);
  assert.match(source, /driveDraftAppConnectorSelection/u);
  // The response wait loop must never foreground the tab; capture relies on
  // focus emulation + an active page lifecycle instead of stealing OS focus.
  assert.doesNotMatch(source, /pollCount/u);
  assert.match(source, /const keepPageRenderingWhileBackgrounded = async/u);
  assert.match(source, /Emulation\.setFocusEmulationEnabled/u);
  assert.match(source, /Page\.setWebLifecycleState/u);
  assert.match(source, /releasePageFocusEmulation = async/u);
  assert.match(
    source,
    /Emulation\.setFocusEmulationEnabled', \{ enabled: false \}/u,
  );
  assert.match(source, /await releasePageFocusEmulation\(\);/u);
  assert.match(source, /Retained ChatGPT target could not release focus emulation/u);
  assert.match(
    source,
    /await sleep\(Math\.min\(generationActive \? 60_000 : 500, Math\.max\(1, deadline - Date\.now\(\)\)\)\);/u,
  );
});

test('managed browser balanced mode leaves all background throttling enabled', async () => {
  const {
    managedBrowserBackgroundArgs,
    managedBrowserDisplayArgs,
    managedBrowserLaunchArgs,
  } = await import(distReviewGptLib);
  assert.deepEqual(managedBrowserBackgroundArgs('balanced'), []);
  assert.deepEqual(
    managedBrowserBackgroundArgs('unthrottled'),
    [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  );
  assert.deepEqual(managedBrowserDisplayArgs('headful'), ['--new-window']);
  assert.deepEqual(managedBrowserDisplayArgs('headless'), ['--headless', '--window-size=1440,1000']);
  assert.deepEqual(
    managedBrowserLaunchArgs('headful', 'foreground', 'https://chatgpt.com'),
    ['--new-window', 'https://chatgpt.com'],
  );
  assert.deepEqual(
    managedBrowserLaunchArgs('headful', 'background', 'https://chatgpt.com'),
    ['--no-startup-window'],
  );
  assert.deepEqual(
    managedBrowserLaunchArgs('headless', 'background', 'https://chatgpt.com'),
    ['--headless', '--window-size=1440,1000', 'https://chatgpt.com'],
  );
});

test('managed browser lifecycle uses one lease per run and closes only after the final lease', () => {
  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');

  assert.match(source, /lease-\$\{randomUUID\(\)\}\.json/u);
  assert.match(source, /const liveLeasePaths = pruneManagedBrowserLeases\(lease\.stateDir\)/u);
  assert.match(source, /if \(liveLeasePaths\.length > 0\) \{\s*return 'active-runs';/u);
  assert.match(source, /return closeManagedBrowserIfIdle\(port\);/u);
  assert.match(source, /completedResponseCapture && resolvedConfig\.managedBrowserCloseAfterWait/u);
});

test('managed browser close waits for an idle endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const commands = [];
  let browserRunning = true;
  let targetChecks = 0;

  class ClosingBrowserWebSocket {
    listeners = new Map();

    constructor() {
      queueMicrotask(() => this.emit('open'));
    }

    addEventListener(type, listener, options = {}) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push({ listener, once: options.once === true });
      this.listeners.set(type, listeners);
    }

    close() {
      this.emit('close');
    }

    emit(type, event = {}) {
      const listeners = [...(this.listeners.get(type) ?? [])];
      for (const entry of listeners) {
        entry.listener(event);
        if (entry.once) {
          this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((candidate) => candidate !== entry),
          );
        }
      }
    }

    send(payload) {
      const command = JSON.parse(payload);
      commands.push(command);
      if (command.method === 'Browser.close') {
        browserRunning = false;
      }
      const targetInfos = command.method === 'Target.getTargets' && targetChecks === 0
        ? [{ id: 'closing-review', type: 'page', url: 'https://chatgpt.com/c/closing-review' }]
        : [
            { id: 'chatgpt-home', type: 'page', url: 'https://chatgpt.com/' },
            { id: 'new-tab', type: 'page', url: 'chrome://newtab/' },
          ];
      if (command.method === 'Target.getTargets') {
        targetChecks += 1;
      }
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({
          id: command.id,
          result: command.method === 'Target.getTargets' ? { targetInfos } : {},
        }),
      }));
    }
  }

  globalThis.fetch = async () => {
    if (!browserRunning) {
      throw new Error('browser closed');
    }
    return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://managed-browser' }), {
      status: 200,
    });
  };
  globalThis.WebSocket = ClosingBrowserWebSocket;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  const { closeManagedBrowserIfIdle } = await import(distReviewGptLib);
  assert.equal(await closeManagedBrowserIfIdle('9448'), 'closed');
  assert.deepEqual(commands.map((command) => command.method), [
    'Target.getTargets',
    'Target.getTargets',
    'Browser.close',
  ]);
});

test('managed browser close preserves an endpoint with another active page', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const commands = [];

  class BusyBrowserWebSocket {
    listeners = new Map();

    constructor() {
      queueMicrotask(() => this.emit('open'));
    }

    addEventListener(type, listener, options = {}) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push({ listener, once: options.once === true });
      this.listeners.set(type, listeners);
    }

    close() {
      this.emit('close');
    }

    emit(type, event = {}) {
      const listeners = [...(this.listeners.get(type) ?? [])];
      for (const entry of listeners) {
        entry.listener(event);
        if (entry.once) {
          this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((candidate) => candidate !== entry),
          );
        }
      }
    }

    send(payload) {
      const command = JSON.parse(payload);
      commands.push(command);
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({
          id: command.id,
          result: {
            targetInfos: [
              { id: 'chatgpt-home', type: 'page', url: 'https://chatgpt.com/' },
              { id: 'other-review', type: 'page', url: 'https://chatgpt.com/c/other-review' },
            ],
          },
        }),
      }));
    }
  }

  globalThis.fetch = async () => new Response(
    JSON.stringify({ webSocketDebuggerUrl: 'ws://managed-browser' }),
    { status: 200 },
  );
  globalThis.WebSocket = BusyBrowserWebSocket;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  const { closeManagedBrowserIfIdle } = await import(distReviewGptLib);
  assert.equal(await closeManagedBrowserIfIdle('9448'), 'busy');
  assert.equal(commands.length, 20);
  assert.equal(commands.every((command) => command.method === 'Target.getTargets'), true);
});

test('managed browser startup fails closed before launching against a held profile', () => {
  const source = readFileSync(join(repoRoot, 'src', 'review-gpt-lib.mts'), 'utf8');
  const ensureStart = source.indexOf('async function ensureRemoteChrome');
  const lockCheck = source.indexOf('describeProfileLock(userDataDir)', ensureStart);
  const browserStart = source.indexOf('startRemoteChrome(', ensureStart + 1);

  assert.notEqual(ensureStart, -1);
  assert.notEqual(lockCheck, -1);
  assert.notEqual(browserStart, -1);
  assert.equal(lockCheck < browserStart, true);
});

test('classifies credential-shaped artifact paths without flagging ordinary sources', async () => {
  const { findSensitiveArtifactPaths, sensitiveArtifactReason } = await import(distReviewGptLib);

  assert.equal(sensitiveArtifactReason('apps/web/.env.local'), 'dotenv file');
  assert.equal(sensitiveArtifactReason('.env'), 'dotenv file');
  assert.equal(sensitiveArtifactReason('apps/web/.env.production.local'), 'dotenv file');
  assert.equal(sensitiveArtifactReason('packages/api/.npmrc'), 'credential file');
  assert.equal(sensitiveArtifactReason('scripts/.envrc'), 'credential file');
  assert.equal(sensitiveArtifactReason('home/.ssh/config'), 'credential directory');
  assert.equal(sensitiveArtifactReason('certs/apple-push.p8'), 'private key or certificate (.p8)');
  assert.equal(sensitiveArtifactReason('deploy/server.pem'), 'private key or certificate (.pem)');

  assert.equal(sensitiveArtifactReason('.env.example'), undefined);
  assert.equal(sensitiveArtifactReason('apps/web/.env.local.example'), undefined);
  assert.equal(sensitiveArtifactReason('src/lib/env.ts'), undefined);
  assert.equal(sensitiveArtifactReason('src/lib/secrets.ts'), undefined);
  assert.equal(sensitiveArtifactReason('docs/monkey.md'), undefined);

  assert.deepEqual(
    findSensitiveArtifactPaths(['src/index.ts', './apps/web/.env.local', 'apps/web/.env.local']),
    [{ path: 'apps/web/.env.local', reason: 'dotenv file' }],
  );
});

test('refuses to attach a packaged ZIP that contains a dotenv file', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, '.env.local'), 'SECRET_TOKEN=do-not-upload\n');
  writeFileSync(
    join(root, 'scripts', 'package-audit-context.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
zip_path="$PWD/audit-packages/test-audit.zip"
rm -f "$zip_path"
(cd "$PWD" && zip -q "$zip_path" src/audit-source.ts .env.local)
echo "Audit package created."
echo "Included files: 2"
echo "ZIP: $zip_path (1K)"
`
  );
  chmodSync(join(root, 'scripts', 'package-audit-context.sh'), 0o755);

  const result = runCli(root, ['--dry-run']);
  const resultOutput = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, resultOutput);
  assert.match(resultOutput, /refusing to attach test-audit\.zip/);
  assert.match(resultOutput, /- \.env\.local \(dotenv file\)/);
  assert.match(resultOutput, /REVIEW_GPT_ALLOW_SENSITIVE_ARTIFACTS=1/);
  assert.doesNotMatch(resultOutput, /do-not-upload/);

  const override = runCli(root, ['--dry-run'], { env: { REVIEW_GPT_ALLOW_SENSITIVE_ARTIFACTS: '1' } });
  const overrideOutput = `${override.stdout}${override.stderr}`;
  assert.equal(override.status, 0, overrideOutput);
  assert.match(overrideOutput, /Warning: attaching 1 credential-shaped file\(s\)/);
});

test('defaults the repo-tools credential filter on for the package script', (t) => {
  const root = createFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    join(root, 'scripts', 'package-audit-context.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE:-unset}" > "$PWD/audit-packages/exclude-sensitive.txt"
zip_path="$PWD/audit-packages/test-audit.zip"
rm -f "$zip_path"
(cd "$PWD" && zip -q "$zip_path" src/audit-source.ts)
echo "Audit package created."
echo "Included files: 1"
echo "ZIP: $zip_path (1K)"
`
  );
  chmodSync(join(root, 'scripts', 'package-audit-context.sh'), 0o755);

  const result = runCli(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'audit-packages', 'exclude-sensitive.txt'), 'utf8').trim(), '1');

  const opted = runCli(root, ['--dry-run'], { env: { COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE: '0' } });
  assert.equal(opted.status, 0, opted.stderr);
  assert.equal(readFileSync(join(root, 'audit-packages', 'exclude-sensitive.txt'), 'utf8').trim(), '0');
});
