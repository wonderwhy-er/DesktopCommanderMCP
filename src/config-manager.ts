import fs from 'fs/promises';
import path from 'path';
import { existsSync, watch, type FSWatcher } from 'fs';
import { mkdir } from 'fs/promises';
import os from 'os';
import lockfile from 'proper-lockfile';
import { VERSION } from './version.js';
import { CONFIG_FILE } from './config.js';

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
      }

      this.config['version'] = VERSION;
      this.initialized = true;
      this.startConfigWatcher();
      if (corruptConfigTelemetry) this.pendingCorruptConfigTelemetry.push(corruptConfigTelemetry);
      this.flushCorruptConfigTelemetry();
    } catch (error) {
      console.error('Failed to initialize config:', error);
      this.config = this.getDefaultConfig();
      this.initialized = true;
      this.startConfigWatcher();
    }
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
      defaultShell: (() => {
        if (os.platform() === 'win32') {
          return 'powershell.exe';
        }
        // Use user's actual shell from environment
        // On macOS, default to zsh (default since Catalina) since process.env.SHELL
        // may not be set when running inside Claude Desktop
        const fallbackShell = os.platform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
        const userShell = process.env.SHELL || fallbackShell;
        // Return just the shell path - we'll handle login shell flag elsewhere
        return userShell;
      })(),
      allowedDirectories: [],
      telemetryEnabled: true, // Default to opt-out approach (telemetry on by default)
      fileWriteLineLimit: 50,  // Default line limit for file write operations (changed from 100)
      fileReadLineLimit: 1000,  // Default line limit for file read operations (changed from character-based)
      pendingWelcomeOnboarding: true, // New install flag - triggers A/B test for welcome page
      welcomeOnboardingEligible: true // Distinguishes new installs from migrated legacy configs
    };
  }

  private async readConfigFromDisk(): Promise<ServerConfig> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      } catch (error: any) {
        lastError = error;
        if (error?.code === 'ENOENT') throw error;
        if (!(error instanceof SyntaxError) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError;
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
      await capture('server_config_parse_error_recovered', telemetry);
    } catch {
      // Recovery must never depend on telemetry delivery.
    }
  }

  private async recoverCorruptConfigUnderLock(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    const forensics = await this.inspectCorruptConfig(error, phase);

    // Preserve the two values that matter for privacy and analytics continuity
    // when they are still intact before the damaged portion of the JSON. Do not
    // attempt to salvage arbitrary settings from malformed JSON.
    const corruptText = await fs.readFile(this.configPath, 'utf8').catch(() => '');
    const clientIdMatch = corruptText.match(/"clientId"\s*:\s*"([0-9a-fA-F-]{36})"/);
    const preservedClientId = clientIdMatch?.[1];
    const telemetryWasDisabled = /"telemetryEnabled"\s*:\s*false\b/.test(corruptText);

    let backupCreated = false;
    if (existsSync(this.configPath)) {
      const backupPath = `${this.configPath}.corrupt.${Date.now()}.${process.pid}`;
      try {
        await fs.rename(this.configPath, backupPath);
        backupCreated = true;
      } catch (backupError) {
        console.error('Failed to preserve corrupt config before recovery:', backupError);
      }
    }

    const defaults = this.getDefaultConfig();
    if (preservedClientId) defaults['clientId'] = preservedClientId;
    if (telemetryWasDisabled) defaults['telemetryEnabled'] = false;
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
    try {
      await fs.writeFile(tempPath, JSON.stringify(config, null, 2), 'utf8');
      await fs.rename(tempPath, this.configPath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  private async acquireConfigLock(): Promise<() => Promise<void>> {
    return lockfile.lock(this.configPath, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 }
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
    } finally {
      try {
        await release();
      } catch (error) {
        // The atomic rename is the commit boundary. A release failure after it
        // must not make callers replay a mutation that already persisted.
        console.error('Failed to release config lock:', error);
      }
    }
    if (corruptConfigTelemetry) this.recordCorruptConfigTelemetry(corruptConfigTelemetry);
    if (!result) throw new Error('Config mutation completed without a result');
    return result;
  }

  private queueMutation(mutate: (config: ServerConfig) => void): void {
    this.pendingMutations.push(mutate);
    this.scheduleSave();
  }

  /** Non-blocking, coalesced persistence for high-frequency state updates. */
  scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    const write = this.writeChain.then(async () => {
      this.saveScheduled = false;
      const mutations = this.pendingMutations.splice(0);
      if (mutations.length === 0) return;
      try {
        await this.performConfigMutation((latest) => {
          for (const mutate of mutations) mutate(latest);
        });
      } catch (error) {
        // Persistence failed before commit, so keep these mutations for a later retry.
        this.pendingMutations.unshift(...mutations);
        console.error('Failed to save config (background), will retry:', error);
        const retry = setTimeout(() => this.scheduleSave(), 250);
        retry.unref?.();
      }
    });
    this.writeChain = write.catch(() => {});
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
      const latest = await this.readConfigFromDisk();
      for (const mutate of this.pendingMutations) mutate(latest);
      latest['version'] = VERSION;
      this.config = latest;
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

  /** Set a specific configuration value and wait for durable persistence. */
  async setValue(key: string, value: any): Promise<void> {
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
    }));
    this.writeChain = write.then(() => {}, () => {});
    await write;
  }

  /** Update one value under the cross-process lock and return the durable value. */
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
    return await this.updateValue('clientId', (current) => current || randomUUID());
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
