import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CliOptions = {
  browserBinary?: boolean;
  browserPath?: string | undefined;
  chat?: string | undefined;
  chatId?: string | undefined;
  chatUrl?: string | undefined;
  config?: string | undefined;
  deepResearch?: boolean | undefined;
  dryRun?: boolean | undefined;
  listPresets?: boolean | undefined;
  model?: string | undefined;
  noZip?: boolean | undefined;
  noTests?: boolean | undefined;
  preset?: string[] | undefined;
  prompt?: string[] | undefined;
  promptFile?: string[] | undefined;
  withTests?: boolean | undefined;
  responseFile?: string | undefined;
  send?: boolean | undefined;
  submit?: boolean | undefined;
  thinking?: string | undefined;
  timeout?: string | undefined;
  wait?: boolean | undefined;
  waitTimeout?: string | undefined;
};

type RawCliState = {
  autoSend: boolean;
  browserPathOverride?: string;
  chatTargetOverride?: string;
  cliAutoSendSet: boolean;
  cliDeepResearchSet: boolean;
  cliModelOverrideSet: boolean;
  cliThinkingOverrideSet: boolean;
  cliWaitResponseSet: boolean;
  deepResearch: boolean;
  modelOverride?: string;
  responseFileOverride?: string;
  responseTimeoutOverride?: string;
  thinkingOverride?: string;
  timeoutOverride?: string;
  waitResponse: boolean;
};

type LoadedConfig = {
  browser: string;
  browserBinaryPath: string;
  browserChromePath: string;
  browserPath: string;
  browserProfile: string;
  chatgptUrl: string;
  draftTimeoutMs: string;
  includeDocs: string;
  includeTests: string;
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
  remoteManaged: string;
  remotePort: string;
  responseFile: string;
  responseTimeoutMs: string;
  thinking: string;
};

type ResolvedConfig = {
  browser: string;
  browserChromePath: string;
  browserProfile: string;
  chatgptUrl: string;
  draftTimeoutMs?: string;
  includeDocs: boolean;
  includeTests: boolean;
  namePrefix: string;
  outDir: string;
  packageScript: string;
  presets: Array<{ description: string; name: string; path: string }>;
  presetAliases: Map<string, string>;
  presetDir: string;
  presetGroups: Array<{ description: string; members: string[]; name: string }>;
  remoteManaged: boolean;
  remotePort: string;
  remoteProfile: string;
  remoteUserDataDir: string;
  responseFile?: string;
  responseTimeoutMs?: string;
  thinking?: string;
  model?: string;
};

type RunContext = {
  cwd: string;
  rawArgv: string[];
  repoRoot: string;
};

type StagingPlan = {
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
  managedProfileState: string;
  promptChunks: string[];
  remotePort: string;
  remoteProfile: string;
  remoteUserDataDir: string;
  resolvedBrowserChromePath: string;
  resolvedBrowserFamily: string;
  resolvedResponseFile?: string;
  repomixPath: string;
  responseTimeoutMs: string;
  selectedPresets: string[];
  waitResponse: boolean;
  zipPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const compatScriptPath = resolve(__dirname, '../src/review-gpt-config-compat.sh');
const draftDriverPath = resolve(__dirname, '../src/prepare-chatgpt-draft.js');
const defaultManagedBrowserUserDataDir = join(homedir(), '.review-gpt', 'managed-chromium');
const legacyManagedBrowserUserDataDir = join(homedir(), '.oracle', 'remote-chrome');
const homeDir = homedir();

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

function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = trimWhitespace(value ?? '');
  return trimmed ? trimmed : undefined;
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

function scanRawCliState(rawArgv: string[]): RawCliState {
  const state: RawCliState = {
    autoSend: false,
    cliAutoSendSet: false,
    cliDeepResearchSet: false,
    cliModelOverrideSet: false,
    cliThinkingOverrideSet: false,
    cliWaitResponseSet: false,
    deepResearch: false,
    waitResponse: false,
  };

  for (let index = 0; index < rawArgv.length; index += 1) {
    const token = rawArgv[index] ?? '';
    switch (token) {
      case '--model':
        if (rawArgv[index + 1] !== undefined) {
          state.cliModelOverrideSet = true;
          state.modelOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--thinking':
        if (rawArgv[index + 1] !== undefined) {
          state.cliThinkingOverrideSet = true;
          state.thinkingOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--deep-research':
        state.cliDeepResearchSet = true;
        state.deepResearch = true;
        break;
      case '--chat':
      case '--chat-url':
      case '--chat-id':
        if (rawArgv[index + 1] !== undefined) {
          state.chatTargetOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--send':
      case '--submit':
        state.cliAutoSendSet = true;
        state.autoSend = true;
        break;
      case '--wait':
        state.cliWaitResponseSet = true;
        state.waitResponse = true;
        state.cliAutoSendSet = true;
        state.autoSend = true;
        break;
      case '--no-send':
        state.cliAutoSendSet = true;
        state.autoSend = false;
        break;
      case '--wait-timeout':
        if (rawArgv[index + 1] !== undefined) {
          state.responseTimeoutOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--timeout':
        if (rawArgv[index + 1] !== undefined) {
          state.timeoutOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--response-file':
        if (rawArgv[index + 1] !== undefined) {
          state.responseFileOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--browser-path':
      case '--browser-binary':
        if (rawArgv[index + 1] !== undefined) {
          state.browserPathOverride = rawArgv[index + 1];
          index += 1;
        }
        break;
      case '--config':
      case '--preset':
      case '--prompt':
      case '--prompt-file':
      case '--format':
      case '--filter-output':
      case '--token-limit':
      case '--token-offset':
        if (rawArgv[index + 1] !== undefined) {
          index += 1;
        }
        break;
      default:
        if (token.startsWith('--') && token.includes('=')) {
          const [flag, value] = token.split(/=(.*)/s);
          if (flag === '--model') {
            state.cliModelOverrideSet = true;
            state.modelOverride = value;
          } else if (flag === '--thinking') {
            state.cliThinkingOverrideSet = true;
            state.thinkingOverride = value;
          } else if (flag === '--timeout') {
            state.timeoutOverride = value;
          } else if (flag === '--wait-timeout') {
            state.responseTimeoutOverride = value;
          } else if (flag === '--response-file') {
            state.responseFileOverride = value;
          } else if (flag === '--chat' || flag === '--chat-url' || flag === '--chat-id') {
            state.chatTargetOverride = value;
          } else if (flag === '--browser-path' || flag === '--browser-binary') {
            state.browserPathOverride = value;
          }
        }
        break;
    }
  }

  return state;
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
    remoteManaged: parseBooleanLike(loaded?.remoteManaged, true),
    remotePort,
    remoteProfile,
    remoteUserDataDir,
    responseFile: parseOptionalString(loaded?.responseFile),
    responseTimeoutMs: parseOptionalDuration(loaded?.responseTimeoutMs),
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
      'Error: missing repomix runtime dependency.\nReinstall @cobuild/review-gpt or add repomix so review-gpt can generate repo.repomix.xml.',
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

function startRemoteChrome(
  chromeBin: string,
  userDataDir: string,
  profileDir: string,
  port: string,
  logPath: string,
  startUrl: string,
): void {
  mkdirSync(userDataDir, { recursive: true });
  const child = spawn(
    chromeBin,
    [
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--new-window',
      startUrl,
    ],
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

async function ensureRemoteChrome(
  chromeBin: string,
  userDataDir: string,
  profileDir: string,
  port: string,
  logPath: string,
  startUrl: string,
): Promise<void> {
  if (await isRemoteChromeReady(port)) {
    return;
  }

  console.log(`Starting managed browser on port ${port}...`);
  startRemoteChrome(chromeBin, userDataDir, profileDir, port, logPath, startUrl);

  for (let index = 0; index < 50; index += 1) {
    if (await isRemoteChromeReady(port)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }

  throw new Error(`Error: managed browser failed to start on 127.0.0.1:${port}.\nCheck log: ${logPath}`);
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
  timeoutMs: string,
  promptText: string,
  shouldSend: boolean,
  shouldWaitForResponse: boolean,
  responseTimeoutMs: string,
  responseFile: string,
  filePaths: string[],
): void {
  requireFile(draftDriverPath);
  const result = spawnSync(process.execPath, [draftDriverPath], {
    env: {
      ...process.env,
      ORACLE_DRAFT_FILES: filePaths.join('\n'),
      ORACLE_DRAFT_MODE: mode,
      ORACLE_DRAFT_MODEL: modelTarget,
      ORACLE_DRAFT_PROMPT: promptText,
      ORACLE_DRAFT_REMOTE_PORT: port,
      ORACLE_DRAFT_RESPONSE_FILE: responseFile,
      ORACLE_DRAFT_RESPONSE_TIMEOUT_MS: responseTimeoutMs,
      ORACLE_DRAFT_SEND: shouldSend ? '1' : '0',
      ORACLE_DRAFT_THINKING: thinkingLevel,
      ORACLE_DRAFT_TIMEOUT_MS: timeoutMs,
      ORACLE_DRAFT_URL: url,
      ORACLE_DRAFT_WAIT_RESPONSE: shouldWaitForResponse ? '1' : '0',
    },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error('Error: failed to stage the ChatGPT draft in the managed browser.');
  }
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
  copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function toRepoRelativeIgnorePattern(repoRoot: string, filePath: string): string | undefined {
  const relativePath = relative(repoRoot, filePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.replace(/\\/gu, '/');
}

function runRepomix(repoRoot: string, outputPath: string, ignorePaths: string[]): void {
  const repomixCli = resolveRepomixCliPath();
  mkdirSync(dirname(outputPath), { recursive: true });
  const args = [repomixCli, '--quiet', '--style', 'xml', '--output', outputPath];
  if (ignorePaths.length > 0) {
    args.push('--ignore', ignorePaths.join(','));
  }
  args.push('.');
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(trimWhitespace(result.stderr || result.stdout || 'Error: repomix packaging failed.'));
  }
}

function buildArtifactInstructionText(baseCommit?: string): string {
  const lines = [
    'Use repo.repomix.xml as the primary review artifact.',
    'Use repo.snapshot.zip only as a fidelity fallback/source of truth.',
  ];
  if (baseCommit) {
    lines.push(`Generate unified diff patches against BASE_COMMIT=${baseCommit}.`);
  }
  return lines.join('\n');
}

function buildDraftPromptText(
  selectedPresets: string[],
  config: ResolvedConfig,
  extraPromptFiles: string[],
  promptChunks: string[],
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
  if (plan.attachArtifacts) {
    console.log(`Repomix XML: ${redactLocalPath(plan.repomixPath)}`);
    console.log(`ZIP file: ${redactLocalPath(plan.zipPath)}`);
    console.log(`BASE_COMMIT: ${plan.baseCommit ?? '(unavailable)'}`);
  } else {
    console.log('Repomix XML: (disabled via --no-zip)');
    console.log('ZIP file: (disabled via --no-zip)');
    console.log('BASE_COMMIT: (disabled via --no-zip)');
  }
  console.log(`ChatGPT URL: ${plan.chatgptUrl}`);
  console.log(`ChatGPT mode: ${plan.draftMode}`);
  console.log(`Draft model target: ${isCurrentTarget(plan.effectiveModel) ? 'current' : plan.effectiveModel}`);
  console.log(`Draft thinking target: ${isCurrentTarget(plan.effectiveThinking) ? 'current' : plan.effectiveThinking}`);
  console.log(`Draft send: ${plan.autoSend ? 'enabled (auto-submit)' : 'disabled'}`);
  if (plan.waitResponse) {
    console.log(`Response capture: enabled (${plan.responseTimeoutMs}ms timeout)`);
    console.log('Wait behavior: block until the assistant finishes or the wait timeout is hit.');
    if (plan.draftMode === 'deep-research') {
      console.log('Deep Research wait: long-running runs stay attached until completion or timeout, even when the UI is quiet.');
    }
  } else {
    console.log('Response capture: disabled');
  }
  console.log(`Draft timeout: ${plan.draftTimeoutMs}ms`);
  if (plan.resolvedResponseFile) {
    console.log(`Response file: ${redactLocalPath(plan.resolvedResponseFile)}`);
  }
  console.log(`Browser target: chromium-family`);
  console.log(`Browser family: ${plan.resolvedBrowserFamily}`);
  console.log('Managed browser mode: enabled');
  console.log(`Managed browser endpoint: 127.0.0.1:${plan.remotePort}`);
  console.log(`Managed browser data dir: ${redactLocalPath(plan.remoteUserDataDir)}`);
  console.log(`Managed browser profile: ${plan.remoteProfile}`);
  console.log(`Managed browser state: ${plan.managedProfileState}`);
  console.log(`Browser binary: ${redactLocalPath(plan.resolvedBrowserChromePath)}`);
  if (plan.detectedBrowserProfile) {
    console.log(`Detected local browser profile: ${plan.detectedBrowserProfile}`);
  }
}

export function preprocessArgv(argv: string[]): string[] {
  const normalizedArgv = argv.map((token) => {
    if (token === '--no-zip') {
      return '--noZip';
    }
    if (token.startsWith('--no-zip=')) {
      return `--noZip=${token.slice('--no-zip='.length)}`;
    }
    return token;
  });
  const builtInCommands = new Set(['completions', 'mcp', 'skills', 'thread']);
  const valueFlags = new Set([
    '--browser-binary',
    '--browser-path',
    '--chat',
    '--chat-id',
    '--chat-url',
    '--config',
    '--filter-output',
    '--format',
    '--model',
    '--preset',
    '--prompt',
    '--prompt-file',
    '--response-file',
    '--thinking',
    '--timeout',
    '--token-limit',
    '--token-offset',
    '--wait-timeout',
  ]);

  let firstPositionalCommand: string | undefined;
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const token = normalizedArgv[index] ?? '';
    if (token === '--') {
      break;
    }
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    firstPositionalCommand = token;
    break;
  }
  if (firstPositionalCommand && builtInCommands.has(firstPositionalCommand)) {
    return normalizedArgv;
  }
  if (normalizedArgv.includes('--help') || normalizedArgv.includes('-h')) {
    return ['--help'];
  }
  if (normalizedArgv.includes('--version')) {
    return ['--version'];
  }

  const transformed: string[] = [];
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const token = normalizedArgv[index] ?? '';
    if (token === '--') {
      throw new Error("Error: forwarding raw Oracle args is no longer supported.\nUse top-level cobuild-review-gpt options only (--preset/--prompt).");
    }

    if (valueFlags.has(token)) {
      transformed.push(token);
      if (normalizedArgv[index + 1] !== undefined) {
        transformed.push(normalizedArgv[index + 1] as string);
        index += 1;
      }
      continue;
    }

    if (token.startsWith('--') && token.includes('=')) {
      transformed.push(token);
      continue;
    }

    if (token.startsWith('-')) {
      transformed.push(token);
      continue;
    }

    transformed.push('--preset', token);
  }

  return transformed;
}

export async function runReviewGpt(options: CliOptions, context: RunContext): Promise<void> {
  const repoRoot = await gitRepoRoot(context.cwd);
  const rawState = scanRawCliState(context.rawArgv);

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
    return;
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
    rawState.chatTargetOverride ??
    options.chat ??
    options.chatUrl ??
    options.chatId;
  const deepResearch = rawState.cliDeepResearchSet ? rawState.deepResearch : Boolean(options.deepResearch);
  if (deepResearch && !chatTarget) {
    chatgptUrl = 'https://chatgpt.com/deep-research';
  } else if (chatTarget) {
    chatgptUrl = resolveChatTargetUrl(chatTarget, extractUrlOrigin(chatgptUrl));
  }

  let effectiveModel =
    rawState.cliModelOverrideSet
      ? rawState.modelOverride ?? 'gpt-5.4-pro'
      : options.model ?? resolvedConfig.model ?? 'gpt-5.4-pro';
  let effectiveThinking =
    rawState.cliThinkingOverrideSet
      ? rawState.thinkingOverride ?? 'current'
      : options.thinking ?? resolvedConfig.thinking ?? 'current';
  const draftMode: 'chat' | 'deep-research' = deepResearch ? 'deep-research' : 'chat';

  if (deepResearch) {
    if (rawState.cliModelOverrideSet && !isCurrentTarget(rawState.modelOverride)) {
      console.error('Warning: --model is ignored in --deep-research mode; the dedicated page controls the mode.');
    }
    if (rawState.cliThinkingOverrideSet && !isCurrentTarget(rawState.thinkingOverride)) {
      console.error('Warning: --thinking is ignored in --deep-research mode.');
    }
    effectiveModel = 'current';
    effectiveThinking = 'current';
  }

  let autoSend = rawState.cliAutoSendSet ? rawState.autoSend : false;
  if (!rawState.cliAutoSendSet) {
    if (options.submit === true || options.send === true || options.wait === true) {
      autoSend = true;
    }
  }

  const waitResponse = rawState.cliWaitResponseSet ? rawState.waitResponse : Boolean(options.wait);
  if (waitResponse && !autoSend) {
    throw new Error('Error: --wait requires auto-send; remove --no-send or add --send.');
  }

  let draftTimeoutMs =
    rawState.timeoutOverride !== undefined
      ? parseDurationToMs(rawState.timeoutOverride)
      : options.timeout
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
    rawState.responseTimeoutOverride !== undefined
      ? parseDurationToMs(rawState.responseTimeoutOverride)
      : options.waitTimeout
        ? parseDurationToMs(options.waitTimeout)
        : resolvedConfig.responseTimeoutMs;
  if (!responseTimeoutMs) {
    responseTimeoutMs = draftTimeoutMs;
  }

  const responseFile =
    rawState.responseFileOverride ??
    options.responseFile ??
    resolvedConfig.responseFile;
  const resolvedResponseFile = responseFile ? resolveOutputPath(context.cwd, responseFile) : undefined;

  const attachArtifacts = options.noZip !== true;
  const attachmentPaths: string[] = [];
  let baseCommit: string | undefined;
  let repomixPath = '';
  let zipPath = '';
  const includeTests = options.withTests === true
    ? true
    : options.noTests === true
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
    process.stdout.write(redactForDisplay(packageOutput));
    if (!packageOutput.endsWith('\n')) {
      process.stdout.write('\n');
    }
    const generatedZipPath = resolveZipPath(packageOutput);
    const artifactDir = dirname(generatedZipPath);
    zipPath = ensureArtifactAlias(generatedZipPath, join(artifactDir, 'repo.snapshot.zip'));
    repomixPath = join(artifactDir, 'repo.repomix.xml');
    const ignorePaths = Array.from(
      new Set(
        [generatedZipPath, zipPath, repomixPath]
          .map((filePath) => toRepoRelativeIgnorePattern(repoRoot, filePath))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    runRepomix(repoRoot, repomixPath, ignorePaths);
    attachmentPaths.push(repomixPath, zipPath);
    baseCommit = gitHeadCommit(repoRoot);
  }

  const promptChunks = options.prompt ?? [];
  const artifactInstructionText = attachArtifacts ? buildArtifactInstructionText(baseCommit) : '';
  const draftPromptText = buildDraftPromptText(
    selectedPresets,
    resolvedConfig,
    extraPromptFiles,
    promptChunks,
    artifactInstructionText,
  );

  let resolvedBrowserChromePath = rawState.browserPathOverride ?? options.browserPath ?? resolvedConfig.browserChromePath;
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
    effectiveModel,
    effectiveThinking,
    extraPromptFiles,
    managedProfileState,
    promptChunks,
    remotePort: resolvedConfig.remotePort,
    remoteProfile,
    remoteUserDataDir,
    resolvedBrowserChromePath,
    resolvedBrowserFamily,
    resolvedResponseFile,
    repomixPath,
    responseTimeoutMs,
    selectedPresets,
    waitResponse,
    zipPath,
  };

  printStagingPlan(stagingPlan);

  if (options.dryRun) {
    console.log('Dry run: browser launch skipped');
    return;
  }

  if (resolvedConfig.remoteManaged) {
    const remoteLog = join(tmpdir(), 'review-gpt-managed-browser.log');
    await ensureRemoteChrome(
      resolvedBrowserChromePath,
      remoteUserDataDir,
      remoteProfile,
      resolvedConfig.remotePort,
      remoteLog,
      chatgptUrl,
    );
    try {
      prepareChatgptDraft(
        resolvedConfig.remotePort,
        chatgptUrl,
        draftMode,
        effectiveModel,
        effectiveThinking,
        draftTimeoutMs,
        draftPromptText,
        autoSend,
        waitResponse,
        responseTimeoutMs,
        resolvedResponseFile ?? '',
        attachmentPaths,
      );
    } catch {
      throw new Error(
        `Error: failed to stage the ChatGPT draft in the managed browser.\nManaged browser data dir: ${redactLocalPath(remoteUserDataDir)}\nManaged browser profile: ${remoteProfile}\nIf ChatGPT is asking you to log in, complete the sign-in in the opened browser window and rerun the command.`,
      );
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
  } else {
    console.log('Opened ChatGPT in draft-only mode with prompt/files staged.');
  }
  if (attachArtifacts) {
    console.log(`Repomix XML: ${redactLocalPath(repomixPath)}`);
    console.log(`ZIP file: ${redactLocalPath(zipPath)}`);
    console.log(`BASE_COMMIT: ${baseCommit ?? '(unavailable)'}`);
  } else {
    console.log('Repomix XML: (disabled via --no-zip)');
    console.log('ZIP file: (disabled via --no-zip)');
    console.log('BASE_COMMIT: (disabled via --no-zip)');
  }
}
