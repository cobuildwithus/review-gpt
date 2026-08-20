import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectThreadDiagnostics } from './chatgpt-thread-diagnostics-lib.mjs';
import { CdpClient } from './chatgpt-thread-lib.mjs';

const DEFAULT_WAIT_RESPONSE_TIMEOUT_MS = '7200000';
const DEFAULT_IDLE_DRAFT_TIMEOUT_MS = '1800000';
const DEFAULT_MINIMUM_MARKED_RESPONSE_MS = '300000';

export type CliOptions = {
  appConnector?: string | undefined;
  artifacts?: boolean | undefined;
  browserBinary?: boolean;
  browserPath?: string | undefined;
  chat?: string | undefined;
  chatId?: string | undefined;
  chatUrl?: string | undefined;
  config?: string | undefined;
  connector?: string | undefined;
  deepResearch?: boolean | undefined;
  dryRun?: boolean | undefined;
  headless?: boolean | undefined;
  idleDraftTimeout?: string | undefined;
  listPresets?: boolean | undefined;
  minimumMarkedResponseTime?: string | undefined;
  model?: string | undefined;
  noArtifacts?: boolean | undefined;
  noTests?: boolean | undefined;
  tests?: boolean | undefined;
  preset?: string[] | undefined;
  prompt?: string[] | undefined;
  promptFile?: string[] | undefined;
  withTests?: boolean | undefined;
  responseFile?: string | undefined;
  responseMarker?: string | undefined;
  send?: boolean | undefined;
  submit?: boolean | undefined;
  thinking?: string | undefined;
  timeout?: string | undefined;
  wait?: boolean | undefined;
  waitTimeout?: string | undefined;
  zip?: boolean | undefined;
};

type LoadedConfig = {
  appConnector: string;
  browser: string;
  browserBinaryPath: string;
  browserChromePath: string;
  browserPath: string;
  browserProfile: string;
  chatgptUrl: string;
  draftTimeoutMs: string;
  includeDocs: string;
  includeTests: string;
  idleDraftTimeoutMs: string;
  minimumMarkedResponseMs: string;
  managedBrowserBackgroundMode: string;
  managedBrowserCloseAfterWait: string;
  managedBrowserDisplayMode: string;
  managedBrowserLaunchMode: string;
  managedBrowserPort: string;
  managedBrowserProfile: string;
  managedBrowserUserDataDir: string;
  model: string;
  namePrefix: string;
  outDir: string;
  packageScript: string;
  presetAliases: Array<{ input: string; target: string }>;
  presetDir: string;
  presetGroups: Array<{ description: string; members: string[]; name: string }>;
  presets: Array<{ description: string; name: string; path: string }>;
  repomixAttachmentFormat: string;
  repomixIgnorePatterns: string[];
  remoteManaged: string;
  remotePort: string;
  repoContextUrl: string;
  responseFile: string;
  responseTimeoutMs: string;
  attachArtifacts: string;
  snapshotAttachmentName: string;
  thinking: string;
};

type ResolvedConfig = {
  appConnector?: string;
  browser: string;
  browserChromePath: string;
  browserProfile: string;
  chatgptUrl: string;
  draftTimeoutMs?: string;
  includeDocs: boolean;
  includeTests: boolean;
  idleDraftTimeoutMs: string;
  minimumMarkedResponseMs: string;
  managedBrowserBackgroundMode: ManagedBrowserBackgroundMode;
  managedBrowserCloseAfterWait: boolean;
  managedBrowserDisplayMode: ManagedBrowserDisplayMode;
  managedBrowserLaunchMode: ManagedBrowserLaunchMode;
  namePrefix: string;
  outDir: string;
  packageScript: string;
  presets: Array<{ description: string; name: string; path: string }>;
  presetAliases: Map<string, string>;
  presetDir: string;
  presetGroups: Array<{ description: string; members: string[]; name: string }>;
  repomixAttachmentFormat: 'none' | 'xml' | 'zip';
  repomixIgnorePatterns: string[];
  remoteManaged: boolean;
  remotePort: string;
  repoContextUrl?: string;
  remoteProfile: string;
  remoteUserDataDir: string;
  responseFile?: string;
  responseTimeoutMs?: string;
  attachArtifacts: boolean;
  snapshotAttachmentName: string;
  thinking?: string;
  model?: string;
};

type RunContext = {
  cwd: string;
};

type StagingPlan = {
  effectiveAppConnector: string;
  attachArtifacts: boolean;
  autoSend: boolean;
  baseCommit?: string;
  chatgptUrl: string;
  deepResearch: boolean;
  detectedBrowserProfile?: string;
  draftMode: 'chat' | 'deep-research';
  draftPromptText: string;
  draftTimeoutMs: string;
  effectiveModel: string;
  effectiveThinking: string;
  extraPromptFiles: string[];
  idleDraftTimeoutMs: string;
  minimumMarkedResponseMs: string;
  managedBrowserBackgroundMode: ManagedBrowserBackgroundMode;
  managedBrowserCloseAfterWait: boolean;
  managedBrowserDisplayMode: ManagedBrowserDisplayMode;
  managedBrowserLaunchMode: ManagedBrowserLaunchMode;
  managedProfileState: string;
  promptChunks: string[];
  repoContextUrl?: string;
  remotePort: string;
  remoteProfile: string;
  remoteUserDataDir: string;
  resolvedBrowserChromePath: string;
  resolvedBrowserFamily: string;
  resolvedResponseFile?: string;
  repomixPath?: string;
  responseMarker?: string;
  responseTimeoutMs: string;
  selectedPresets: string[];
  waitResponse: boolean;
  zipPath: string;
};

type DraftPreparationResult = {
  captureMetadataPath?: string;
  conversationId?: string;
  conversationUrl?: string;
};

class DraftPreparationError extends Error {
  captureMetadataPath?: string;
  conversationUrl?: string;
  driverLogPath?: string;
  status?: number | null;

  constructor(
    message: string,
    options: {
      conversationUrl?: string;
      captureMetadataPath?: string;
      driverLogPath?: string;
      status?: number | null;
    } = {},
  ) {
    super(message);
    this.name = 'DraftPreparationError';
    this.captureMetadataPath = options.captureMetadataPath;
    this.conversationUrl = options.conversationUrl;
    this.driverLogPath = options.driverLogPath;
    this.status = options.status;
  }
}

export type ReviewGptRunResult = {
  artifactsAttached: boolean;
  autoSend: boolean;
  baseCommit?: string;
  browserEndpoint: string;
  captureMetadataPath?: string;
  chatId?: string;
  chatUrl: string;
  deepResearch: boolean;
  draftMode: 'chat' | 'deep-research';
  dryRun: boolean;
  responseFile?: string;
  selectedPresets: string[];
  waitResponse: boolean;
  wakeCommand?: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const compatScriptPath = resolve(__dirname, '../src/review-gpt-config-compat.sh');
const draftDriverPath = resolve(__dirname, '../src/prepare-chatgpt-draft.js');
const defaultManagedBrowserUserDataDir = join(homedir(), '.review-gpt', 'managed-chromium');
const legacyManagedBrowserUserDataDir = join(homedir(), '.oracle', 'remote-chrome');
const homeDir = homedir();
const defaultSnapshotAttachmentName = 'codebase.zip';

type ManagedBrowserBackgroundMode = 'balanced' | 'unthrottled';
type ManagedBrowserDisplayMode = 'headful' | 'headless';
type ManagedBrowserLaunchMode = 'foreground' | 'background';

type ManagedBrowserLease = {
  leasePath: string;
  stateDir: string;
};

type ManagedBrowserFinishResult =
  | 'released'
  | 'active-runs'
  | 'already-closed'
  | 'busy'
  | 'closed';

function trimWhitespace(value: string): string {
  return value.trim();
}

export function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

export function isCurrentTarget(value?: string): boolean {
  const normalized = normalizeToken(value ?? '');
  return normalized === '' || normalized === 'current' || normalized === 'keep' || normalized === 'skip';
}

export function parseDurationToMs(rawValue: string): string {
  const raw = trimWhitespace(rawValue);
  const normalized = raw.toLowerCase().replace(/\s+/g, '');

  if (!normalized) {
    throw new Error("Error: duration value cannot be empty.");
  }

  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  let remainder = normalized;
  let total = 0;
  let matched = false;
  while (remainder.length > 0) {
    const match = remainder.match(/^(\d+)(ms|s|m|h)(.*)$/);
    if (!match) {
      throw new Error(
        `Error: invalid duration '${raw}' (expected milliseconds or a duration like 90s, 10m, 1h2m).`,
      );
    }

    matched = true;
    const value = Number(match[1]);
    const unit = match[2];
    remainder = match[3] ?? '';
    switch (unit) {
      case 'ms':
        total += value;
        break;
      case 's':
        total += value * 1_000;
        break;
      case 'm':
        total += value * 60_000;
        break;
      case 'h':
        total += value * 3_600_000;
        break;
      default:
        throw new Error(`Error: unsupported duration unit '${unit}'.`);
    }
  }

  if (!matched) {
    throw new Error(
      `Error: invalid duration '${raw}' (expected milliseconds or a duration like 90s, 10m, 1h2m).`,
    );
  }

  return String(total);
}

function parsePositiveDurationToMs(rawValue: string, label: string): string {
  const parsed = parseDurationToMs(rawValue);
  const durationMs = Number(parsed);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error(`Error: ${label} must be a positive, finite duration.`);
  }
  return String(durationMs);
}

export function extractUrlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'https://chatgpt.com';
  }
}

export function resolveChatTargetUrl(rawTarget: string, baseUrl: string): string {
  const target = trimWhitespace(rawTarget);
  if (!target) {
    throw new Error('Error: chat target cannot be empty.');
  }
  if (/^https?:\/\//i.test(target)) {
    return target;
  }
  if (target.startsWith('/c/')) {
    return `${baseUrl.replace(/\/$/, '')}${target}`;
  }
  if (target.startsWith('c/')) {
    return `${baseUrl.replace(/\/$/, '')}/${target}`;
  }
  if (/^[A-Za-z0-9._-]+$/.test(target)) {
    return `${baseUrl.replace(/\/$/, '')}/c/${target}`;
  }
  throw new Error(`Error: invalid --chat target '${rawTarget}' (expected full URL or chat ID).`);
}

function resolveRepoRelativePath(repoRoot: string, cwd: string, inputPath: string): string {
  if (isAbsolute(inputPath)) {
    return inputPath;
  }
  const cwdPath = resolve(cwd, inputPath);
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  return resolve(repoRoot, inputPath);
}

function resolveOutputPath(cwd: string, inputPath: string): string {
  if (isAbsolute(inputPath)) {
    return inputPath;
  }
  return resolve(cwd, inputPath);
}

function parseBooleanLike(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function parseOptionalDuration(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return parseDurationToMs(String(value));
}

function parseOptionalPositiveDuration(value: string | undefined, label: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return parsePositiveDurationToMs(String(value), label);
}

function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = trimWhitespace(value ?? '');
  return trimmed ? trimmed : undefined;
}

function parseRepomixAttachmentFormat(value: string | undefined): 'none' | 'xml' | 'zip' {
  const normalized = normalizeToken(value ?? '');
  if (!normalized || normalized === 'none') {
    return 'none';
  }
  if (normalized === 'zip') {
    return 'zip';
  }
  if (normalized === 'xml') {
    return 'xml';
  }
  throw new Error(
    `Error: invalid repomix attachment format '${value ?? ''}' (expected 'zip', 'xml', or 'none').`,
  );
}

function parseManagedBrowserBackgroundMode(value: string | undefined): ManagedBrowserBackgroundMode {
  const normalized = normalizeToken(value ?? '');
  if (!normalized || normalized === 'balanced') {
    return 'balanced';
  }
  if (normalized === 'unthrottled') {
    return 'unthrottled';
  }
  throw new Error(
    `Error: invalid managed_browser_background_mode '${value ?? ''}' (expected 'balanced' or 'unthrottled').`,
  );
}

function parseManagedBrowserDisplayMode(value: string | undefined): ManagedBrowserDisplayMode {
  const normalized = normalizeToken(value ?? '');
  if (!normalized || normalized === 'headful') {
    return 'headful';
  }
  if (normalized === 'headless') {
    return 'headless';
  }
  throw new Error(
    `Error: invalid managed_browser_display_mode '${value ?? ''}' (expected 'headful' or 'headless').`,
  );
}

function parseManagedBrowserLaunchMode(value: string | undefined): ManagedBrowserLaunchMode {
  const normalized = normalizeToken(value ?? '');
  if (!normalized || normalized === 'foreground') {
    return 'foreground';
  }
  if (normalized === 'background') {
    return 'background';
  }
  throw new Error(
    `Error: invalid managed_browser_launch_mode '${value ?? ''}' (expected 'foreground' or 'background').`,
  );
}

function parseSnapshotAttachmentName(value: string | undefined): string {
  const parsed = parseOptionalString(value) ?? defaultSnapshotAttachmentName;
  if (
    parsed === '.' ||
    parsed === '..' ||
    parsed !== basename(parsed) ||
    parsed.includes('/') ||
    parsed.includes('\\')
  ) {
    throw new Error('Error: snapshot_attachment_name must be a filename, not a path.');
  }
  if (!parsed.toLowerCase().endsWith('.zip')) {
    throw new Error('Error: snapshot_attachment_name must end with .zip.');
  }
  return parsed;
}

function redactLocalPath(value: string): string {
  if (!value) {
    return value;
  }
  if (value === homeDir) {
    return '<HOME_DIR>';
  }
  if (value.startsWith(`${homeDir}/`)) {
    return `<HOME_DIR>${value.slice(homeDir.length)}`;
  }
  return value;
}

function redactForDisplay(value: string): string {
  return value.replaceAll(homeDir, '<HOME_DIR>');
}

function splitPresetTokens(values: string[]): string[] {
  const tokens: string[] = [];
  for (const value of values) {
    for (const token of value.split(',')) {
      const normalized = normalizeToken(token);
      if (normalized) {
        tokens.push(normalized);
      }
    }
  }
  return tokens;
}

function requireFile(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Error: required file not found: ${filePath}`);
  }
}

async function gitRepoRoot(cwd: string): Promise<string> {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('Error: not inside a git repository.');
  }
  return trimWhitespace(result.stdout);
}

function gitHeadCommit(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return undefined;
  }
  const sha = trimWhitespace(result.stdout);
  return /^[0-9a-f]{40}$/iu.test(sha) ? sha : undefined;
}

function loadCompatConfig(repoRoot: string, configPath: string): LoadedConfig {
  requireFile(configPath);
  requireFile(compatScriptPath);
  const result = spawnSync('bash', [compatScriptPath, repoRoot, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const message = trimWhitespace(result.stderr || result.stdout || 'Error: failed to load review-gpt config.');
    throw new Error(message);
  }
  try {
    return JSON.parse(result.stdout) as LoadedConfig;
  } catch (error) {
    throw new Error(`Error: failed to parse review-gpt config output (${String(error)}).`);
  }
}

function resolveLoadedConfig(repoRoot: string, loaded?: LoadedConfig): ResolvedConfig {
  const presetDirValue = loaded?.presetDir ? resolve(repoRoot, loaded.presetDir) : resolve(repoRoot, 'scripts/chatgpt-review-presets');
  const remotePort =
    parseOptionalString(loaded?.managedBrowserPort) ??
    parseOptionalString(loaded?.remotePort) ??
    '9222';
  const configuredUserDataDir =
    parseOptionalString(loaded?.managedBrowserUserDataDir) ??
    defaultManagedBrowserUserDataDir;
  const remoteUserDataDir = isAbsolute(configuredUserDataDir)
    ? configuredUserDataDir
    : resolve(repoRoot, configuredUserDataDir);
  const remoteProfile = parseOptionalString(loaded?.managedBrowserProfile) ?? 'Default';

  return {
    appConnector: parseOptionalString(loaded?.appConnector),
    attachArtifacts: parseBooleanLike(loaded?.attachArtifacts, true),
    browser: parseOptionalString(loaded?.browser) ?? 'chromium-family',
    browserChromePath:
      parseOptionalString(loaded?.browserBinaryPath) ??
      parseOptionalString(loaded?.browserPath) ??
      parseOptionalString(loaded?.browserChromePath) ??
      '',
    browserProfile: parseOptionalString(loaded?.browserProfile) ?? '',
    chatgptUrl: parseOptionalString(loaded?.chatgptUrl) ?? '',
    draftTimeoutMs: parseOptionalDuration(loaded?.draftTimeoutMs),
    includeDocs: parseBooleanLike(loaded?.includeDocs, true),
    includeTests: parseBooleanLike(loaded?.includeTests, false),
    idleDraftTimeoutMs: parseOptionalDuration(loaded?.idleDraftTimeoutMs) ?? DEFAULT_IDLE_DRAFT_TIMEOUT_MS,
    minimumMarkedResponseMs:
      parseOptionalPositiveDuration(loaded?.minimumMarkedResponseMs, 'minimum_marked_response_ms') ??
      DEFAULT_MINIMUM_MARKED_RESPONSE_MS,
    managedBrowserBackgroundMode: parseManagedBrowserBackgroundMode(loaded?.managedBrowserBackgroundMode),
    managedBrowserCloseAfterWait: parseBooleanLike(loaded?.managedBrowserCloseAfterWait, false),
    managedBrowserDisplayMode: parseManagedBrowserDisplayMode(loaded?.managedBrowserDisplayMode),
    managedBrowserLaunchMode: parseManagedBrowserLaunchMode(loaded?.managedBrowserLaunchMode),
    model: parseOptionalString(loaded?.model),
    namePrefix: parseOptionalString(loaded?.namePrefix) ?? 'cobuild-chatgpt-audit',
    outDir: parseOptionalString(loaded?.outDir) ?? '',
    packageScript:
      parseOptionalString(loaded?.packageScript)
        ? resolve(repoRoot, loaded!.packageScript)
        : resolveRepoToolsPackageScript(),
    presetAliases: new Map((loaded?.presetAliases ?? []).map((entry) => [entry.input, entry.target])),
    presetDir: presetDirValue,
    presetGroups: loaded?.presetGroups ?? [],
    presets: (loaded?.presets ?? []).map((entry) => ({
      description: entry.description,
      name: entry.name,
      path: isAbsolute(entry.path) ? entry.path : resolve(repoRoot, entry.path),
    })),
    repomixAttachmentFormat: parseRepomixAttachmentFormat(loaded?.repomixAttachmentFormat),
    repomixIgnorePatterns: (loaded?.repomixIgnorePatterns ?? []).map((entry) => trimWhitespace(entry)).filter(Boolean),
    remoteManaged: parseBooleanLike(loaded?.remoteManaged, true),
    remotePort,
    repoContextUrl: parseOptionalString(loaded?.repoContextUrl),
    remoteProfile,
    remoteUserDataDir,
    responseFile: parseOptionalString(loaded?.responseFile),
    responseTimeoutMs: parseOptionalDuration(loaded?.responseTimeoutMs),
    snapshotAttachmentName: parseSnapshotAttachmentName(loaded?.snapshotAttachmentName),
    thinking: parseOptionalString(loaded?.thinking),
  };
}

function resolveRepoToolsPackageScript(): string {
  try {
    return require.resolve('@cobuild/repo-tools/bin/cobuild-package-audit-context');
  } catch {
    throw new Error(
      'Error: missing @cobuild/repo-tools runtime dependency.\nReinstall @cobuild/review-gpt or add @cobuild/repo-tools so review-gpt can package repo context.',
    );
  }
}

function resolveRepomixCliPath(): string {
  try {
    const repomixMain = require.resolve('repomix');
    const repomixCli = resolve(dirname(repomixMain), '../bin/repomix.cjs');
    requireFile(repomixCli);
    return repomixCli;
  } catch {
    throw new Error(
      'Error: missing repomix runtime dependency.\nReinstall @cobuild/review-gpt or add repomix so review-gpt can generate repomix review artifacts.',
    );
  }
}

function ensureDefaultPresetGroup(config: ResolvedConfig): void {
  if (config.presets.length > 1 && !config.presetGroups.some((group) => group.name === 'all')) {
    config.presetGroups.push({
      description: 'Include all registered preset sections.',
      members: config.presets.map((preset) => preset.name),
      name: 'all',
    });
  }
}

function presetFile(config: ResolvedConfig, presetName: string): string {
  const preset = config.presets.find((entry) => entry.name === presetName);
  if (!preset) {
    throw new Error(`Error: no prompt file mapping for preset '${presetName}'.`);
  }
  return preset.path;
}

function printAvailablePresetNames(config: ResolvedConfig): string {
  const items = [
    ...config.presets.map((preset) => preset.name),
    ...config.presetGroups.map((group) => group.name),
  ].filter(Boolean);
  return items.join(' ');
}

function listPresets(config: ResolvedConfig): void {
  if (config.presets.length === 0 && config.presetGroups.length === 0) {
    console.log('Available presets: (none configured)');
    return;
  }

  console.log('Available presets:');
  for (const group of config.presetGroups) {
    console.log(`  ${group.name.padEnd(18)} - ${group.description}`);
  }
  for (const preset of config.presets) {
    console.log(`  ${preset.name.padEnd(18)} - ${preset.description}`);
  }
}

function resolveRegisteredPresetName(config: ResolvedConfig, token: string): string | undefined {
  if (config.presets.some((preset) => preset.name === token)) {
    return token;
  }
  return config.presetAliases.get(token);
}

function expandPresetTokens(config: ResolvedConfig, tokens: string[]): string[] {
  const selected: string[] = [];
  const addSelectedPreset = (presetName: string) => {
    if (!selected.includes(presetName)) {
      selected.push(presetName);
    }
  };

  for (const token of tokens) {
    const resolved = resolveRegisteredPresetName(config, token);
    if (resolved) {
      addSelectedPreset(resolved);
      continue;
    }

    const group = config.presetGroups.find((entry) => entry.name === token);
    if (group) {
      for (const member of group.members) {
        const resolvedMember = resolveRegisteredPresetName(config, normalizeToken(member));
        if (!resolvedMember) {
          throw new Error(`Error: preset group '${token}' references unknown preset '${member}'.`);
        }
        addSelectedPreset(resolvedMember);
      }
      continue;
    }

    let message = `Error: unknown preset '${token}'.\nRun --list-presets to see valid names.`;
    if (config.presets.length > 0 || config.presetGroups.length > 0) {
      message += `\nAvailable preset names: ${printAvailablePresetNames(config)}`;
    }
    throw new Error(message);
  }

  return selected;
}

function detectBrowserFamilyFromPath(browserPath: string): string {
  const normalized = browserPath.toLowerCase();
  if (normalized.includes('vivaldi')) return 'vivaldi';
  if (normalized.includes('brave')) return 'brave';
  if (normalized.includes('edge') || normalized.includes('msedge')) return 'edge';
  if (normalized.includes('chromium')) return 'chromium';
  return 'chrome';
}

function browserLocalStatePath(browserFamily: string): string {
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA ?? '';
  if (process.platform === 'win32') {
    switch (browserFamily) {
      case 'brave':
        return join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Local State');
      case 'edge':
        return join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Local State');
      case 'chromium':
        return join(localAppData, 'Chromium', 'User Data', 'Local State');
      case 'vivaldi':
        return join(localAppData, 'Vivaldi', 'User Data', 'Local State');
      default:
        return join(localAppData, 'Google', 'Chrome', 'User Data', 'Local State');
    }
  }

  switch (browserFamily) {
    case 'vivaldi':
      return process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Vivaldi', 'Local State')
        : join(home, '.config', 'vivaldi', 'Local State');
    case 'brave':
      return process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'Local State')
        : join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'Local State');
    case 'edge':
      return process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Local State')
        : join(home, '.config', 'microsoft-edge', 'Local State');
    case 'chromium':
      return process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Chromium', 'Local State')
        : join(home, '.config', 'chromium', 'Local State');
    default:
      return process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Local State')
        : join(home, '.config', 'google-chrome', 'Local State');
  }
}

function detectBrowserLastUsedProfile(browserFamily: string): string | undefined {
  const localStatePath = browserLocalStatePath(browserFamily);
  if (!existsSync(localStatePath)) {
    return undefined;
  }

  try {
    const localState = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
      profile?: {
        last_active_profiles?: string[];
        last_used?: string;
        profiles_order?: string[];
      };
    };
    return (
      localState.profile?.last_used ??
      localState.profile?.last_active_profiles?.[0] ??
      localState.profile?.profiles_order?.[0] ??
      'Default'
    );
  } catch {
    return 'Default';
  }
}

function findChromiumBrowserBinary(): string | undefined {
  const envCandidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_BINARY_PATH,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const home = homedir();
  const explicitCandidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
        '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
        '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
        join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        join(home, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(home, 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
        join(home, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
        join(home, 'Applications', 'Vivaldi.app', 'Contents', 'MacOS', 'Vivaldi'),
      ]
    : process.platform === 'win32'
      ? [
          join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env.PROGRAMFILES ?? '', 'Chromium', 'Application', 'chrome.exe'),
          join(process.env['PROGRAMFILES(X86)'] ?? '', 'Chromium', 'Application', 'chrome.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Chromium', 'Application', 'chrome.exe'),
          join(process.env.PROGRAMFILES ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          join(process.env['PROGRAMFILES(X86)'] ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Vivaldi', 'Application', 'vivaldi.exe'),
        ]
      : [];

  for (const candidate of explicitCandidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const commandCandidates = [
    'google-chrome',
    'google-chrome-stable',
    'chrome',
    'chromium',
    'chromium-browser',
    'brave-browser',
    'brave-browser-stable',
    'brave',
    'microsoft-edge',
    'microsoft-edge-stable',
    'vivaldi',
    'vivaldi-stable',
  ];
  for (const candidate of commandCandidates) {
    const result = spawnSync('bash', ['-lc', `command -v ${candidate}`], { encoding: 'utf8' });
    if (result.status === 0) {
      return trimWhitespace(result.stdout);
    }
  }

  return undefined;
}

async function isRemoteChromeReady(port: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function managedBrowserStateDir(port: string, userDataDir: string, profileDir: string): string {
  const identity = createHash('sha256')
    .update(`${port}\0${resolve(userDataDir)}\0${profileDir}`)
    .digest('hex')
    .slice(0, 20);
  return join(tmpdir(), 'review-gpt-managed-browser', identity);
}

function readLockOwner(lockPath: string): { pid: number; token: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as {
      pid?: unknown;
      token?: unknown;
    };
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') {
      return undefined;
    }
    return { pid: parsed.pid, token: parsed.token };
  } catch {
    return undefined;
  }
}

async function acquireManagedBrowserLifecycleLock(stateDir: string): Promise<() => void> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, 'lifecycle.lock');
  const recoveryPath = join(stateDir, 'lifecycle.recovery');

  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (!existsSync(recoveryPath)) {
      const token = randomUUID();
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(
          join(lockPath, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
        return () => {
          const owner = readLockOwner(lockPath);
          if (owner?.token !== token || owner.pid !== process.pid) {
            throw new Error('Managed browser lifecycle lock ownership changed unexpectedly.');
          }
          rmSync(lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }

      const observedOwner = readLockOwner(lockPath);
      if (observedOwner && !isProcessAlive(observedOwner.pid)) {
        try {
          mkdirSync(recoveryPath, { mode: 0o700 });
          writeFileSync(
            join(recoveryPath, 'owner.json'),
            `${JSON.stringify({ pid: process.pid, token })}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          const currentOwner = readLockOwner(lockPath);
          if (
            currentOwner?.pid === observedOwner.pid
            && currentOwner.token === observedOwner.token
            && !isProcessAlive(currentOwner.pid)
          ) {
            const stalePath = `${lockPath}.stale-${token}`;
            renameSync(lockPath, stalePath);
            rmSync(stalePath, { recursive: true, force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        } finally {
          const recoveryOwner = readLockOwner(recoveryPath);
          if (recoveryOwner?.pid === process.pid && recoveryOwner.token === token) {
            rmSync(recoveryPath, { recursive: true, force: true });
          }
        }
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }

  throw new Error('Timed out waiting for the managed browser lifecycle lock.');
}

async function withManagedBrowserLifecycleLock<T>(
  stateDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const releaseLock = await acquireManagedBrowserLifecycleLock(stateDir);
  try {
    return await action();
  } finally {
    releaseLock();
  }
}

function pruneManagedBrowserLeases(stateDir: string): string[] {
  const liveLeasePaths: string[] = [];
  for (const entry of readdirSync(stateDir)) {
    if (!entry.startsWith('lease-') || !entry.endsWith('.json')) {
      continue;
    }
    const leasePath = join(stateDir, entry);
    let pid = 0;
    try {
      const parsed = JSON.parse(readFileSync(leasePath, 'utf8')) as { pid?: unknown };
      pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    } catch {
      pid = 0;
    }
    if (isProcessAlive(pid)) {
      liveLeasePaths.push(leasePath);
    } else {
      unlinkSync(leasePath);
    }
  }
  return liveLeasePaths;
}

async function beginManagedBrowserUse(
  port: string,
  userDataDir: string,
  profileDir: string,
  ensureBrowser: () => Promise<void>,
): Promise<ManagedBrowserLease> {
  const stateDir = managedBrowserStateDir(port, userDataDir, profileDir);
  return withManagedBrowserLifecycleLock(stateDir, async () => {
    pruneManagedBrowserLeases(stateDir);
    const leasePath = join(stateDir, `lease-${randomUUID()}.json`);
    writeFileSync(
      leasePath,
      `${JSON.stringify({ pid: process.pid })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    try {
      await ensureBrowser();
      return { leasePath, stateDir };
    } catch (error) {
      rmSync(leasePath, { force: true });
      throw error;
    }
  });
}

async function finishManagedBrowserUse(
  lease: ManagedBrowserLease,
  port: string,
  closeWhenLast: boolean,
): Promise<ManagedBrowserFinishResult> {
  return withManagedBrowserLifecycleLock(lease.stateDir, async () => {
    rmSync(lease.leasePath, { force: true });
    const liveLeasePaths = pruneManagedBrowserLeases(lease.stateDir);
    if (!closeWhenLast) {
      return 'released';
    }
    if (liveLeasePaths.length > 0) {
      return 'active-runs';
    }
    return closeManagedBrowserIfIdle(port);
  });
}

export async function closeManagedBrowserIfIdle(
  port: string,
): Promise<'already-closed' | 'busy' | 'closed'> {
  const browserEndpoint = `http://127.0.0.1:${port}`;
  let versionResponse: Response;
  try {
    versionResponse = await fetch(`${browserEndpoint}/json/version`);
  } catch {
    return 'already-closed';
  }
  if (!versionResponse.ok) {
    return 'already-closed';
  }
  const version = await versionResponse.json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error('Managed browser did not expose a browser websocket URL.');
  }

  const browser = new CdpClient(version.webSocketDebuggerUrl);
  let closeError: unknown;
  try {
    let blockingPageTargetActive = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const targets = await browser.send<{
        targetInfos?: Array<{ type?: string; url?: string }>;
      }>('Target.getTargets');
      if (!Array.isArray(targets.targetInfos)) {
        throw new Error('Managed browser target list was not an array.');
      }
      blockingPageTargetActive = targets.targetInfos.some(
        (target) => target.type === 'page' && !isPassiveManagedBrowserPage(target.url),
      );
      if (!blockingPageTargetActive) {
        break;
      }
      if (attempt < 19) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    if (blockingPageTargetActive) {
      return 'busy';
    }
    await browser.send('Browser.close');
  } catch (error) {
    closeError = error;
  } finally {
    browser.close();
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await isRemoteChromeReady(port)) {
      return 'closed';
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  if (closeError) {
    throw closeError;
  }
  throw new Error(`Managed browser remained available on 127.0.0.1:${port} after Browser.close.`);
}

function isPassiveManagedBrowserPage(url: string | undefined): boolean {
  const normalized = trimWhitespace(url ?? '');
  if (!normalized || normalized === 'about:blank') {
    return true;
  }
  if (normalized === 'chrome://newtab/' || normalized === 'chrome://new-tab-page/') {
    return true;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.origin === 'https://chatgpt.com' && parsed.pathname === '/';
  } catch {
    return false;
  }
}

export function managedBrowserBackgroundArgs(mode: ManagedBrowserBackgroundMode): string[] {
  const args: string[] = [];
  if (mode === 'unthrottled') {
    args.push(
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    );
  }
  return args;
}

export function managedBrowserDisplayArgs(mode: ManagedBrowserDisplayMode): string[] {
  return mode === 'headless'
    ? ['--headless', '--window-size=1440,1000']
    : ['--new-window'];
}

export function managedBrowserLaunchArgs(
  displayMode: ManagedBrowserDisplayMode,
  launchMode: ManagedBrowserLaunchMode,
  startUrl: string,
): string[] {
  if (displayMode === 'headless') {
    return [...managedBrowserDisplayArgs(displayMode), startUrl];
  }
  if (launchMode === 'background') {
    return ['--no-startup-window'];
  }
  return [...managedBrowserDisplayArgs(displayMode), startUrl];
}

function macosAppBundlePath(executablePath: string): string | undefined {
  const markerIndex = executablePath.toLowerCase().indexOf('.app/');
  if (markerIndex < 0) {
    return undefined;
  }
  const appBundlePath = executablePath.slice(0, markerIndex + 4);
  return existsSync(appBundlePath) ? appBundlePath : undefined;
}

function startRemoteChrome(
  chromeBin: string,
  userDataDir: string,
  profileDir: string,
  port: string,
  logPath: string,
  startUrl: string,
  backgroundMode: ManagedBrowserBackgroundMode,
  displayMode: ManagedBrowserDisplayMode,
  launchMode: ManagedBrowserLaunchMode,
): void {
  mkdirSync(userDataDir, { recursive: true });
  const browserArgs = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    // Balanced mode keeps Chromium's normal background scheduling. The
    // capture session separately pins only its owned page lifecycle active;
    // unthrottled remains an explicit compatibility fallback.
    ...managedBrowserBackgroundArgs(backgroundMode),
    ...managedBrowserLaunchArgs(displayMode, launchMode, startUrl),
  ];
  const appBundlePath = process.platform === 'darwin'
    && displayMode === 'headful'
    && launchMode === 'background'
    ? macosAppBundlePath(chromeBin)
    : undefined;
  const child = spawn(
    appBundlePath ? '/usr/bin/open' : chromeBin,
    appBundlePath ? ['-g', '-n', '-a', appBundlePath, '--args', ...browserArgs] : browserArgs,
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  child.unref();
  if (logPath) {
    void logPath;
  }
}

async function initializeBackgroundManagedBrowser(port: string, startUrl: string): Promise<void> {
  const browserEndpoint = `http://127.0.0.1:${port}`;
  const versionResponse = await fetch(`${browserEndpoint}/json/version`);
  if (!versionResponse.ok) {
    throw new Error('Managed browser did not expose its browser endpoint during background startup.');
  }
  const version = await versionResponse.json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error('Managed browser did not expose a browser websocket URL during background startup.');
  }

  let homeUrl = startUrl;
  try {
    homeUrl = `${new URL(startUrl).origin}/`;
  } catch {
    // Keep the configured URL when it is not a standard absolute URL.
  }

  const browser = new CdpClient(version.webSocketDebuggerUrl);
  try {
    const created = await browser.send<{ targetId?: string }>('Target.createTarget', {
      background: true,
      url: homeUrl,
    });
    const keeperTargetId = trimWhitespace(created.targetId ?? '');
    if (!keeperTargetId) {
      throw new Error('Managed browser did not create its background home target.');
    }

    let cleanChecks = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const targets = await browser.send<{
        targetInfos?: Array<{ targetId?: string; type?: string }>;
      }>('Target.getTargets');
      if (!Array.isArray(targets.targetInfos)) {
        throw new Error('Managed browser target list was not an array during background startup.');
      }
      const extraPageTargetIds = targets.targetInfos
        .filter((target) => target.type === 'page' && target.targetId !== keeperTargetId)
        .map((target) => trimWhitespace(target.targetId ?? ''))
        .filter(Boolean);
      for (const targetId of extraPageTargetIds) {
        try {
          await browser.send('Target.closeTarget', { targetId });
        } catch {
          // A restoring tab can disappear between listing and closing it.
        }
      }
      cleanChecks = extraPageTargetIds.length === 0 ? cleanChecks + 1 : 0;
      if (cleanChecks >= 2) {
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error('Managed browser kept restoring extra tabs during background startup.');
  } finally {
    browser.close();
  }
}

async function ensureRemoteChrome(
  chromeBin: string,
  userDataDir: string,
  profileDir: string,
  port: string,
  logPath: string,
  startUrl: string,
  backgroundMode: ManagedBrowserBackgroundMode,
  displayMode: ManagedBrowserDisplayMode,
  launchMode: ManagedBrowserLaunchMode,
): Promise<void> {
  if (await isRemoteChromeReady(port)) {
    return;
  }

  const profileLock = describeProfileLock(userDataDir);
  if (profileLock) {
    throw new Error(
      `Error: managed browser debugging is unavailable on 127.0.0.1:${port}, and the profile is already open.${profileLock}`,
    );
  }

  console.log(`Starting managed browser on port ${port}...`);
  startRemoteChrome(
    chromeBin,
    userDataDir,
    profileDir,
    port,
    logPath,
    startUrl,
    backgroundMode,
    displayMode,
    launchMode,
  );

  for (let index = 0; index < 50; index += 1) {
    if (await isRemoteChromeReady(port)) {
      if (displayMode === 'headful' && launchMode === 'background') {
        await initializeBackgroundManagedBrowser(port, startUrl);
      }
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }

  throw new Error(
    `Error: managed browser failed to start on 127.0.0.1:${port}.${describeProfileLock(userDataDir)}\nCheck log: ${logPath}`,
  );
}

function describeProfileLock(userDataDir: string): string {
  // Chrome/Brave mark a held profile with a SingletonLock symlink (host-pid).
  // The usual cause is a GUI launch of the same profile without CDP, which
  // makes the managed start fail until that instance quits.
  try {
    const lockPath = join(userDataDir, 'SingletonLock');
    const lockTarget = readlinkSync(lockPath);
    return `\nProfile lock held: ${lockPath} -> ${lockTarget}. Another browser instance (likely a GUI launch without remote debugging) has this profile open; quit that instance and rerun.`;
  } catch {
    return '';
  }
}

function openChromeWindow(
  chromeBin: string,
  url: string,
  profileDir: string,
  userDataDir?: string,
): void {
  const args: string[] = [];
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  if (profileDir) {
    args.push(`--profile-directory=${profileDir}`);
  }
  args.push('--new-window', url);
  const child = spawn(chromeBin, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function prepareChatgptDraft(
  port: string,
  url: string,
  mode: string,
  modelTarget: string,
  thinkingLevel: string,
  appConnectorTarget: string,
  timeoutMs: string,
  promptText: string,
  shouldSend: boolean,
  shouldWaitForResponse: boolean,
  responseTimeoutMs: string,
  responseFile: string,
  responseMarker: string,
  minimumMarkedResponseMs: string,
  filePaths: string[],
  cleanupFilePaths: string[],
  idleDraftTimeoutMs: string,
): DraftPreparationResult {
  requireFile(draftDriverPath);
  // The driver's own output is buffered until it exits, so announce a live
  // stage log first. A run that appears frozen can then be diagnosed with
  // `tail -f` instead of guessing which stage stalled.
  const stageLogPath = join(
    mkdtempSync(join(tmpdir(), 'review-gpt-stage-')),
    'stage.log',
  );
  const captureMetadataPath = responseFile
    ? `${responseFile}.capture.json`
    : join(dirname(stageLogPath), 'capture.json');
  console.log(`Draft stage log: ${stageLogPath}`);
  const result = spawnSync(process.execPath, [draftDriverPath], {
    env: {
      ...process.env,
      REVIEW_GPT_DRAFT_STAGE_LOG: stageLogPath,
      ORACLE_DRAFT_FILES: filePaths.join('\n'),
      ORACLE_DRAFT_MODE: mode,
      ORACLE_DRAFT_MODEL: modelTarget,
      ORACLE_DRAFT_APP_CONNECTOR: appConnectorTarget,
      ORACLE_DRAFT_PROMPT: promptText,
      ORACLE_DRAFT_REMOTE_PORT: port,
      ORACLE_DRAFT_RESPONSE_FILE: responseFile,
      ORACLE_DRAFT_RESPONSE_MARKER: responseMarker,
      ORACLE_DRAFT_MINIMUM_MARKED_RESPONSE_MS: minimumMarkedResponseMs,
      ORACLE_DRAFT_RESPONSE_TIMEOUT_MS: responseTimeoutMs,
      ORACLE_DRAFT_SEND: shouldSend ? '1' : '0',
      ORACLE_DRAFT_THINKING: thinkingLevel,
      ORACLE_DRAFT_TIMEOUT_MS: timeoutMs,
      ORACLE_DRAFT_URL: url,
      ORACLE_DRAFT_WAIT_RESPONSE: shouldWaitForResponse ? '1' : '0',
      REVIEW_GPT_DRAFT_CLEANUP_FILES: cleanupFilePaths.join('\n'),
      REVIEW_GPT_DRAFT_CAPTURE_METADATA_FILE: captureMetadataPath,
      REVIEW_GPT_IDLE_DRAFT_TIMEOUT_MS: idleDraftTimeoutMs,
    },
    encoding: 'utf8',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    const tempLogDir = mkdtempSync(join(tmpdir(), 'review-gpt-driver-log-'));
    const driverLogPath = join(tempLogDir, 'driver.log');
    writeFileSync(
      driverLogPath,
      `${result.stdout ?? ''}${result.stderr ?? ''}`,
      'utf8',
    );
    throw new DraftPreparationError('Error: failed to stage the ChatGPT draft in the managed browser.', {
      conversationUrl: extractConversationUrlFromDriverOutput(result.stdout),
      captureMetadataPath:
        result.stdout?.includes('ReviewGPT exact target and committed-turn identity persisted for wake recovery.') &&
        existsSync(captureMetadataPath)
          ? captureMetadataPath
          : undefined,
      driverLogPath,
      status: result.status,
    });
  }

  return {
    captureMetadataPath: existsSync(captureMetadataPath) ? captureMetadataPath : undefined,
    conversationId: extractConversationIdFromDriverOutput(result.stdout),
    conversationUrl: extractConversationUrlFromDriverOutput(result.stdout),
  };
}

const SENSITIVE_ARTIFACT_EXAMPLE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

const SENSITIVE_ARTIFACT_DIRECTORY_NAMES = new Set(['.aws', '.gnupg', '.ssh']);

const SENSITIVE_ARTIFACT_FILE_NAMES = new Set([
  '.dockercfg',
  '.envrc',
  '.htpasswd',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  'authorized_keys',
  'docker-config.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
]);

const SENSITIVE_ARTIFACT_EXTENSIONS = new Set([
  'asc',
  'gpg',
  'jks',
  'kdb',
  'key',
  'keystore',
  'kubeconfig',
  'ovpn',
  'p12',
  'p8',
  'pem',
  'pfx',
  'pkcs12',
  'ppk',
]);

function normalizeArtifactPath(rawPath: string): string {
  return rawPath.replace(/\\/gu, '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
}

/**
 * Review context leaves the machine, so credential-shaped files must never reach
 * an attachment. This runs on the packaged ZIP itself rather than trusting the
 * repo-supplied package script to have filtered them.
 */
export function sensitiveArtifactReason(rawPath: string): string | undefined {
  const normalizedPath = normalizeArtifactPath(rawPath);
  if (!normalizedPath) {
    return undefined;
  }

  const segments = normalizedPath.split('/');
  const fileName = (segments.at(-1) ?? '').toLowerCase();
  if (segments.slice(0, -1).some((segment) => SENSITIVE_ARTIFACT_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
    return 'credential directory';
  }

  const isExampleName = SENSITIVE_ARTIFACT_EXAMPLE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
  if (/^\.env(?:\..+)?$/u.test(fileName) && !isExampleName) {
    return 'dotenv file';
  }

  if (SENSITIVE_ARTIFACT_FILE_NAMES.has(fileName)) {
    return 'credential file';
  }

  const extension = fileName.includes('.') ? (fileName.split('.').at(-1) ?? '') : '';
  if (SENSITIVE_ARTIFACT_EXTENSIONS.has(extension) && !isExampleName) {
    return `private key or certificate (.${extension})`;
  }

  return undefined;
}

export function findSensitiveArtifactPaths(paths: string[]): { path: string; reason: string }[] {
  const findings: { path: string; reason: string }[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of paths) {
    const normalizedPath = normalizeArtifactPath(rawPath);
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    const reason = sensitiveArtifactReason(normalizedPath);
    if (!reason) {
      continue;
    }
    seenPaths.add(normalizedPath);
    findings.push({ path: normalizedPath, reason });
  }
  return findings;
}

export function formatSensitiveArtifactFailure(
  zipPath: string,
  findings: { path: string; reason: string }[],
): string {
  const shown = findings.slice(0, 10).map((finding) => `- ${finding.path} (${finding.reason})`);
  if (findings.length > shown.length) {
    shown.push(`- ...and ${findings.length - shown.length} more`);
  }
  return [
    `Error: refusing to attach ${basename(zipPath)}; it contains ${findings.length} credential-shaped file(s):`,
    ...shown,
    '',
    'Review context is uploaded to ChatGPT. Exclude these from the package script (or gitignore them),',
    'then rerun. Set REVIEW_GPT_ALLOW_SENSITIVE_ARTIFACTS=1 to override when the match is a false positive.',
  ].join('\n');
}

function listAllZipEntries(zipPath: string): string[] {
  const result = spawnSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(trimWhitespace(result.stderr || result.stdout || 'Error: failed to list audit ZIP contents.'));
  }
  return result.stdout
    .split(/\r?\n/gu)
    .map((entry) => trimWhitespace(entry))
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'));
}

function assertPackagedZipHasNoSensitivePaths(zipPath: string): void {
  const findings = findSensitiveArtifactPaths(listAllZipEntries(zipPath));
  if (findings.length === 0) {
    return;
  }
  const overrideToken = normalizeToken(process.env.REVIEW_GPT_ALLOW_SENSITIVE_ARTIFACTS ?? '');
  if (overrideToken === '1' || overrideToken === 'true' || overrideToken === 'yes' || overrideToken === 'on') {
    console.warn(
      `Warning: attaching ${findings.length} credential-shaped file(s) because REVIEW_GPT_ALLOW_SENSITIVE_ARTIFACTS=1.`,
    );
    return;
  }
  throw new Error(formatSensitiveArtifactFailure(zipPath, findings));
}

function runPackageScript(
  packageScript: string,
  namePrefix: string,
  outDir: string,
  includeTests: boolean,
  includeDocs: boolean,
): string {
  requireFile(packageScript);
  const args = [packageScript, '--zip', '--name', namePrefix];
  if (outDir) {
    args.push('--out-dir', outDir);
  }
  if (includeTests) {
    args.push('--with-tests');
  }
  if (!includeDocs) {
    args.push('--no-docs');
  }
  const result = spawnSync('bash', args, {
    encoding: 'utf8',
    env: {
      // Default the repo-tools packager's credential filter on. Repos that
      // deliberately package such files can still set this to 0 themselves.
      COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE: '1',
      ...process.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(trimWhitespace(result.stderr || result.stdout || 'Error: package script failed.'));
  }
  return result.stdout;
}

function resolveZipPath(packageOutput: string): string {
  const match = Array.from(packageOutput.matchAll(/^ZIP: (.*) \(.*\)$/gm)).at(-1);
  const zipPath = trimWhitespace(match?.[1] ?? '');
  if (!zipPath || !existsSync(zipPath)) {
    throw new Error('Error: could not locate generated ZIP path from packaging output.');
  }
  return zipPath;
}

function ensureArtifactAlias(sourcePath: string, targetPath: string): string {
  if (resolve(sourcePath) === resolve(targetPath)) {
    return sourcePath;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  rmSync(targetPath, { force: true });
  renameSync(sourcePath, targetPath);
  return targetPath;
}

function toRepoRelativeIgnorePattern(repoRoot: string, filePath: string): string | undefined {
  const relativePath = relative(repoRoot, filePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.replace(/\\/gu, '/');
}

function buildRepomixIgnorePaths(repoRoot: string, configuredPatterns: string[], generatedPaths: string[]): string[] {
  return Array.from(
    new Set([
      ...configuredPatterns.map((entry) => trimWhitespace(entry)).filter(Boolean),
      ...generatedPaths
        .map((filePath) => toRepoRelativeIgnorePattern(repoRoot, filePath))
        .filter((value): value is string => Boolean(value)),
    ]),
  );
}

function listZipManifestPaths(repoRoot: string, zipPath: string): string[] {
  const result = spawnSync('unzip', ['-Z1', zipPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(trimWhitespace(result.stderr || result.stdout || 'Error: failed to list audit ZIP contents.'));
  }

  const manifestPaths = result.stdout
    .split(/\r?\n/gu)
    .map((entry) => trimWhitespace(entry))
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'))
    .filter((entry) => !isAbsolute(entry) && !entry.startsWith('../') && !entry.includes('/../'))
    .filter((entry) => existsSync(resolve(repoRoot, entry)));

  if (manifestPaths.length === 0) {
    throw new Error('Error: audit ZIP did not contain any usable repo-relative files for repomix.');
  }

  return manifestPaths;
}

function runRepomix(repoRoot: string, outputPath: string, ignorePaths: string[], manifestPaths: string[]): void {
  const repomixCli = resolveRepomixCliPath();
  mkdirSync(dirname(outputPath), { recursive: true });
  const args = [
    repomixCli,
    '--quiet',
    '--style',
    'xml',
    '--output',
    outputPath,
    '--stdin',
    '--no-gitignore',
    '--no-dot-ignore',
  ];
  if (ignorePaths.length > 0) {
    args.push('--ignore', ignorePaths.join(','));
  }
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input: `${manifestPaths.join('\n')}\n`,
  });
  if (result.status !== 0) {
    throw new Error(trimWhitespace(result.stderr || result.stdout || 'Error: repomix packaging failed.'));
  }
}

function buildRepomixAttachment(sourceXmlPath: string, format: 'xml' | 'zip'): string {
  if (format === 'xml') {
    return sourceXmlPath;
  }

  const zipPath = join(dirname(sourceXmlPath), 'repo.repomix.zip');
  rmSync(zipPath, { force: true });
  const result = spawnSync('zip', ['-q', '-j', zipPath, sourceXmlPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      trimWhitespace(result.stderr || result.stdout || 'Error: failed to compress repomix attachment.'),
    );
  }
  return zipPath;
}

function buildArtifactInstructionText(_baseCommit?: string): string {
  return '';
}

function buildRepoContextInstructionText(repoContextUrl: string | undefined, baseCommit: string | undefined, attachArtifacts: boolean): string {
  const normalizedUrl = parseOptionalString(repoContextUrl);
  if (!normalizedUrl) {
    return '';
  }

  const lines = [
    'Repository context:',
    `- Use the selected ChatGPT app connector for this repository: ${normalizedUrl}`,
  ];
  if (baseCommit) {
    lines.push(`- Local HEAD at request time: ${baseCommit}`);
  }
  if (!attachArtifacts) {
    lines.push('- No repo ZIP or repomix attachment is provided for this run.');
  }
  return lines.join('\n');
}

function buildDraftPromptText(
  selectedPresets: string[],
  config: ResolvedConfig,
  extraPromptFiles: string[],
  promptChunks: string[],
  repoContextInstructionText?: string,
  artifactInstructionText?: string,
): string {
  const parts: string[] = [];
  for (const preset of selectedPresets) {
    const presetPath = presetFile(config, preset);
    requireFile(presetPath);
    parts.push(readFileSync(presetPath, 'utf8').trimEnd());
  }
  for (const filePath of extraPromptFiles) {
    requireFile(filePath);
    parts.push(readFileSync(filePath, 'utf8').trimEnd());
  }
  for (const chunk of promptChunks) {
    if (chunk) {
      parts.push(chunk);
    }
  }
  if (repoContextInstructionText) {
    parts.push(repoContextInstructionText);
  }
  if (artifactInstructionText) {
    parts.push(artifactInstructionText);
  }
  return parts.filter(Boolean).join('\n\n');
}

function printStagingPlan(plan: StagingPlan): void {
  if (plan.selectedPresets.length > 0) {
    console.log(`Prompt presets: ${plan.selectedPresets.join(' ')}`);
  } else {
    console.log('Prompt presets: (none)');
  }
  if (plan.promptChunks.length > 0) {
    console.log(`Custom prompt chunks: ${plan.promptChunks.length}`);
  }
  if (plan.draftPromptText) {
    console.log(`Prompt staging: inline composer prefill (${plan.draftPromptText.length} chars)`);
  } else {
    console.log('Prompt staging: none');
  }
  if (plan.repomixPath) {
    console.log(`Repomix attachment: ${redactLocalPath(plan.repomixPath)}`);
  } else {
    console.log('Repomix attachment: disabled');
  }
  console.log(`ZIP file: ${plan.zipPath ? redactLocalPath(plan.zipPath) : 'disabled'}`);
  console.log(`BASE_COMMIT: ${plan.baseCommit ?? '(unavailable)'}`);
  if (plan.repoContextUrl) {
    console.log(`Repository context URL: ${plan.repoContextUrl}`);
  }
  console.log(`ChatGPT URL: ${plan.chatgptUrl}`);
  console.log(`ChatGPT mode: ${plan.draftMode}`);
  console.log(`Draft model target: ${isCurrentTarget(plan.effectiveModel) ? 'current' : plan.effectiveModel}`);
  console.log(`Draft thinking target: ${isCurrentTarget(plan.effectiveThinking) ? 'current' : plan.effectiveThinking}`);
  console.log(`App connector target: ${isCurrentTarget(plan.effectiveAppConnector) ? 'current' : plan.effectiveAppConnector}`);
  console.log(`Draft send: ${plan.autoSend ? 'enabled (auto-submit)' : 'disabled'}`);
  if (plan.waitResponse) {
    console.log(`Response capture: enabled (${plan.responseTimeoutMs}ms timeout)`);
    if (plan.responseMarker) {
      console.log(`Response completion marker: "${plan.responseMarker}" (responses without it are not treated as final)`);
      if (!isCurrentTarget(plan.effectiveModel)) {
        console.log(`Minimum marked response time: ${plan.minimumMarkedResponseMs}ms`);
      }
    }
    console.log('Wait behavior: block until the assistant finishes or the wait timeout is hit.');
    if (plan.draftMode === 'deep-research') {
      console.log('Deep Research wait: long-running runs stay attached until completion or timeout, even when the UI is quiet.');
    }
  } else {
    console.log('Response capture: disabled');
  }
  console.log(`Draft timeout: ${plan.draftTimeoutMs}ms`);
  console.log(
    plan.idleDraftTimeoutMs === '0'
      ? 'Idle draft cleanup: disabled'
      : `Idle draft cleanup: close hidden, inactive unsent drafts after ${plan.idleDraftTimeoutMs}ms`,
  );
  if (plan.resolvedResponseFile) {
    console.log(`Response file: ${redactLocalPath(plan.resolvedResponseFile)}`);
  }
  console.log(`Browser target: chromium-family`);
  console.log(`Browser family: ${plan.resolvedBrowserFamily}`);
  console.log('Managed browser mode: enabled');
  console.log(`Managed browser endpoint: 127.0.0.1:${plan.remotePort}`);
  console.log(`Managed browser data dir: ${redactLocalPath(plan.remoteUserDataDir)}`);
  console.log(`Managed browser profile: ${plan.remoteProfile}`);
  console.log(`Managed browser background mode: ${plan.managedBrowserBackgroundMode}`);
  console.log(`Managed browser display mode: ${plan.managedBrowserDisplayMode}`);
  console.log(`Managed browser launch mode: ${plan.managedBrowserLaunchMode}`);
  console.log(
    `Managed browser close after wait: ${plan.managedBrowserCloseAfterWait ? 'enabled' : 'disabled'}`,
  );
  console.log(`Managed browser state: ${plan.managedProfileState}`);
  console.log(`Browser binary: ${redactLocalPath(plan.resolvedBrowserChromePath)}`);
  if (plan.detectedBrowserProfile) {
    console.log(`Detected local browser profile: ${plan.detectedBrowserProfile}`);
  }
}

export async function runReviewGpt(options: CliOptions, context: RunContext): Promise<ReviewGptRunResult> {
  const repoRoot = await gitRepoRoot(context.cwd);

  const configPath = options.config
    ? isAbsolute(options.config)
      ? options.config
      : resolve(context.cwd, options.config)
    : undefined;
  const loadedConfig = configPath ? loadCompatConfig(repoRoot, configPath) : undefined;
  const resolvedConfig = resolveLoadedConfig(repoRoot, loadedConfig);
  ensureDefaultPresetGroup(resolvedConfig);

  if (options.listPresets) {
    listPresets(resolvedConfig);
    return {
      artifactsAttached: false,
      autoSend: false,
      browserEndpoint: `http://127.0.0.1:${resolvedConfig.remotePort}`,
      chatUrl: resolvedConfig.chatgptUrl || 'https://chatgpt.com',
      deepResearch: false,
      draftMode: 'chat',
      dryRun: true,
      selectedPresets: [],
      waitResponse: false,
    };
  }

  const promptFileInputs = options.promptFile ?? [];
  const extraPromptFiles = promptFileInputs.map((token) => {
    const resolvedPath = resolveRepoRelativePath(repoRoot, context.cwd, token);
    requireFile(resolvedPath);
    return resolvedPath;
  });

  const presetTokens = splitPresetTokens(options.preset ?? []);
  const selectedPresets = presetTokens.length > 0 ? expandPresetTokens(resolvedConfig, presetTokens) : [];
  if ((options.preset ?? []).length > 0 && selectedPresets.length === 0) {
    throw new Error('Error: no presets selected after parsing --preset input.');
  }

  let chatgptUrl = resolvedConfig.chatgptUrl || 'https://chatgpt.com';
  const chatTarget =
    options.chat ??
    options.chatUrl ??
    options.chatId;
  const deepResearch = options.deepResearch === true;
  if (deepResearch && !chatTarget) {
    chatgptUrl = 'https://chatgpt.com/deep-research';
  } else if (chatTarget) {
    chatgptUrl = resolveChatTargetUrl(chatTarget, extractUrlOrigin(chatgptUrl));
  }

  let effectiveModel = options.model ?? resolvedConfig.model ?? 'gpt-5.6-sol';
  let effectiveThinking = options.thinking ?? resolvedConfig.thinking ?? 'current';
  let effectiveAppConnector = options.appConnector ?? options.connector ?? resolvedConfig.appConnector ?? 'current';
  const draftMode: 'chat' | 'deep-research' = deepResearch ? 'deep-research' : 'chat';

  if (deepResearch) {
    if (options.model !== undefined && !isCurrentTarget(options.model)) {
      console.error('Warning: --model is ignored in --deep-research mode; the dedicated page controls the mode.');
    }
    if (options.thinking !== undefined && !isCurrentTarget(options.thinking)) {
      console.error('Warning: --thinking is ignored in --deep-research mode.');
    }
    if ((options.appConnector !== undefined || options.connector !== undefined) && !isCurrentTarget(effectiveAppConnector)) {
      console.error('Warning: --app-connector/--connector is ignored in --deep-research mode.');
    }
    effectiveModel = 'current';
    effectiveThinking = 'current';
    effectiveAppConnector = 'current';
  }

  const normalizedThinkingTarget = String(effectiveThinking).trim().toLowerCase();
  if (normalizedThinkingTarget === 'xhigh' || normalizedThinkingTarget === 'extended') {
    throw new Error(
      `Error: thinking target "${effectiveThinking}" is unsupported. It is not a ChatGPT model or an available independent control; use --thinking current with the Pro model.`,
    );
  }

  const autoSend = options.submit === true || options.send === true || options.wait === true;
  const waitResponse = options.wait === true;
  if (waitResponse && !autoSend) {
    throw new Error('Error: --wait requires auto-send; add --send or remove --wait.');
  }

  let draftTimeoutMs =
    options.timeout
      ? parseDurationToMs(options.timeout)
      : resolvedConfig.draftTimeoutMs;
  if (!draftTimeoutMs) {
    if (waitResponse && deepResearch) {
      draftTimeoutMs = '2400000';
    } else if (waitResponse) {
      draftTimeoutMs = '600000';
    } else {
      draftTimeoutMs = '90000';
    }
  }

  let responseTimeoutMs =
    options.waitTimeout
      ? parseDurationToMs(options.waitTimeout)
      : resolvedConfig.responseTimeoutMs;
  if (!responseTimeoutMs) {
    responseTimeoutMs = waitResponse ? DEFAULT_WAIT_RESPONSE_TIMEOUT_MS : draftTimeoutMs;
  }

  const idleDraftTimeoutMs = options.idleDraftTimeout !== undefined
    ? parseDurationToMs(options.idleDraftTimeout)
    : resolvedConfig.idleDraftTimeoutMs;

  const minimumMarkedResponseMs = options.minimumMarkedResponseTime !== undefined
    ? parsePositiveDurationToMs(options.minimumMarkedResponseTime, '--minimum-marked-response-time')
    : resolvedConfig.minimumMarkedResponseMs;

  const responseFile =
    options.responseFile ??
    resolvedConfig.responseFile;
  const resolvedResponseFile = responseFile ? resolveOutputPath(context.cwd, responseFile) : undefined;
  const responseMarker = trimWhitespace(options.responseMarker ?? '') || undefined;

  const attachArtifacts = options.artifacts === false || options.noArtifacts === true || options.zip === false
    ? false
    : options.artifacts === true || options.zip === true
      ? true
      : resolvedConfig.attachArtifacts;
  const attachmentPaths: string[] = [];
  const cleanupFilePaths: string[] = [];
  const baseCommit = gitHeadCommit(repoRoot);
  let repomixPath: string | undefined;
  let zipPath = '';
  const includeTests = options.tests === true || options.withTests === true
    ? true
    : options.tests === false || options.noTests === true || options.withTests === false
      ? false
      : resolvedConfig.includeTests;
  if (attachArtifacts) {
    const packageOutput = runPackageScript(
      resolvedConfig.packageScript,
      resolvedConfig.namePrefix,
      resolvedConfig.outDir,
      includeTests,
      resolvedConfig.includeDocs,
    );
    const generatedZipPath = resolveZipPath(packageOutput);
    assertPackagedZipHasNoSensitivePaths(generatedZipPath);
    const artifactDir = dirname(generatedZipPath);
    const attachmentDir = options.dryRun
      ? artifactDir
      : mkdtempSync(join(tmpdir(), 'review-gpt-attachments-'));
    zipPath = ensureArtifactAlias(generatedZipPath, join(attachmentDir, resolvedConfig.snapshotAttachmentName));
    cleanupFilePaths.push(zipPath);
    const displayPackageOutput = packageOutput.replaceAll(generatedZipPath, zipPath);
    process.stdout.write(redactForDisplay(displayPackageOutput));
    if (!displayPackageOutput.endsWith('\n')) {
      process.stdout.write('\n');
    }
    if (resolvedConfig.repomixAttachmentFormat !== 'none') {
      const repomixSourcePath = join(attachmentDir, 'repo.repomix.xml');
      const ignorePaths = buildRepomixIgnorePaths(repoRoot, resolvedConfig.repomixIgnorePatterns, [
        generatedZipPath,
        zipPath,
        repomixSourcePath,
      ]);
      const manifestPaths = listZipManifestPaths(repoRoot, zipPath);
      runRepomix(repoRoot, repomixSourcePath, ignorePaths, manifestPaths);
      repomixPath = buildRepomixAttachment(repomixSourcePath, resolvedConfig.repomixAttachmentFormat);
      cleanupFilePaths.push(repomixSourcePath, repomixPath);
      attachmentPaths.push(repomixPath);
    }
    attachmentPaths.push(zipPath);
  }

  const promptChunks = options.prompt ?? [];
  const artifactInstructionText = attachArtifacts ? buildArtifactInstructionText(baseCommit) : '';
  const repoContextInstructionText = buildRepoContextInstructionText(
    resolvedConfig.repoContextUrl,
    baseCommit,
    attachArtifacts,
  );
  const draftPromptText = buildDraftPromptText(
    selectedPresets,
    resolvedConfig,
    extraPromptFiles,
    promptChunks,
    repoContextInstructionText,
    artifactInstructionText,
  );

  let resolvedBrowserChromePath = options.browserPath ?? resolvedConfig.browserChromePath;
  if (options.browserBinary && options.browserPath) {
    resolvedBrowserChromePath = options.browserPath;
  }
  if (resolvedBrowserChromePath) {
    resolvedBrowserChromePath = isAbsolute(resolvedBrowserChromePath)
      ? resolvedBrowserChromePath
      : resolve(repoRoot, resolvedBrowserChromePath);
    if (!existsSync(resolvedBrowserChromePath)) {
      throw new Error(`Error: configured browser path is not executable: ${resolvedBrowserChromePath}`);
    }
  } else {
    resolvedBrowserChromePath = findChromiumBrowserBinary() ?? '';
    if (!resolvedBrowserChromePath) {
      throw new Error(
        'Error: no Chromium-compatible browser executable was found.\nSet browser_binary_path (preferred) or browser_chrome_path in your config to Chrome, Brave, Chromium, or Edge.',
      );
    }
  }

  const resolvedBrowserFamily = detectBrowserFamilyFromPath(resolvedBrowserChromePath);
  const detectedBrowserProfile =
    resolvedConfig.browserProfile || detectBrowserLastUsedProfile(resolvedBrowserFamily);
  let remoteUserDataDir = resolvedConfig.remoteUserDataDir;
  if (
    remoteUserDataDir === defaultManagedBrowserUserDataDir &&
    !existsSync(remoteUserDataDir) &&
    existsSync(legacyManagedBrowserUserDataDir)
  ) {
    remoteUserDataDir = legacyManagedBrowserUserDataDir;
  }
  const remoteProfile = resolvedConfig.remoteProfile;
  const managedBrowserDisplayMode = options.headless === undefined
    ? resolvedConfig.managedBrowserDisplayMode
    : options.headless
      ? 'headless'
      : 'headful';
  const managedProfileState = existsSync(join(remoteUserDataDir, remoteProfile))
    ? 'existing profile'
    : 'new profile';

  const stagingPlan: StagingPlan = {
    attachArtifacts,
    autoSend,
    baseCommit,
    chatgptUrl,
    deepResearch,
    detectedBrowserProfile,
    draftMode,
    draftPromptText,
    draftTimeoutMs,
    effectiveAppConnector,
    effectiveModel,
    effectiveThinking,
    extraPromptFiles,
    idleDraftTimeoutMs,
    minimumMarkedResponseMs,
    managedBrowserBackgroundMode: resolvedConfig.managedBrowserBackgroundMode,
    managedBrowserCloseAfterWait: resolvedConfig.managedBrowserCloseAfterWait,
    managedBrowserDisplayMode,
    managedBrowserLaunchMode: resolvedConfig.managedBrowserLaunchMode,
    managedProfileState,
    promptChunks,
    repoContextUrl: resolvedConfig.repoContextUrl,
    remotePort: resolvedConfig.remotePort,
    remoteProfile,
    remoteUserDataDir,
    resolvedBrowserChromePath,
    resolvedBrowserFamily,
    resolvedResponseFile,
    repomixPath,
    responseMarker,
    responseTimeoutMs,
    selectedPresets,
    waitResponse,
    zipPath,
  };

  printStagingPlan(stagingPlan);

  if (options.dryRun) {
    console.log('Dry run: browser launch skipped');
    return buildRunResult(stagingPlan, {
      dryRun: true,
    });
  }

  let draftResult: DraftPreparationResult = {};
  if (resolvedConfig.remoteManaged) {
    const remoteLog = join(tmpdir(), 'review-gpt-managed-browser.log');
    const managedBrowserLease = await beginManagedBrowserUse(
      resolvedConfig.remotePort,
      remoteUserDataDir,
      remoteProfile,
      async () => {
        await ensureRemoteChrome(
          resolvedBrowserChromePath,
          remoteUserDataDir,
          remoteProfile,
          resolvedConfig.remotePort,
          remoteLog,
          chatgptUrl,
          resolvedConfig.managedBrowserBackgroundMode,
          managedBrowserDisplayMode,
          resolvedConfig.managedBrowserLaunchMode,
        );
      },
    );
    let completedResponseCapture = false;
    try {
      try {
        draftResult = prepareChatgptDraft(
          resolvedConfig.remotePort,
          chatgptUrl,
          draftMode,
          effectiveModel,
          effectiveThinking,
          effectiveAppConnector,
          draftTimeoutMs,
          draftPromptText,
          autoSend,
          waitResponse,
          responseTimeoutMs,
          resolvedResponseFile ?? '',
          responseMarker ?? '',
          minimumMarkedResponseMs,
          attachmentPaths,
          cleanupFilePaths,
          idleDraftTimeoutMs,
        );
        completedResponseCapture = waitResponse;
      } catch (error) {
        const sentConversationUrl =
          error instanceof DraftPreparationError ? error.conversationUrl : undefined;
        const captureMetadataPath =
          error instanceof DraftPreparationError ? error.captureMetadataPath : undefined;
        const diagnosticsOutputDir = await maybeCollectDraftFailureDiagnostics({
          autoSend,
          browserPort: resolvedConfig.remotePort,
          chatgptUrl,
          commandLabel: 'review-gpt-send',
          contextCwd: context.cwd,
          error,
        });
        if (sentConversationUrl) {
          const wakeCommand = buildReplayableWakeCommand({
            browserEndpoint: `http://127.0.0.1:${resolvedConfig.remotePort}`,
            captureMetadataPath: captureMetadataPath
              ? portableReplayPath(context.cwd, captureMetadataPath)
              : undefined,
            chatUrl: sentConversationUrl,
          });
          throw new Error(
            `ChatGPT accepted the review prompt, but ReviewGPT could not finish response capture.\nChatGPT thread URL: ${sentConversationUrl}\nManaged browser endpoint: http://127.0.0.1:${resolvedConfig.remotePort}\nReplayable wake command: ${wakeCommand.map(shellQuote).join(' ')}${diagnosticsOutputDir ? `\nDiagnostics bundle: ${redactLocalPath(diagnosticsOutputDir)}` : ''}\nInspect or resume this existing thread before retrying so the review is not sent twice.`,
          );
        }
        const signInRecovery = managedBrowserDisplayMode === 'headless'
          ? 'restart this profile in headful mode, complete sign-in once, then retry headless mode'
          : resolvedConfig.managedBrowserLaunchMode === 'background'
            ? 'restart this profile with managed_browser_launch_mode="foreground", complete sign-in once, then retry background mode'
            : 'complete the sign-in in the opened browser window and rerun the command';
        throw new Error(
          `Error: failed to stage the ChatGPT draft in the managed browser.\nManaged browser data dir: ${redactLocalPath(remoteUserDataDir)}\nManaged browser profile: ${remoteProfile}${diagnosticsOutputDir ? `\nDiagnostics bundle: ${redactLocalPath(diagnosticsOutputDir)}` : ''}\nIf ChatGPT is asking you to log in, ${signInRecovery}.`,
        );
      }
    } finally {
      try {
        const finishResult = await finishManagedBrowserUse(
          managedBrowserLease,
          resolvedConfig.remotePort,
          completedResponseCapture && resolvedConfig.managedBrowserCloseAfterWait,
        );
        if (finishResult === 'closed') {
          console.log('Managed browser closed after the last active review completed.');
        } else if (finishResult === 'active-runs') {
          console.log('Managed browser stayed open for another active ReviewGPT run.');
        } else if (finishResult === 'busy') {
          console.warn('Managed browser stayed open because another page is active on this endpoint.');
        }
      } catch (error) {
        const preservedCapturePrefix = completedResponseCapture
          ? 'Completed response capture preserved, but '
          : '';
        console.warn(
          `${preservedCapturePrefix}managed browser lifecycle cleanup did not finish: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    openChromeWindow(resolvedBrowserChromePath, chatgptUrl, detectedBrowserProfile ?? '', remoteUserDataDir);
    console.error('Warning: managed browser mode disabled; opened ChatGPT only without staged attachments.');
  }

  if (autoSend) {
    if (waitResponse) {
      console.log('Opened ChatGPT with prompt/files staged, auto-send enabled, and response capture completed.');
    } else {
      console.log('Opened ChatGPT with prompt/files staged and auto-send enabled.');
    }
    if (draftResult.conversationUrl) {
      console.log(`ChatGPT thread URL: ${draftResult.conversationUrl}`);
    }
    if (draftResult.conversationId) {
      console.log(`ChatGPT thread ID: ${draftResult.conversationId}`);
    }
    if (draftResult.conversationUrl) {
      const wakeCommand = buildReplayableWakeCommand({
        browserEndpoint: `http://127.0.0.1:${resolvedConfig.remotePort}`,
        captureMetadataPath: draftResult.captureMetadataPath
          ? portableReplayPath(context.cwd, draftResult.captureMetadataPath)
          : undefined,
        chatUrl: draftResult.conversationUrl,
      });
      console.log(`Replayable wake command: ${wakeCommand.map(shellQuote).join(' ')}`);
    }
  } else {
    console.log('Opened ChatGPT in draft-only mode with prompt/files staged.');
  }
  if (repomixPath) {
    console.log(`Repomix attachment: ${redactLocalPath(repomixPath)}`);
  } else {
    console.log('Repomix attachment: disabled');
  }
  console.log(`ZIP file: ${zipPath ? redactLocalPath(zipPath) : 'disabled'}`);
  console.log(`BASE_COMMIT: ${baseCommit ?? '(unavailable)'}`);

  return buildRunResult(stagingPlan, {
    captureMetadataPath: draftResult.captureMetadataPath
      ? portableReplayPath(context.cwd, draftResult.captureMetadataPath)
      : undefined,
    conversationId: draftResult.conversationId,
    conversationUrl: draftResult.conversationUrl,
    dryRun: false,
  });
}

function buildRunResult(
  plan: StagingPlan,
  input: {
    captureMetadataPath?: string;
    conversationId?: string;
    conversationUrl?: string;
    dryRun: boolean;
  },
): ReviewGptRunResult {
  return {
    artifactsAttached: plan.attachArtifacts,
    autoSend: plan.autoSend,
    baseCommit: plan.baseCommit,
    browserEndpoint: `http://127.0.0.1:${plan.remotePort}`,
    captureMetadataPath: input.captureMetadataPath,
    chatId: input.conversationId ?? extractConversationId(plan.chatgptUrl),
    chatUrl: input.conversationUrl ?? plan.chatgptUrl,
    deepResearch: plan.deepResearch,
    draftMode: plan.draftMode,
    dryRun: input.dryRun,
    responseFile: plan.resolvedResponseFile,
    selectedPresets: [...plan.selectedPresets],
    waitResponse: plan.waitResponse,
    wakeCommand: input.conversationUrl
      ? buildReplayableWakeCommand({
          browserEndpoint: `http://127.0.0.1:${plan.remotePort}`,
          captureMetadataPath: input.captureMetadataPath,
          chatUrl: input.conversationUrl,
        })
      : undefined,
  };
}

export function buildReplayableWakeCommand(input: {
  browserEndpoint: string;
  captureMetadataPath?: string;
  chatUrl: string;
}): string[] {
  const command = [
    'cobuild-review-gpt',
    'thread',
    'wake',
    '--delay',
    '0s',
    '--browser-endpoint',
    input.browserEndpoint,
    '--chat-url',
    input.chatUrl,
  ];
  if (input.captureMetadataPath) {
    command.push('--capture-metadata', input.captureMetadataPath);
  }
  return command;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function portableReplayPath(cwd: string, filePath: string): string {
  const relativePath = relative(cwd, filePath);
  return relativePath || '.';
}

function extractConversationId(url: string): string | undefined {
  const match = String(url || '').match(/\/c\/([^/?#]+)/i);
  return match?.[1];
}

async function maybeCollectDraftFailureDiagnostics(input: {
  autoSend: boolean;
  browserPort: string;
  chatgptUrl: string;
  commandLabel: string;
  contextCwd: string;
  error: unknown;
}): Promise<string | undefined> {
  if (!(input.error instanceof DraftPreparationError) || !input.error.driverLogPath) {
    return undefined;
  }

  const diagnosticChatUrl = input.error.conversationUrl ?? input.chatgptUrl;
  if (!input.autoSend || !extractConversationId(diagnosticChatUrl)) {
    rmSync(dirname(input.error.driverLogPath), { force: true, recursive: true });
    return undefined;
  }

  try {
    const result = await collectThreadDiagnostics({
      browserEndpoint: `http://127.0.0.1:${input.browserPort}`,
      chatUrl: diagnosticChatUrl,
      commandLabel: input.commandLabel,
      cwd: input.contextCwd,
      exitCode: input.error.status ?? null,
      logFilePath: input.error.driverLogPath,
    });
    return result.outputDir;
  } catch {
    return undefined;
  } finally {
    rmSync(dirname(input.error.driverLogPath), { force: true, recursive: true });
  }
}

export function extractConversationUrlFromDriverOutput(
  output: string | Buffer | null | undefined,
): string | undefined {
  const text = typeof output === 'string' ? output : output?.toString('utf8') ?? '';
  const matches = Array.from(text.matchAll(/^ChatGPT conversation URL:\s+(\S+)\s*$/gm));
  return matches.at(-1)?.[1];
}

function extractConversationIdFromDriverOutput(output: string | Buffer | null | undefined): string | undefined {
  const conversationUrl = extractConversationUrlFromDriverOutput(output);
  return conversationUrl ? extractConversationId(conversationUrl) : undefined;
}
