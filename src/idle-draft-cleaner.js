const { spawn } = require('node:child_process');
const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { basename, join } = require('node:path');
const { randomUUID } = require('node:crypto');

const { CHATGPT_STOP_SELECTORS } = require('./chatgpt-dom-snapshot-shared.js');

const CLEANER_SCAN_INTERVAL_MS = 60_000;
const CLEANER_RETRY_MS = 5 * 60_000;
const CDP_TIMEOUT_MS = 5_000;
const LEASE_SUFFIX = '.json';
const LOCK_FILE = 'cleaner.lock';
const REGISTRATION_LOCK_FILE = 'registration.lock';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Idle draft cleanup requires a valid managed browser port.');
  }
  return port;
}

function normalizeTargetId(value) {
  const targetId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(targetId)) {
    throw new Error('Idle draft cleanup requires a valid browser target ID.');
  }
  return targetId;
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Idle draft cleanup requires a non-negative timeout.');
  }
  return Math.floor(timeoutMs);
}

function defaultStateRoot() {
  return join(homedir(), '.review-gpt', 'idle-drafts');
}

function laneStateDir(port, stateRoot = defaultStateRoot()) {
  return join(stateRoot, String(normalizePort(port)));
}

function leasePath(stateDir, targetId) {
  return join(stateDir, `${normalizeTargetId(targetId)}${LEASE_SUFFIX}`);
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, filePath);
}

function startCleaner(port) {
  const child = spawn(process.execPath, [__filename, '--run', '--port', String(port)], {
    detached: true,
    env: {
      HOME: homedir(),
      PATH: process.env.PATH || '',
      TMPDIR: process.env.TMPDIR || '',
    },
    stdio: 'ignore',
  });
  child.unref();
}

function registerIdleDraftCleanup({
  now = Date.now(),
  port,
  startWorker = true,
  stateRoot,
  targetId,
  timeoutMs,
}) {
  const normalizedPort = normalizePort(port);
  const normalizedTargetId = normalizeTargetId(targetId);
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === 0) return false;

  const stateDir = laneStateDir(normalizedPort, stateRoot);
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  withRegistrationLock(stateDir, () => {
    writeJsonAtomic(leasePath(stateDir, normalizedTargetId), {
      expiresAt: now + normalizedTimeoutMs,
      port: normalizedPort,
      targetId: normalizedTargetId,
    });
    if (startWorker && !processLockIsHeld(join(stateDir, LOCK_FILE))) {
      startCleaner(normalizedPort);
    }
  });
  return true;
}

function parseLease(filePath, expectedPort) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const port = normalizePort(parsed?.port);
    const targetId = normalizeTargetId(parsed?.targetId);
    const expiresAt = Number(parsed?.expiresAt);
    if (port !== expectedPort || !Number.isFinite(expiresAt) || expiresAt <= 0) {
      return null;
    }
    return { expiresAt, filePath, port, targetId };
  } catch {
    return null;
  }
}

function listLeases(stateDir, port) {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(LEASE_SUFFIX))
    .map((entry) => parseLease(join(stateDir, entry.name), port))
    .filter(Boolean);
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readProcessLockOwner(lockPath) {
  try {
    return Number(readFileSync(lockPath, 'utf8').trim());
  } catch {
    return 0;
  }
}

function processLockIsHeld(lockPath) {
  const ownerPid = readProcessLockOwner(lockPath);
  if (processIsRunning(ownerPid)) return true;
  rmSync(lockPath, { force: true });
  return false;
}

function tryAcquireProcessLock(lockPath) {
  try {
    const descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (processLockIsHeld(lockPath)) return false;
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      closeSync(descriptor);
      return true;
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') return false;
      throw retryError;
    }
  }
}

function acquireCleanerLock(stateDir) {
  const lockPath = join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryAcquireProcessLock(lockPath)) return lockPath;
  }
  return '';
}

function blockingPause(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function withRegistrationLock(stateDir, callback) {
  const lockPath = join(stateDir, REGISTRATION_LOCK_FILE);
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  while (!tryAcquireProcessLock(lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out coordinating idle draft cleanup registration.');
    }
    blockingPause(25);
  }
  try {
    return callback();
  } finally {
    releaseProcessLock(lockPath);
  }
}

function releaseProcessLock(lockPath) {
  if (!lockPath) return;
  try {
    const ownerPid = readProcessLockOwner(lockPath);
    if (ownerPid === process.pid) rmSync(lockPath, { force: true });
  } catch {}
}

function releaseCleanerLock(lockPath) {
  releaseProcessLock(lockPath);
}

async function fetchJson(port, path, timeoutMs = CDP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Browser endpoint returned ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function sendWebSocketCommand(url, method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const commandId = 1;
    const finish = (callback, value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      callback(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`Browser command timed out: ${method}`)),
      timeoutMs,
    );
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: commandId, method, params }));
    }, { once: true });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.id !== commandId) return;
      if (message.error) {
        finish(reject, new Error(message.error.message || `Browser command failed: ${method}`));
        return;
      }
      finish(resolve, message.result || {});
    });
    socket.addEventListener('error', (event) => {
      finish(reject, event.error || new Error(`Browser socket failed: ${method}`));
    }, { once: true });
  });
}

function buildIdleDraftInspectionExpression() {
  const stopSelectors = JSON.stringify(CHATGPT_STOP_SELECTORS);
  return `(() => {
    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return {
      busy: ${stopSelectors}.some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisible)),
      visible: document.visibilityState === 'visible',
    };
  })()`;
}

function idleDraftCanClose(inspection) {
  return inspection?.visible === false && inspection?.busy === false;
}

function isChatGptTarget(target) {
  if (target?.type !== 'page' || !target?.webSocketDebuggerUrl) return false;
  try {
    return new URL(target.url).origin === 'https://chatgpt.com';
  } catch {
    return false;
  }
}

async function inspectAndCloseIdleDraft(lease) {
  try {
    const targets = await fetchJson(lease.port, '/json/list');
    const target = Array.isArray(targets)
      ? targets.find((entry) => String(entry?.id || '') === lease.targetId)
      : null;
    if (!target) return 'missing';
    if (!isChatGptTarget(target)) return 'defer';

    const inspectionResult = await sendWebSocketCommand(
      target.webSocketDebuggerUrl,
      'Runtime.evaluate',
      {
        awaitPromise: true,
        expression: buildIdleDraftInspectionExpression(),
        returnByValue: true,
      },
    );
    if (!idleDraftCanClose(inspectionResult?.result?.value)) return 'defer';

    const version = await fetchJson(lease.port, '/json/version');
    if (!version?.webSocketDebuggerUrl) return 'defer';
    const closeResult = await sendWebSocketCommand(
      version.webSocketDebuggerUrl,
      'Target.closeTarget',
      { targetId: lease.targetId },
    );
    if (closeResult?.success !== true) return 'defer';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remainingTargets = await fetchJson(lease.port, '/json/list');
      const stillPresent = Array.isArray(remainingTargets) && remainingTargets.some(
        (entry) => String(entry?.id || '') === lease.targetId,
      );
      if (!stillPresent) return 'closed';
      await sleep(100);
    }
    return 'defer';
  } catch {
    return 'defer';
  }
}

async function runCleaner(port, { stateRoot } = {}) {
  const normalizedPort = normalizePort(port);
  const stateDir = laneStateDir(normalizedPort, stateRoot);
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  let lockPath = acquireCleanerLock(stateDir);
  if (!lockPath) return;

  const release = () => releaseCleanerLock(lockPath);
  process.once('exit', release);
  try {
    while (true) {
      const leases = listLeases(stateDir, normalizedPort);
      if (leases.length === 0) {
        let shouldExit = false;
        withRegistrationLock(stateDir, () => {
          if (listLeases(stateDir, normalizedPort).length === 0) {
            releaseCleanerLock(lockPath);
            lockPath = '';
            shouldExit = true;
          }
        });
        if (shouldExit) return;
        continue;
      }

      const now = Date.now();
      for (const lease of leases) {
        if (lease.expiresAt > now) continue;
        const action = await inspectAndCloseIdleDraft(lease);
        if (action === 'closed' || action === 'missing') {
          rmSync(lease.filePath, { force: true });
        } else {
          writeJsonAtomic(lease.filePath, {
            expiresAt: Date.now() + CLEANER_RETRY_MS,
            port: lease.port,
            targetId: lease.targetId,
          });
        }
      }

      const remaining = listLeases(stateDir, normalizedPort);
      if (remaining.length === 0) return;
      const nextExpiry = Math.min(...remaining.map((lease) => lease.expiresAt));
      const delay = Math.max(250, Math.min(CLEANER_SCAN_INTERVAL_MS, nextExpiry - Date.now()));
      await sleep(delay);
    }
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

function cliPort(argv) {
  const index = argv.indexOf('--port');
  return index >= 0 ? argv[index + 1] : '';
}

if (require.main === module && process.argv.includes('--run')) {
  void runCleaner(cliPort(process.argv.slice(2))).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  buildIdleDraftInspectionExpression,
  idleDraftCanClose,
  registerIdleDraftCleanup,
  runCleaner,
};
