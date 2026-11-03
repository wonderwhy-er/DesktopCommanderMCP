import fs from 'fs/promises';
import path from 'path';
import { existsSync, watch, type FSWatcher } from 'fs';
import { mkdir } from 'fs/promises';
import lockfile from 'proper-lockfile';
import { VERSION } from './version.js';
import { CONFIG_FILE } from './config.js';
import { getDefaultShell } from './utils/shell.js';
import { writeFileAtomic } from './utils/atomic-write.js';
import { buildRecoveredConfig, type RecoveryEvent, type RecoveryPhase } from './config-recovery.js';

// Older versions wrote config.json in place, so retry partial reads before treating
// a transient empty or truncated file as corrupt.
const PARTIAL_CONFIG_WAIT_MS = 1_000;
const PARTIAL_CONFIG_MIN_FAILED_READS = 30;
const SAVE_RETRY_MS = 250;
const HELD_SAVE_RETRY_MS = 5_000;
const MAX_CONFIG_WRITE_ATTEMPTS = 3;

class ConfigChangedError extends Error {
  constructor() {
    super('config.json changed, or its lock was lost, before this write committed');
  }
}

export interface ServerConfig {
  blockedCommands?: string[];
  defaultShell?: string;
  allowedDirectories?: string[];
  telemetryEnabled?: boolean;
  fileWriteLineLimit?: number;
  fileReadLineLimit?: number;
  clientId?: string;
  currentClient?: ClientInfo;
  [key: string]: any;
}

export interface ClientInfo {
  name: string;
  version: string;
}

type CorruptConfigPhase = RecoveryPhase;
interface CorruptConfigRecoveryTelemetry extends RecoveryEvent {
  parse_error_kind: 'truncated' | 'invalid_json';
  config_age_bucket: '<1s' | '<1m' | '<1h' | '>=1h' | 'unknown';
  temp_file_count: number;
  persisted_version: string;
}
interface CorruptConfigRecovery {
  config: ServerConfig;
  telemetry: CorruptConfigRecoveryTelemetry;
}

export function normalizeTelemetryEnabledValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}

export function isTelemetryDisabledValue(value: unknown): boolean {
  return normalizeTelemetryEnabledValue(value) === false;
}

function extractRecoverableStringArray(text: string, key: string): string[] | null {
  const marker = new RegExp(`(?:^|[,{])\\s*"${key}"\\s*:\\s*\\[`);
  const match = marker.exec(text);
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf('[');
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      try {
        const value = JSON.parse(text.slice(start, i + 1));
        return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Parses config text, allowing a UTF-8 BOM from common Windows editors. */
export function parseConfig(text: string): ServerConfig {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function migrateLegacyConfig(config: ServerConfig): void {
  if (config['welcomeOnboardingEligible'] === undefined) {
    config['welcomeOnboardingEligible'] = false;
    config['pendingWelcomeOnboarding'] = false;
  }
}

function warnUser(message: string): void {
  console.warn(message);
  process.stderr.write(`[WARNING] Desktop Commander: ${message}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ConfigManager {
  private configPath: string;
  private config: ServerConfig = {};
  private initialized = false;
  private _isFirstRun = false;
  private writeChain: Promise<void> = Promise.resolve();
  private saveScheduled = false;
  private pendingMutations: Array<(config: ServerConfig) => void> = [];
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private pendingCorruptConfigTelemetry: CorruptConfigRecoveryTelemetry[] = [];
  private failedSaves = 0;
  private saveRetry: NodeJS.Timeout | null = null;
  private heldRecoveryEvents: RecoveryEvent[] = [];

  constructor() {
    this.configPath = CONFIG_FILE;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const configDir = path.dirname(this.configPath);
      if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });
      this.config = await this.loadStartupConfig();
      this.config['version'] = VERSION;
      this.initialized = true;
      this.startConfigWatcher();
    } catch (error) {
      console.error('Failed to initialize config:', error);
      this.config = this.getDefaultConfig();
      this.initialized = true;
      this.startConfigWatcher();
    }
    for (const event of this.heldRecoveryEvents.splice(0)) void this.emitCorruptConfigTelemetry(event);
    this.flushCorruptConfigTelemetry();
  }

  private async loadStartupConfig(): Promise<ServerConfig> {
    let config: ServerConfig;
    try {
      config = await this.readConfigFromDisk();
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        let created = false;
        config = await this.performConfigMutation((latest, existed) => {
          if (!existed) {
            Object.assign(latest, this.getDefaultConfig());
            created = true;
          }
        });
        this._isFirstRun = created;
      } else if (error instanceof SyntaxError) {
        try {
          const recovery = await this.withConfigLock(() => this.recoverCorruptConfig('startup'));
          config = recovery.config;
          this.recordCorruptConfigTelemetry(recovery.telemetry);
          this._isFirstRun = false;
        } catch (recoveryError) {
          const text = await fs.readFile(this.configPath, 'utf8').catch(() => '');
          return this.startWithoutSaving(buildRecoveredConfig(this.getDefaultConfig(), null, text),
            `config.json could not be parsed, and replacing it failed (${messageOf(recoveryError)}). For this session Desktop Commander uses the settings still readable in it and the defaults for the rest; config.json is left as it is.`);
        }
      } else {
        return this.startWithoutSaving(buildRecoveredConfig(this.getDefaultConfig(), null, ''),
          `config.json could not be read (${messageOf(error)}). For this session Desktop Commander uses the default settings; config.json is left as it is.`);
      }
    }

    if (!this._isFirstRun && config['welcomeOnboardingEligible'] === undefined) {
      try {
        config = await this.performConfigMutation(migrateLegacyConfig);
      } catch (error) {
        migrateLegacyConfig(config);
        this.pendingMutations.push(migrateLegacyConfig);
        return this.startWithoutSaving(config, `config.json was read, but saving to it failed (${messageOf(error)}). ` +
          `Desktop Commander uses the settings it read; changes to them can't be saved until config.json is writable.`);
      }
    }
    return config;
  }

  private startWithoutSaving(config: ServerConfig, warning: string): ServerConfig {
    this.failedSaves = 2;
    this.retrySaves(HELD_SAVE_RETRY_MS);
    warnUser(warning);
    return config;
  }

  async loadConfig(): Promise<void> {
    return this.init();
  }

  private getDefaultConfig(): ServerConfig {
    return {
      blockedCommands: [
        'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart',
        'sudo', 'su', 'passwd', 'adduser', 'useradd', 'usermod', 'groupadd', 'chsh', 'visudo',
        'shutdown', 'reboot', 'halt', 'poweroff', 'init',
        'iptables', 'firewall', 'netsh',
        'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas', 'cipher', 'takeown',
      ],
      defaultShell: getDefaultShell(),
      allowedDirectories: [],
      telemetryEnabled: true,
      fileWriteLineLimit: 50,
      fileReadLineLimit: 1000,
      pendingWelcomeOnboarding: true,
      welcomeOnboardingEligible: true,
    };
  }

  private async readConfigFromDisk(): Promise<ServerConfig> {
    const deadline = Date.now() + PARTIAL_CONFIG_WAIT_MS;
    for (let failedReads = 1; ; failedReads++) {
      try {
        return parseConfig(await fs.readFile(this.configPath, 'utf8'));
      } catch (error: any) {
        if (!(error instanceof SyntaxError)) throw error;
        if (Date.now() >= deadline && failedReads >= PARTIAL_CONFIG_MIN_FAILED_READS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private classifyConfigParseError(error: SyntaxError, text: string): 'truncated' | 'invalid_json' {
    const message = error.message.toLowerCase();
    if (message.includes('unexpected end') || message.includes('unterminated')) return 'truncated';
    const position = /position (\d+)/i.exec(error.message)?.[1];
    if (position !== undefined && Number(position) >= text.length) return 'truncated';
    return 'invalid_json';
  }

  private configAgeBucket(mtimeMs: number | null): CorruptConfigRecoveryTelemetry['config_age_bucket'] {
    if (mtimeMs === null) return 'unknown';
    const ageMs = Math.max(0, Date.now() - mtimeMs);
    if (ageMs < 1_000) return '<1s';
    if (ageMs < 60_000) return '<1m';
    if (ageMs < 3_600_000) return '<1h';
    return '>=1h';
  }

  private async inspectCorruptConfig(error: SyntaxError, phase: CorruptConfigPhase): Promise<Omit<CorruptConfigRecoveryTelemetry, 'backup_created' | 'recovered_by_other_process'>> {
    const [stat, text] = await Promise.all([
      fs.stat(this.configPath).catch(() => null),
      fs.readFile(this.configPath, 'utf8').catch(() => ''),
    ]);
    const entries = await fs.readdir(path.dirname(this.configPath)).catch(() => [] as string[]);
    const name = path.basename(this.configPath);
    const tempFileCount = entries.filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith('.tmp')).length;
    const persistedVersion = /"version"\s*:\s*"([0-9A-Za-z._+-]{1,32})"/.exec(text)?.[1] ?? 'unknown';
    return {
      phase,
      parse_error_kind: this.classifyConfigParseError(error, text),
      config_bytes: stat?.size ?? null,
      config_age_bucket: this.configAgeBucket(stat?.mtimeMs ?? null),
      temp_file_count: tempFileCount,
      persisted_version: persistedVersion,
    };
  }

  /** Called with the config lock held; a valid file means another process recovered it. */
  private async recoverCorruptConfig(phase: CorruptConfigPhase): Promise<CorruptConfigRecovery> {
    let text: string;
    let parseError: SyntaxError | null = null;
    try {
      text = await fs.readFile(this.configPath, 'utf8');
      try {
        const config = parseConfig(text);
        const telemetry = await this.recoveryTelemetry(null, phase, text, false, true);
        return { config, telemetry };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        parseError = error;
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      const defaults = this.getDefaultConfig();
      defaults['welcomeOnboardingEligible'] = false;
      defaults['pendingWelcomeOnboarding'] = false;
      await this.writeConfigAtomically(defaults);
      this.config = { ...defaults, version: VERSION };
      const telemetry = await this.recoveryTelemetry(null, phase, '', false, false);
      return { config: defaults, telemetry };
    }

    const forensics = await this.inspectCorruptConfig(parseError!, phase);
    const clientId = /"clientId"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(text)?.[1];
    const telemetryWasDisabled = /"telemetryEnabled"\s*:\s*false\b/.test(text);
    const inMemoryBlocked = Array.isArray(this.config.blockedCommands) && this.config.blockedCommands.every((item) => typeof item === 'string')
      ? this.config.blockedCommands : null;
    const inMemoryAllowed = Array.isArray(this.config.allowedDirectories) && this.config.allowedDirectories.every((item) => typeof item === 'string')
      ? this.config.allowedDirectories : null;
    const blocked = inMemoryBlocked ?? extractRecoverableStringArray(text, 'blockedCommands');
    const allowed = inMemoryAllowed ?? extractRecoverableStringArray(text, 'allowedDirectories');

    let backupCreated = false;
    if (existsSync(this.configPath)) {
      const backupPath = `${this.configPath}.corrupt.${Date.now()}.${process.pid}`;
      await fs.rename(this.configPath, backupPath);
      backupCreated = true;
    }
    const config = this.getDefaultConfig();
    if (clientId) config.clientId = clientId;
    if (telemetryWasDisabled) config.telemetryEnabled = false;
    config.blockedCommands = blocked === null ? ['*'] : [...blocked];
    config.allowedDirectories = allowed === null ? [path.dirname(this.configPath)] : [...allowed];
    config.welcomeOnboardingEligible = false;
    config.pendingWelcomeOnboarding = false;
    await this.writeConfigAtomically(config);
    this.config = { ...config, version: VERSION };
    console.error(`Recovered corrupt config during ${phase}; using defaults${backupCreated ? ' and preserved the corrupt file' : ''}.`);
    return {
      config,
      telemetry: { ...forensics, backup_created: backupCreated, recovered_by_other_process: false },
    };
  }

  private async recoveryTelemetry(error: SyntaxError | null, phase: CorruptConfigPhase, text: string, backupCreated: boolean, recoveredByOtherProcess: boolean): Promise<CorruptConfigRecoveryTelemetry> {
    const [stat, entries] = await Promise.all([
      fs.stat(this.configPath).catch(() => null),
      fs.readdir(path.dirname(this.configPath)).catch(() => [] as string[]),
    ]);
    const name = path.basename(this.configPath);
    const age = stat?.mtimeMs ?? null;
    const ageBucket = age === null ? 'unknown' : this.configAgeBucket(age);
    const tempFileCount = entries.filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith('.tmp')).length;
    const persistedVersion = /"version"\s*:\s*"([0-9A-Za-z._+-]{1,32})"/.exec(text)?.[1] ?? 'unknown';
    return {
      phase,
      parse_error_kind: error ? this.classifyConfigParseError(error, text) : 'invalid_json',
      config_bytes: stat?.size ?? (text ? Buffer.byteLength(text) : null),
      config_age_bucket: ageBucket,
      temp_file_count: tempFileCount,
      persisted_version: persistedVersion,
      backup_created: backupCreated,
      recovered_by_other_process: recoveredByOtherProcess,
    };
  }

  private recordCorruptConfigTelemetry(telemetry: CorruptConfigRecoveryTelemetry): void {
    if (!this.initialized) {
      this.pendingCorruptConfigTelemetry.push(telemetry);
      return;
    }
    void this.emitCorruptConfigTelemetry(telemetry);
  }

  private flushCorruptConfigTelemetry(): void {
    for (const telemetry of this.pendingCorruptConfigTelemetry.splice(0)) void this.emitCorruptConfigTelemetry(telemetry);
  }

  private async emitCorruptConfigTelemetry(event: CorruptConfigRecoveryTelemetry | RecoveryEvent): Promise<void> {
    try {
      const { capture } = await import('./utils/capture.js');
      await capture('config_parse_error_recovered', event);
    } catch {
      // Recovery must never depend on telemetry delivery.
    }
  }

  private async writeConfigAtomically(config: ServerConfig, beforeCommit?: () => Promise<void>): Promise<void> {
    await writeFileAtomic(this.configPath, JSON.stringify(config, null, 2), { beforeCommit });
  }

  private async readConfigText(): Promise<string | null> {
    try {
      return await fs.readFile(this.configPath, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async acquireConfigLock(onLost?: () => void): Promise<() => Promise<void>> {
    return lockfile.lock(this.configPath, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
      onCompromised: (error) => {
        console.error(`The config lock was lost while held: ${error.message} (${(error as any).code})`);
        onLost?.();
      },
    });
  }

  private async withConfigLock<T>(fn: (lockLost: () => boolean) => Promise<T>): Promise<T> {
    let lost = false;
    const release = await this.acquireConfigLock(() => { lost = true; });
    try {
      return await fn(() => lost);
    } finally {
      try {
        await release();
      } catch (error) {
        console.error('Failed to release config lock:', error);
      }
    }
  }

  private async performConfigMutation(mutate: (config: ServerConfig, existed: boolean) => void): Promise<ServerConfig> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.withConfigLock((lockLost) => this.mutateLockedConfig(mutate, lockLost));
      } catch (error) {
        if (!(error instanceof ConfigChangedError) || attempt >= MAX_CONFIG_WRITE_ATTEMPTS) throw error;
      }
    }
  }

  private async mutateLockedConfig(mutate: (config: ServerConfig, existed: boolean) => void, lockLost: () => boolean): Promise<ServerConfig> {
    let latest: ServerConfig;
    let existed = true;
    try {
      latest = await this.readConfigFromDisk();
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        const recovery = await this.recoverCorruptConfig('mutation');
        latest = recovery.config;
        this.recordCorruptConfigTelemetry(recovery.telemetry);
      } else if (error?.code === 'ENOENT') {
        latest = this.getDefaultConfig();
        existed = false;
        if (this.initialized) {
          latest.welcomeOnboardingEligible = false;
          latest.pendingWelcomeOnboarding = false;
        }
      } else {
        throw error;
      }
    }
    const readText = await this.readConfigText();
    const queued = this.pendingMutations.splice(0);
    try {
      for (const apply of queued) apply(latest);
      mutate(latest, existed);
      await this.writeConfigAtomically(latest, async () => {
        if (lockLost() || await this.readConfigText() !== readText) throw new ConfigChangedError();
      });
    } catch (error) {
      this.pendingMutations.unshift(...queued);
      throw error;
    }
    this.config = { ...latest, version: VERSION };
    this.failedSaves = 0;
    if (this.saveRetry) this.retrySaves(0);
    return latest;
  }

  private queueMutation(mutate: (config: ServerConfig) => void): void {
    this.pendingMutations.push(mutate);
    this.scheduleSave();
  }

  scheduleSave(): void {
    if (this.saveScheduled || this.saveRetry) return;
    this.saveScheduled = true;
    const write = this.writeChain.then(async () => {
      this.saveScheduled = false;
      if (this.pendingMutations.length === 0) return;
      try {
        await this.performConfigMutation(() => {});
      } catch (error) {
        this.failedSaves++;
        if (this.failedSaves === 1) {
          console.error('Failed to save config (background), will retry:', error);
          this.retrySaves(SAVE_RETRY_MS);
        } else {
          if (this.failedSaves === 2) console.error("config.json can't be written, so changes are kept and saved once it can:", error);
          this.retrySaves(HELD_SAVE_RETRY_MS);
        }
      }
    });
    this.writeChain = write.catch(() => {});
  }

  private retrySaves(ms: number): void {
    if (this.saveRetry) clearTimeout(this.saveRetry);
    this.saveRetry = setTimeout(() => {
      this.saveRetry = null;
      this.scheduleSave();
    }, ms);
    this.saveRetry.unref?.();
  }

  private startConfigWatcher(): void {
    if (this.watcher) return;
    try {
      const dir = path.dirname(this.configPath);
      const filename = path.basename(this.configPath);
      this.watcher = watch(dir, { persistent: false }, (_event, changed) => {
        if (changed && changed.toString() !== filename) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reloadConfigFromDisk(), 20);
      });
      this.watcher.on('error', (error) => console.error('Config watcher error:', error));
    } catch (error) {
      console.error('Failed to watch config:', error);
    }
  }

  private async reloadConfigFromDisk(): Promise<void> {
    try {
      let latest: ServerConfig;
      try {
        latest = await this.readConfigFromDisk();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const recovery = await this.withConfigLock(() => this.recoverCorruptConfig('watcher'));
        latest = recovery.config;
        this.recordCorruptConfigTelemetry(recovery.telemetry);
      }
      for (const mutate of this.pendingMutations) mutate(latest);
      this.config = { ...latest, version: VERSION };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('Failed to reload config:', error);
    }
  }

  async getConfig(): Promise<ServerConfig> {
    await this.init();
    return { ...this.config };
  }

  async getValue(key: string): Promise<any> {
    await this.init();
    return this.config[key];
  }

  async setValue(key: string, value: any, options: { holdIfNotSaved?: boolean } = {}): Promise<void> {
    await this.init();
    if (key === 'telemetryEnabled') value = normalizeTelemetryEnabledValue(value);
    if (key === 'telemetryEnabled' && isTelemetryDisabledValue(value) && !isTelemetryDisabledValue(this.config[key])) {
      const { capture } = await import('./utils/capture.js');
      await capture('server_telemetry_opt_out', { reason: 'user_disabled', prev_value: this.config[key] });
    }
    const nextValue = value;
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      latest[key] = nextValue;
    }).catch((error) => {
      if (options.holdIfNotSaved) {
        this.config[key] = nextValue;
        this.queueMutation((latest) => { latest[key] = nextValue; });
      }
      throw error;
    }));
    this.writeChain = write.then(() => {}, () => {});
    await write;
  }

  async updateValue(key: string, updater: (current: any) => any): Promise<any> {
    await this.init();
    let updatedValue: any;
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      updatedValue = updater(latest[key]);
      latest[key] = updatedValue;
    }));
    this.writeChain = write.then(() => {}, () => {});
    await write;
    return updatedValue;
  }

  async setValueNonBlocking(key: string, value: any): Promise<void> {
    await this.init();
    this.config[key] = value;
    this.queueMutation((latest) => { latest[key] = value; });
  }

  async updateValueNonBlocking(key: string, updater: (current: any) => any): Promise<any> {
    await this.init();
    const next = updater(this.config[key]);
    this.config[key] = next;
    this.queueMutation((latest) => { latest[key] = updater(latest[key]); });
    return next;
  }

  async updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig> {
    await this.init();
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => { Object.assign(latest, updates); }));
    this.writeChain = write.then(() => {}, () => {});
    return { ...(await write) };
  }

  async resetConfig(): Promise<ServerConfig> {
    await this.init();
    const defaults = this.getDefaultConfig();
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      for (const key of Object.keys(latest)) delete latest[key];
      Object.assign(latest, defaults);
    }));
    this.writeChain = write.then(() => {}, () => {});
    return { ...(await write) };
  }

  isFirstRun(): boolean {
    return this._isFirstRun;
  }

  async getOrCreateClientId(): Promise<string> {
    const { randomUUID } = await import('crypto');
    if (this.failedSaves > 0) {
      const clientId = this.config.clientId || randomUUID();
      return await this.updateValueNonBlocking('clientId', (current) => current || clientId);
    }
    return await this.updateValue('clientId', (current) => current || randomUUID());
  }
}

export const configManager = new ConfigManager();
