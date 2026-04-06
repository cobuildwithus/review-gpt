import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ResolvedCodexHome = {
  homePath: string;
  resolution: 'discovered' | 'explicit';
};

export type CodexSessionLogRecord = {
  filePath: string;
  modifiedMs: number;
  sessionId: string;
};

export function redactHomePath(value: string, homePath = homedir()): string {
  if (!value) {
    return value;
  }
  if (value === homePath) {
    return '<HOME_DIR>';
  }
  if (value.startsWith(`${homePath}${path.sep}`)) {
    return `<HOME_DIR>${value.slice(homePath.length)}`;
  }
  return value;
}

export function formatPathForDisplay(targetPath: string, cwd = process.cwd()): string {
  const relativePath = path.relative(cwd, targetPath);
  if (!relativePath) {
    return '.';
  }
  if (relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..') {
    return relativePath;
  }
  return redactHomePath(targetPath);
}

export function formatCodexHomeForDisplay(homePath: string): string {
  const label = path.basename(homePath);
  return label || redactHomePath(homePath);
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compareNodeVersionLabels(leftPath: string, rightPath: string): number {
  const parseParts = (targetPath: string) =>
    (path.basename(path.dirname(targetPath)).match(/\d+/gu) ?? []).map((part) => Number.parseInt(part, 10));
  const left = parseParts(leftPath);
  const right = parseParts(rightPath);
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return leftPath.localeCompare(rightPath);
}

export function listDefaultCodexBins(
  homePath = homedir(),
  envPath = process.env.PATH,
  envCodexBin = process.env.CODEX_BIN,
  nodeExecPath = process.execPath,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string | undefined) => {
    const trimmed = String(candidate ?? '').trim();
    if (!trimmed) {
      return;
    }
    const resolved = path.resolve(trimmed);
    if (!isExecutableFile(resolved) || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    candidates.push(resolved);
  };

  addCandidate(envCodexBin);

  for (const entry of String(envPath ?? '').split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    addCandidate(path.join(entry, 'codex'));
  }

  addCandidate(path.join(path.dirname(nodeExecPath), 'codex'));
  addCandidate(path.join(homePath, '.local', 'bin', 'codex'));
  addCandidate('/opt/homebrew/bin/codex');
  addCandidate('/usr/local/bin/codex');
  addCandidate('/usr/bin/codex');

  const nvmBinRoot = path.join(homePath, '.nvm', 'versions', 'node');
  if (existsSync(nvmBinRoot)) {
    const nvmBins = readdirSync(nvmBinRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(nvmBinRoot, entry.name, 'bin', 'codex'))
      .filter((candidate) => isExecutableFile(candidate))
      .sort(compareNodeVersionLabels)
      .reverse();
    for (const candidate of nvmBins) {
      addCandidate(candidate);
    }
  }

  return candidates;
}

export function resolveCodexBin(
  options: {
    candidateBins?: string[];
    codexBin?: string | undefined;
    envCodexBin?: string | undefined;
    envPath?: string | undefined;
    homePath?: string | undefined;
    nodeExecPath?: string | undefined;
  } = {},
): string {
  if (options.codexBin) {
    const explicit = path.resolve(options.codexBin);
    if (!isExecutableFile(explicit)) {
      throw new Error(`Configured Codex binary is not executable: ${redactHomePath(explicit)}`);
    }
    return explicit;
  }

  const candidates =
    options.candidateBins ??
    listDefaultCodexBins(
      options.homePath ?? homedir(),
      options.envPath ?? process.env.PATH,
      options.envCodexBin ?? process.env.CODEX_BIN,
      options.nodeExecPath ?? process.execPath,
    );
  if (candidates.length > 0) {
    return candidates[0] as string;
  }

  throw new Error(
    'Could not find an executable codex CLI. Set CODEX_BIN or install codex into PATH, ~/.nvm, ~/.local/bin, /opt/homebrew/bin, or /usr/local/bin.',
  );
}

export function listDefaultCodexHomes(baseHomeDir = homedir(), envCodexHome = process.env.CODEX_HOME): string[] {
  const homes: string[] = [];
  const seen = new Set<string>();

  const addHome = (candidate: string | undefined) => {
    const trimmed = String(candidate ?? '').trim();
    if (!trimmed) {
      return;
    }
    const resolved = path.resolve(trimmed);
    if (!existsSync(resolved) || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    homes.push(resolved);
  };

  addHome(envCodexHome);

  for (const entry of readdirSync(baseHomeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^\.codex(?:-[A-Za-z0-9._-]+)?$/u.test(entry.name)) {
      continue;
    }
    addHome(path.join(baseHomeDir, entry.name));
  }

  return homes.sort((left, right) => left.localeCompare(right));
}

function walkFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(resolved);
        continue;
      }
      if (entry.isFile()) {
        files.push(resolved);
      }
    }
  }
  return files;
}

function homeHasShellSnapshot(homePath: string, sessionId: string): boolean {
  const snapshotDir = path.join(homePath, 'shell_snapshots');
  if (!existsSync(snapshotDir)) {
    return false;
  }
  return readdirSync(snapshotDir, { withFileTypes: true }).some(
    (entry) => entry.isFile() && entry.name.startsWith(`${sessionId}.`),
  );
}

function sessionLogFileNameMatchesSessionId(filePath: string, sessionId: string): boolean {
  const baseName = path.basename(filePath);
  return (
    baseName === `${sessionId}.json` ||
    baseName === `${sessionId}.jsonl` ||
    baseName.endsWith(`-${sessionId}.json`) ||
    baseName.endsWith(`-${sessionId}.jsonl`)
  );
}

function parseSessionIdFromSessionRecord(record: unknown): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  if (
    'type' in record &&
    record.type === 'session_meta' &&
    'payload' in record &&
    record.payload &&
    typeof record.payload === 'object' &&
    'id' in record.payload &&
    typeof record.payload.id === 'string'
  ) {
    return record.payload.id;
  }

  if ('id' in record && typeof record.id === 'string') {
    return record.id;
  }

  return null;
}

function extractUserMessageTextsFromSessionRecord(record: unknown): string[] {
  if (!record || typeof record !== 'object') {
    return [];
  }

  if (
    'type' in record &&
    record.type === 'event_msg' &&
    'payload' in record &&
    record.payload &&
    typeof record.payload === 'object' &&
    'payload' in record.payload &&
    record.payload.payload &&
    typeof record.payload.payload === 'object' &&
    'type' in record.payload.payload &&
    record.payload.payload.type === 'user_message' &&
    'message' in record.payload.payload &&
    typeof record.payload.payload.message === 'string'
  ) {
    return [record.payload.payload.message];
  }

  if (
    'type' in record &&
    record.type === 'event_msg' &&
    'payload' in record &&
    record.payload &&
    typeof record.payload === 'object' &&
    'type' in record.payload &&
    record.payload.type === 'user_message' &&
    'message' in record.payload &&
    typeof record.payload.message === 'string'
  ) {
    return [record.payload.message];
  }

  if (
    'type' in record &&
    record.type === 'response_item' &&
    'payload' in record &&
    record.payload &&
    typeof record.payload === 'object' &&
    'type' in record.payload &&
    record.payload.type === 'message' &&
    'role' in record.payload &&
    record.payload.role === 'user' &&
    'content' in record.payload &&
    Array.isArray(record.payload.content)
  ) {
    return record.payload.content
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        if ('text' in entry && typeof entry.text === 'string') {
          return [entry.text];
        }
        return [];
      })
      .filter((value) => value.length > 0);
  }

  return [];
}

function sessionLogOwnsSession(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.jsonl') {
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const ownedSessionId = parseSessionIdFromSessionRecord(JSON.parse(trimmed) as unknown);
        if (ownedSessionId) {
          return ownedSessionId;
        }
      }
      return null;
    }

    if (extension === '.json') {
      return parseSessionIdFromSessionRecord(JSON.parse(raw) as unknown);
    }
  } catch {
    return null;
  }

  return null;
}

export function listCodexSessionLogs(homePath: string): CodexSessionLogRecord[] {
  const sessionsDir = path.join(homePath, 'sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const logs: CodexSessionLogRecord[] = [];
  for (const filePath of walkFiles(sessionsDir)) {
    if (!/\.(json|jsonl)$/u.test(filePath)) {
      continue;
    }
    const sessionId = sessionLogOwnsSession(filePath);
    if (!sessionId) {
      continue;
    }
    let modifiedMs = 0;
    try {
      modifiedMs = statSync(filePath).mtimeMs;
    } catch {
      modifiedMs = 0;
    }
    logs.push({
      filePath,
      modifiedMs,
      sessionId,
    });
  }

  return logs.sort((left, right) => {
    if (right.modifiedMs !== left.modifiedMs) {
      return right.modifiedMs - left.modifiedMs;
    }
    return left.filePath.localeCompare(right.filePath);
  });
}

export function sessionLogContainsUserText(filePath: string, expectedText: string): boolean {
  const trimmedExpectedText = String(expectedText ?? '').trim();
  if (!trimmedExpectedText) {
    return false;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const extension = path.extname(filePath).toLowerCase();
    const records =
      extension === '.jsonl'
        ? raw
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as unknown)
        : [JSON.parse(raw) as unknown];

    return records.some((record) =>
      extractUserMessageTextsFromSessionRecord(record).some((message) => message.includes(trimmedExpectedText)),
    );
  } catch {
    return false;
  }
}

function fileOwnsSession(filePath: string, sessionId: string): boolean {
  if (sessionLogFileNameMatchesSessionId(filePath, sessionId)) {
    return true;
  }

  return sessionLogOwnsSession(filePath) === sessionId;
}

function homeHasSessionLog(homePath: string, sessionId: string): boolean {
  const sessionsDir = path.join(homePath, 'sessions');
  if (!existsSync(sessionsDir)) {
    return false;
  }

  for (const filePath of walkFiles(sessionsDir)) {
    if (!/\.(json|jsonl)$/u.test(filePath)) {
      continue;
    }
    if (fileOwnsSession(filePath, sessionId)) {
      return true;
    }
  }

  return false;
}

export function homeContainsSession(homePath: string, sessionId: string): boolean {
  return homeHasShellSnapshot(homePath, sessionId) || homeHasSessionLog(homePath, sessionId);
}

export function findMatchingCodexHomes(sessionId: string, candidateHomes = listDefaultCodexHomes()): string[] {
  return candidateHomes.filter((homePath) => homeContainsSession(homePath, sessionId));
}

export function resolveCodexHomeForSession(
  sessionId: string,
  options: {
    candidateHomes?: string[];
    codexHome?: string | undefined;
  } = {},
): ResolvedCodexHome {
  const trimmedSessionId = String(sessionId ?? '').trim();
  if (!trimmedSessionId) {
    throw new Error('Session ID is required to resolve a Codex home.');
  }

  if (options.codexHome) {
    const explicitHome = path.resolve(options.codexHome);
    if (!existsSync(explicitHome)) {
      throw new Error(`Configured Codex home does not exist: ${redactHomePath(explicitHome)}`);
    }
    if (!homeContainsSession(explicitHome, trimmedSessionId)) {
      throw new Error(
        `Configured Codex home ${formatCodexHomeForDisplay(explicitHome)} does not contain session ${trimmedSessionId}.`,
      );
    }
    return {
      homePath: explicitHome,
      resolution: 'explicit',
    };
  }

  const candidateHomes = options.candidateHomes ?? listDefaultCodexHomes();
  const matches = findMatchingCodexHomes(trimmedSessionId, candidateHomes);
  if (matches.length === 1) {
    return {
      homePath: matches[0] as string,
      resolution: 'discovered',
    };
  }
  if (matches.length === 0) {
    const searchedHomes = candidateHomes.map((homePath) => formatCodexHomeForDisplay(homePath)).join(', ') || '(none)';
    throw new Error(
      `Could not find session ${trimmedSessionId} in local Codex homes: ${searchedHomes}. Pass --codex-home to pin it explicitly.`,
    );
  }

  throw new Error(
    `Session ${trimmedSessionId} appears in multiple Codex homes: ${matches.map((homePath) => formatCodexHomeForDisplay(homePath)).join(', ')}. Pass --codex-home to disambiguate.`,
  );
}
