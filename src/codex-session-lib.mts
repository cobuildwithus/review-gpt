import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ResolvedCodexHome = {
  homePath: string;
  resolution: 'discovered' | 'explicit';
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

function homeHasSessionLog(homePath: string, sessionId: string): boolean {
  const sessionsDir = path.join(homePath, 'sessions');
  if (!existsSync(sessionsDir)) {
    return false;
  }

  for (const filePath of walkFiles(sessionsDir)) {
    if (!/\.(json|jsonl)$/u.test(filePath)) {
      continue;
    }
    try {
      if (readFileSync(filePath, 'utf8').includes(sessionId)) {
        return true;
      }
    } catch {
      continue;
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
