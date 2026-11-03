import fs from 'fs/promises';
import path from 'path';
import { existsSync, watch, type FSWatcher } from 'fs';
import { mkdir } from 'fs/promises';
import os from 'os';
import lockfile from 'proper-lockfile';
import { VERSION } from './version.js';
import { CONFIG_FILE } from './config.js';
import { getDefaultShell } from './utils/shell.js';
import { writeFileAtomic } from './utils/atomic-write.js';
import { backupCorruptConfig, buildRecoveredConfig, type RecoveryEvent, type RecoveryPhase } from './config-recovery.js';

// Desktop Commander 0.2.48 and older write config.json in place, so while such
// a version runs alongside, the file can be empty or partly written for a
// moment: up to ~260ms measured on Windows (#697). A file that does not parse
// is read again until it does, for up to this long and at least this many
// reads (a start that freezes spends the time without reading); then it counts
// as corrupt. 30 reads 10 ms apart span longer than any empty moment measured.
const PARTIAL_CONFIG_WAIT_MS = 1_000;
const PARTIAL_CONFIG_MIN_FAILED_READS = 30;
// A failed background save is tried again after SAVE_RETRY_MS. If it fails again
// (a read-only file system, a full disk), it is tried every HELD_SAVE_RETRY_MS.
const SAVE_RETRY_MS = 250;
const HELD_SAVE_RETRY_MS = 5_000;
// How many times a config write runs again when its lock was lost, or
// config.json changed, before it committed
const MAX_CONFIG_WRITE_ATTEMPTS = 3;

/** Thrown when the lock was lost, or config.json changed, before a config write committed */
class ConfigChangedError extends Error {
  constructor() {
    super('config.json changed, or its lock was lost, before this write committed');
  }
}

export interface ServerConfig {
  blockedCommands?: string[];
  defaultShell?: string;
  allowedDirectories?: string[];
  telemetryEnabled?: boolean; // New field for telemetry control
  fileWriteLineLimit?: number; // Line limit for file write operations
  fileReadLineLimit?: number; // Default line limit for file read operations (changed from character-based)
  clientId?: string; // Unique client identifier for analytics
  currentClient?: ClientInfo; // Current connected client information
  [key: string]: any; // Allow for arbitrary configuration keys (including abTest_* keys)
}

export interface ClientInfo {
  name: string;
  version: string;
}

type CorruptConfigPhase = 'startup' | 'mutation' | 'watcher';

interface CorruptConfigRecoveryTelemetry {
  phase: CorruptConfigPhase;
  parse_error_kind: 'truncated' | 'invalid_json';
  config_bytes: number | null;
  config_age_bucket: '<1s' | '<1m' | '<1h' | '>=1h' | 'unknown';
  temp_file_count: number;
  persisted_version: string;
  backup_created: boolean;
  recovered_by_other_process: boolean;
}

export function normalizeTelemetryEnabledValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

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

/**
 * Parses config.json's text. Editors saving "UTF-8 with BOM" (Notepad,
 * PowerShell 5's Set-Content -Encoding UTF8) put U+FEFF first, which
 * JSON.parse rejects although the config is complete.
 */
export function parseConfig(text: string): ServerConfig {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Marks a config written before the welcome page existed as an existing install, which never gets it */
function migrateLegacyConfig(config: ServerConfig): void {
  if (config['welcomeOnboardingEligible'] === undefined) {
    config['welcomeOnboardingEligible'] = false;
    config['pendingWelcomeOnboarding'] = false;
  }
}

/**
 * Shows the user a warning, as a log notification (console.warn in the MCP
 * server) and on stderr, which `remote` shows in its terminal.
 */
function warnUser(message: string): void {
  console.warn(message);
  process.stderr.write(`[WARNING] Desktop Commander: ${message}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Singleton config manager for the server
 */
class ConfigManager {
  private configPath: string;
  private config: ServerConfig = {};
  private initialized = false;
  private _isFirstRun = false; // Track if this is the first run (config was just created)
  // Serializes all disk writes so concurrent saves can't corrupt config.json.
  private writeChain: Promise<void> = Promise.resolve();
  // True while a coalesced background write is already queued (see scheduleSave).
  private saveScheduled = false;
  private pendingMutations: Array<(config: ServerConfig) => void> = [];
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private pendingCorruptConfigTelemetry: CorruptConfigRecoveryTelemetry[] = [];
  // Background saves that failed in a row, and the timer that tries them again (see scheduleSave)
  private failedSaves = 0;
  private saveRetry: NodeJS.Timeout | null = null;
  // Recovery events from before init() finished, sent when it does (see reportRecovery)
  private heldRecoveryEvents: RecoveryEvent[] = [];

  constructor() {
    // Get user's home directory
    // Define config directory and file paths
    this.configPath = CONFIG_FILE;
  }

  /**
   * Initialize configuration - load from disk or create default.
   * Creation and legacy migration use the same cross-process mutation path as
   * normal writes so two processes starting together cannot clobber each other.
   */
  async init() {
    if (this.initialized) return;

    let corruptConfigTelemetry: CorruptConfigRecoveryTelemetry | null = null;
    try {
      const configDir = path.dirname(this.configPath);
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }

      try {
        this.config = await this.readConfigFromDisk();
        this._isFirstRun = false;
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          const recovery = await this.recoverCorruptConfig(error, 'startup');
          this.config = recovery.config;
          corruptConfigTelemetry = recovery.telemetry;
          this._isFirstRun = false;
        } else if (error?.code === 'ENOENT') {
          let created = false;
          await this.performConfigMutation((latest, existed) => {
            if (!existed) {
              Object.assign(latest, this.getDefaultConfig());
              created = true;
            }
          });
          this._isFirstRun = created;
        } else {
          throw error;
        }
      }

      // Existing installs must not become welcome-page eligible merely because
      // their config had to be recovered.
      if (!this._isFirstRun && this.config['welcomeOnboardingEligible'] === undefined) {
        await this.performConfigMutation((latest) => {
          if (latest['welcomeOnboardingEligible'] === undefined) {
            latest['welcomeOnboardingEligible'] = false;
            latest['pendingWelcomeOnboarding'] = false;
          }
        });
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
  }

  /**
   * Reads config.json at start. A missing one is created (a first run), a corrupt
   * one is recovered, and one written before the welcome page existed is marked
   * as an existing install. If it can't be read, recovered or saved, the session
   * starts without saving it.
   */
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
          config = await this.withConfigLock(() => this.recoverCorruptConfig('startup'));
        } catch (recoveryError) {
          // Left as it is, the next start recovers it
          const text = await fs.readFile(this.configPath, 'utf8').catch(() => '');
          return this.startWithoutSaving(buildRecoveredConfig(this.getDefaultConfig(), null, text),
            `config.json could not be parsed, and replacing it failed (${messageOf(recoveryError)}). For this session Desktop Commander uses the settings still readable in it and the defaults for the rest; config.json is left as it is.`);
        }
      } else {
        // There, but it can't be read (e.g. no permission): an existing install,
        // so the welcome page stays off, and initialize has nothing to save for it
        return this.startWithoutSaving(buildRecoveredConfig(this.getDefaultConfig(), null, ''),
          `config.json could not be read (${messageOf(error)}). For this session Desktop Commander uses the default settings; config.json is left as it is.`);
      }
    }

      this.config['version'] = VERSION;
      this.initialized = true;
      this.startConfigWatcher();
      if (corruptConfigTelemetry) this.pendingCorruptConfigTelemetry.push(corruptConfigTelemetry);
    } catch (error) {
      console.error('Failed to initialize config:', error);
      this.config = this.getDefaultConfig();
      this.initialized = true;
      this.startConfigWatcher();
    } finally {
      this.flushCorruptConfigTelemetry();
    if (!this._isFirstRun && config['welcomeOnboardingEligible'] === undefined) {
      try {
        config = await this.performConfigMutation(migrateLegacyConfig);
      } catch (error) {
        // The settings read stay in effect, not the defaults, which allow every folder
        migrateLegacyConfig(config);
        this.pendingMutations.push(migrateLegacyConfig);
        return this.startWithoutSaving(config, `config.json was read, but saving to it failed (${messageOf(error)}). ` +
          `Desktop Commander uses the settings it read; changes to them can't be saved until config.json is writable.`);
      }
    }
    return config;
  }

  /**
   * Starts the session on `config` and leaves config.json as it is. `warning`
   * tells the user why; saves are tried again every HELD_SAVE_RETRY_MS.
   */
  private startWithoutSaving(config: ServerConfig, warning: string): ServerConfig {
    // As after a second failed save, whose log line the warning stands for
    this.failedSaves = 2;
    this.retrySaves(HELD_SAVE_RETRY_MS);
    warnUser(warning);
    return config;
  }

  /**
   * Alias for init() to maintain backward compatibility
   */
  async loadConfig() {
    return this.init();
  }

  /**
   * Create default configuration
   */
  private getDefaultConfig(): ServerConfig {
    return {
      blockedCommands: [

        // Disk and partition management
        "mkfs",      // Create a filesystem on a device
        "format",    // Format a storage device (cross-platform)
        "mount",     // Mount a filesystem
        "umount",    // Unmount a filesystem
        "fdisk",     // Manipulate disk partition tables
        "dd",        // Convert and copy files, can write directly to disks
        "parted",    // Disk partition manipulator
        "diskpart",  // Windows disk partitioning utility
        
        // System administration and user management
        "sudo",      // Execute command as superuser
        "su",        // Substitute user identity
        "passwd",    // Change user password
        "adduser",   // Add a user to the system
        "useradd",   // Create a new user
        "usermod",   // Modify user account
        "groupadd",  // Create a new group
        "chsh",      // Change login shell
        "visudo",    // Edit the sudoers file
        
        // System control
        "shutdown",  // Shutdown the system
        "reboot",    // Restart the system
        "halt",      // Stop the system
        "poweroff",  // Power off the system
        "init",      // Change system runlevel
        
        // Network and security
        "iptables",  // Linux firewall administration
        "firewall",  // Generic firewall command
        "netsh",     // Windows network configuration
        
        // Windows system commands
        "sfc",       // System File Checker
        "bcdedit",   // Boot Configuration Data editor
        "reg",       // Windows registry editor
        "net",       // Network/user/service management
        "sc",        // Service Control manager
        "runas",     // Execute command as another user
        "cipher",    // Encrypt/decrypt files or wipe data
        "takeown"    // Take ownership of files
      ],
      defaultShell: getDefaultShell(),
      allowedDirectories: [],
      telemetryEnabled: true, // Default to opt-out approach (telemetry on by default)
      fileWriteLineLimit: 50,  // Default line limit for file write operations (changed from 100)
      fileReadLineLimit: 1000,  // Default line limit for file read operations (changed from character-based)
      pendingWelcomeOnboarding: true, // New install flag - triggers A/B test for welcome page
      welcomeOnboardingEligible: true // Distinguishes new installs from migrated legacy configs
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

    // Node's newer JSON parser often reports an "Expected ... at position N"
    // error for truncation. If the failure position is at the end of the file,
    // classify it as truncation rather than a malformed token in the middle.
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

  private async inspectCorruptConfig(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<Omit<CorruptConfigRecoveryTelemetry, 'backup_created' | 'recovered_by_other_process'>> {
    const [stat, corruptText] = await Promise.all([
      fs.stat(this.configPath).catch(() => null),
      fs.readFile(this.configPath, 'utf8').catch(() => ''),
    ]);
    const configDir = path.dirname(this.configPath);
    const configName = path.basename(this.configPath);
    const entries = await fs.readdir(configDir).catch(() => [] as string[]);
    const tempFileCount = entries.filter((name) =>
      name.startsWith(`${configName}.`) && name.endsWith('.tmp')
    ).length;
    const persistedVersion = /"version"\s*:\s*"([0-9A-Za-z._+-]{1,32})"/.exec(corruptText)?.[1] ?? 'unknown';

    return {
      phase,
      parse_error_kind: this.classifyConfigParseError(error, corruptText),
      config_bytes: stat?.size ?? null,
      config_age_bucket: this.configAgeBucket(stat?.mtimeMs ?? null),
      temp_file_count: tempFileCount,
      persisted_version: persistedVersion,
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
    const pending = this.pendingCorruptConfigTelemetry.splice(0);
    for (const telemetry of pending) void this.emitCorruptConfigTelemetry(telemetry);
  }

  private async emitCorruptConfigTelemetry(telemetry: CorruptConfigRecoveryTelemetry): Promise<void> {
    try {
      const { capture } = await import('./utils/capture.js');
      await capture('config_parse_error_recovered', telemetry);
    } catch {
      // Recovery must never depend on telemetry delivery.
    }
  }

  private async recoverCorruptConfigUnderLock(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    const forensics = await this.inspectCorruptConfig(error, phase);

    // Prefer the last parsed in-memory policy during runtime recovery. On startup,
    // salvage only complete string-array policy fields from the damaged JSON.
    // This keeps recovery narrow without introducing a persistent shadow config.
    const corruptText = await fs.readFile(this.configPath, 'utf8').catch(() => '');
    const clientIdMatch = corruptText.match(/"clientId"\s*:\s*"([0-9a-fA-F-]{36})"/);
    const preservedClientId = clientIdMatch?.[1];
    const telemetryWasDisabled = /"telemetryEnabled"\s*:\s*false\b/.test(corruptText);
    const inMemoryBlockedCommands = Array.isArray(this.config.blockedCommands)
      && this.config.blockedCommands.every((item) => typeof item === 'string')
      ? this.config.blockedCommands : null;
    const inMemoryAllowedDirectories = Array.isArray(this.config.allowedDirectories)
      && this.config.allowedDirectories.every((item) => typeof item === 'string')
      ? this.config.allowedDirectories : null;
    const preservedBlockedCommands = inMemoryBlockedCommands
      ?? extractRecoverableStringArray(corruptText, 'blockedCommands');
    const preservedAllowedDirectories = inMemoryAllowedDirectories
      ?? extractRecoverableStringArray(corruptText, 'allowedDirectories');

    let backupCreated = false;
    if (existsSync(this.configPath)) {
      const backupPath = `${this.configPath}.corrupt.${Date.now()}.${process.pid}`;
      try {
        await fs.rename(this.configPath, backupPath);
        backupCreated = true;
      } catch (backupError) {
        console.error('Failed to preserve corrupt config before recovery:', backupError);
        throw backupError;
      }
    }

    const defaults = this.getDefaultConfig();
    if (preservedClientId) defaults['clientId'] = preservedClientId;
    if (telemetryWasDisabled) defaults['telemetryEnabled'] = false;
    if (preservedBlockedCommands !== null) {
      defaults['blockedCommands'] = [...preservedBlockedCommands];
    } else {
      // We cannot know a user's custom blocklist from an incomplete value.
      // `*` is treated by command validation as deny-all until the user resets it.
      defaults['blockedCommands'] = ['*'];
    }
    if (preservedAllowedDirectories !== null) {
      defaults['allowedDirectories'] = [...preservedAllowedDirectories];
    } else {
      // Never turn an unknown prior allowlist into unrestricted filesystem access.
      defaults['allowedDirectories'] = [path.dirname(this.configPath)];
    }
    // This is an existing install, not a first run. Do not replay onboarding.
    defaults['welcomeOnboardingEligible'] = false;
    defaults['pendingWelcomeOnboarding'] = false;
    await this.writeConfigAtomically(defaults);
    this.config = { ...defaults, version: VERSION };

    console.error(`Recovered corrupt config during ${phase}; using defaults${backupCreated ? ' and preserved the corrupt file' : ''}.`);
    return {
      config: defaults,
      telemetry: { ...forensics, backup_created: backupCreated, recovered_by_other_process: false },
    };
  }

  private async recoverCorruptConfig(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    // Keep a snapshot of what this process originally observed. If another
    // process repairs the file while we wait for the lock, this is the only
    // evidence of the corruption this process saw.
    const observedForensics = await this.inspectCorruptConfig(error, phase);
    const release = await this.acquireConfigLock();
    try {
      try {
        const latest = await this.readConfigFromDisk();
        return {
          config: latest,
          telemetry: { ...observedForensics, backup_created: false, recovered_by_other_process: true },
        };
      } catch (latestError: any) {
        if (latestError instanceof SyntaxError) {
          // The file is still corrupt under the lock. Inspect it again so the
          // forensic fields correspond to the exact snapshot we are replacing.
          return await this.recoverCorruptConfigUnderLock(latestError, phase);
        }
        if (latestError?.code !== 'ENOENT') throw latestError;

        const defaults = this.getDefaultConfig();
        defaults['welcomeOnboardingEligible'] = false;
        defaults['pendingWelcomeOnboarding'] = false;
        await this.writeConfigAtomically(defaults);
        this.config = { ...defaults, version: VERSION };
        return {
          config: defaults,
          telemetry: { ...observedForensics, backup_created: false, recovered_by_other_process: false },
        };
      }
    } finally {
      try {
        await release();
      } catch (releaseError) {
        console.error('Failed to release config lock after corruption recovery:', releaseError);
      }
    }
  }

  private async writeConfigAtomically(config: ServerConfig): Promise<void> {
    const tempPath = `${this.configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  /**
   * Recovers a corrupt config.json; the caller holds the config lock. It is backed
   * up once, then rewritten as buildRecoveredConfig(). Returns the config now on disk.
   */
  private async recoverCorruptConfig(phase: RecoveryPhase): Promise<ServerConfig> {
    const bytes = await fs.readFile(this.configPath).catch((error) => {
      if (error?.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    const text = bytes.toString('utf8');
    let parseError: Error;
    try {
      const config = parseConfig(text);
      // Another process recovered it while this one waited for the lock
      this.reportRecovery({ phase, config_bytes: null, backup_created: false, recovered_by_other_process: true });
      return config;
    } catch (error) {
      parseError = error as Error;
    }

    const backupName = await backupCorruptConfig(this.configPath, bytes);
    const config = buildRecoveredConfig(this.getDefaultConfig(), this.initialized ? this.config : null, text);
    await this.writeConfigAtomically(config);
    this.config = { ...config, version: VERSION };
    console.error(`config.json could not be parsed (${parseError.message})${backupName ? `; kept as ${backupName}` : ''}; ` +
      'replaced with the settings still readable in it and the defaults for the rest.');
    this.reportRecovery({ phase, config_bytes: bytes.length, backup_created: backupName !== null, recovered_by_other_process: false });
    return config;
  }

  /** Sends a recovery event. Telemetry reads the config, so events from before init() is done wait for it. */
  private reportRecovery(event: RecoveryEvent): void {
    if (this.initialized) void this.emitCorruptConfigTelemetry(event);
    else this.heldRecoveryEvents.push(event);
  }

  private async emitCorruptConfigTelemetry(event: RecoveryEvent): Promise<void> {
    try {
      const { capture } = await import('./utils/capture.js');
      await capture('config_parse_error_recovered', event);
    } catch {
      // Recovery never depends on telemetry
    }
  }

  private async writeConfigAtomically(config: ServerConfig, beforeCommit?: () => Promise<void>): Promise<void> {
    await writeFileAtomic(this.configPath, JSON.stringify(config, null, 2), { beforeCommit });
  }

  /** config.json's text, or null when there is none */
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
      // This process couldn't refresh the lock for 30 s (frozen: machine sleep, a
      // suspended process, a blocked event loop) and another one took it over or
      // removed it. The default throws from a timer, which ends the server; here it
      // is logged, and a write not yet committed runs again under a new lock
      // (performConfigMutation). Its release then fails (logged).
      onCompromised: (error) => {
        console.error(`The config lock was lost while held: ${error.message} (${(error as any).code})`);
        onLost?.();
      },
    });
  }

  private async performConfigMutation(
    mutate: (config: ServerConfig, existed: boolean) => void
  ): Promise<ServerConfig> {
    const release = await this.acquireConfigLock();
    let result: ServerConfig | null = null;
    let corruptConfigTelemetry: CorruptConfigRecoveryTelemetry | null = null;
    try {
      let latest: ServerConfig;
      let existed = true;
      try {
        latest = await this.readConfigFromDisk();
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          const recovery = await this.recoverCorruptConfigUnderLock(error, 'mutation');
          latest = recovery.config;
          corruptConfigTelemetry = recovery.telemetry;
        } else if (error?.code === 'ENOENT') {
          latest = {};
          existed = false;
        } else {
          throw error;
        }
      }
      mutate(latest, existed);
      await this.writeConfigAtomically(latest);
      this.config = { ...latest, version: VERSION };
      result = latest;
  /** Runs `fn` holding the config lock; `lockLost()` tells whether the lock was lost meanwhile. */
  private async withConfigLock<T>(fn: (lockLost: () => boolean) => Promise<T>): Promise<T> {
    let lost = false;
    const release = await this.acquireConfigLock(() => { lost = true; });
    try {
      return await fn(() => lost);
    } finally {
      try {
        await release();
      } catch (error) {
        // The atomic rename is the commit boundary. A release failure after it
        // must not make callers replay a mutation that already persisted.
        console.error('Failed to release config lock:', error);
      }
      if (corruptConfigTelemetry) this.recordCorruptConfigTelemetry(corruptConfigTelemetry);
    }
    if (!result) throw new Error('Config mutation completed without a result');
    return result;
  }

  /**
   * Read config.json, apply `mutate`, write it back, all under the cross-process
   * lock. If the lock was lost, or config.json changed, before the write
   * committed, nothing was written: it runs again under a new lock, so the
   * change lands on what the other process saved.
   */
  private async performConfigMutation(
    mutate: (config: ServerConfig, existed: boolean) => void
  ): Promise<ServerConfig> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.withConfigLock((lockLost) => this.mutateLockedConfig(mutate, lockLost));
      } catch (error) {
        if (!(error instanceof ConfigChangedError) || attempt >= MAX_CONFIG_WRITE_ATTEMPTS) throw error;
      }
    }
  }

  private async mutateLockedConfig(
    mutate: (config: ServerConfig, existed: boolean) => void,
    lockLost: () => boolean
  ): Promise<ServerConfig> {
    let latest: ServerConfig;
    let existed = true;
    try {
      latest = await this.readConfigFromDisk();
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        latest = await this.recoverCorruptConfig('mutation');
      } else if (error?.code === 'ENOENT') {
        // Missing (a first start, or removed while running): start from the
        // defaults, as `{}` would leave blockedCommands empty, blocking nothing
        latest = this.getDefaultConfig();
        existed = false;
        if (this.initialized) {
          // Removed while running: still an existing install, which never gets the welcome page
          latest['welcomeOnboardingEligible'] = false;
          latest['pendingWelcomeOnboarding'] = false;
        }
      } else {
        throw error;
      }
    }
    // What config.json holds now. If it holds anything else when the write is
    // about to commit, another process saved meanwhile.
    const readText = await this.readConfigText();
    // Queued changes are older than this one, so they apply first; if this
    // write fails, they are queued again
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
    // Saves work again, so queued changes needn't wait for a retry
    this.failedSaves = 0;
    if (this.saveRetry) this.retrySaves(0);
    return latest;
  }

  private queueMutation(mutate: (config: ServerConfig) => void): void {
    this.pendingMutations.push(mutate);
    this.scheduleSave();
  }

  /** Non-blocking, coalesced persistence for high-frequency state updates. */
  scheduleSave(): void {
    if (this.saveScheduled || this.saveRetry) return;
    this.saveScheduled = true;
    const write = this.writeChain.then(async () => {
      this.saveScheduled = false;
      // A write in between may have saved them already
      if (this.pendingMutations.length === 0) return;
      try {
        // Every config write applies the queued changes first
        await this.performConfigMutation(() => {});
      } catch (error) {
        // The changes stay queued. A brief failure (a lock, a file scanner) is
        // tried again soon, a lasting one (a read-only file system, a full disk)
        // every few seconds, and logged once.
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

  /** Saves the queued changes in `ms`; until then scheduleSave() waits for it */
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
        latest = await this.withConfigLock(() => this.recoverCorruptConfig('watcher'));
      }
      for (const mutate of this.pendingMutations) mutate(latest);
      this.config = { ...latest, version: VERSION };
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        try {
          const recovery = await this.recoverCorruptConfig(error, 'watcher');
          const latest = recovery.config;
          for (const mutate of this.pendingMutations) mutate(latest);
          this.config = { ...latest, version: VERSION };
          this.recordCorruptConfigTelemetry(recovery.telemetry);
        } catch (recoveryError) {
          console.error('Failed to recover corrupt config after file change:', recoveryError);
        }
      } else if (error?.code !== 'ENOENT') {
        console.error('Failed to reload config:', error);
      }
    }
  }

  /**
   * Get the entire config
   */
  async getConfig(): Promise<ServerConfig> {
    await this.init();
    return { ...this.config };
  }

  /**
   * Get a specific configuration value
   */
  async getValue(key: string): Promise<any> {
    await this.init();
    return this.config[key];
  }

  /**
   * Set a specific configuration value and wait until it is saved: the data is
   * flushed to disk before the rename; the folder flush after it is best effort.
   * With holdIfNotSaved, a value whose save fails is still in effect, and is
   * queued to be saved with later writes (the call still rejects).
   */
  async setValue(key: string, value: any, options: { holdIfNotSaved?: boolean } = {}): Promise<void> {
    await this.init();
    if (key === 'telemetryEnabled') value = normalizeTelemetryEnabledValue(value);

    if (key === 'telemetryEnabled' && isTelemetryDisabledValue(value)) {
      const currentValue: unknown = this.config[key];
      if (!isTelemetryDisabledValue(currentValue)) {
        const { capture } = await import('./utils/capture.js');
        await capture('server_telemetry_opt_out', { reason: 'user_disabled', prev_value: currentValue });
      }
    }

    const nextValue = value;
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      latest[key] = nextValue;
    }).catch((error) => {
      // Queued before the next write in the chain starts, so a later value of the
      // same key is applied after it and wins
      if (options.holdIfNotSaved) {
        this.config[key] = nextValue;
        this.queueMutation((latest) => { latest[key] = nextValue; });
      }
      throw error;
    }));
    this.writeChain = write.then(() => {}, () => {});
    await write;
  }

  /**
   * Update one value under the cross-process lock and return it once saved: the
   * data is flushed to disk before the rename; the folder flush after it is best effort.
   */
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

  /**
   * Set a value without waiting on disk. The queued operation is applied to the
   * latest on-disk config while holding the cross-process lock.
   */
  async setValueNonBlocking(key: string, value: any): Promise<void> {
    await this.init();
    this.config[key] = value;
    this.queueMutation((latest) => { latest[key] = value; });
  }

  /**
   * Atomically update one value without blocking the caller on persistence.
   * The updater is replayed against the latest disk value under the lock, which
   * makes counter-style updates safe across multiple Desktop Commander processes.
   */
  async updateValueNonBlocking(key: string, updater: (current: any) => any): Promise<any> {
    await this.init();
    const next = updater(this.config[key]);
    this.config[key] = next;
    this.queueMutation((latest) => { latest[key] = updater(latest[key]); });
    return next;
  }

  /** Update multiple configuration values at once. */
  async updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig> {
    await this.init();
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      Object.assign(latest, updates);
    }));
    this.writeChain = write.then(() => {}, () => {});
    return { ...(await write) };
  }

  /** Reset configuration to defaults. This intentionally replaces all keys. */
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

  /**
   * Check if this is the first run (config file was just created)
   */
  isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /**
   * Get or create a persistent client ID for analytics and A/B tests
   */
  async getOrCreateClientId(): Promise<string> {
    const { randomUUID } = await import('crypto');
    if (this.failedSaves > 0) {
      // Saves fail until a write succeeds, so keep one for the session, saved with the queued changes
      const clientId = this.config.clientId || randomUUID();
      return await this.updateValueNonBlocking('clientId', (current) => current || clientId);
    }
    return await this.updateValue('clientId', (current) => current || randomUUID());
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
