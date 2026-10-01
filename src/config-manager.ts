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
import {
  keepDamagedCopy,
  RecoveryEvents,
  replacementConfig,
  sendRecoveryEvent,
  type CorruptConfigPhase,
  type CorruptConfigRecoveryTelemetry,
} from './config-recovery.js';

// Desktop Commander 0.2.48 and older write config.json in place, so while such
// a version runs alongside, the file can be empty or partly written for a
// moment: up to ~260ms measured on Windows (#697). A file that does not parse
// is read again until it does, for up to this long; then it counts as damaged.
const PARTIAL_CONFIG_WAIT_MS = 1_000;
// While background saves are held because config.json can't be written, how
// often they are tried again
const HELD_SAVES_CHECK_MS = 5_000;
// How many times one config write is done over when its lock was lost, or
// config.json changed, before it committed
const MAX_CONFIG_MUTATION_ATTEMPTS = 3;

/** A config write that didn't commit: its lock was lost, or config.json changed after it was read */
class ConfigChangedBeforeCommitError extends Error {
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
 * Parses config.json's text. Editors saving "UTF-8 with BOM" (Notepad,
 * PowerShell 5's Set-Content -Encoding UTF8) put U+FEFF first, which
 * JSON.parse rejects although the config is complete (#692).
 */
function parseConfig(text: string): ServerConfig {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * The one-time migration of a config written before the welcome page existed:
 * an existing install, so it never gets the welcome page.
 */
function migrateLegacyConfig(config: ServerConfig): void {
  if (config['welcomeOnboardingEligible'] === undefined) {
    config['welcomeOnboardingEligible'] = false;
    config['pendingWelcomeOnboarding'] = false;
  }
}

/**
 * A warning the user must see: as a log notification (console.warn inside the
 * MCP server), and on stderr, which `remote` shows in its terminal.
 */
function warnUser(message: string): void {
  console.warn(message);
  process.stderr.write(`[WARNING] Desktop Commander: ${message}\n`);
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
  private recoveryEvents = new RecoveryEvents((telemetry) => this.emitCorruptConfigTelemetry(telemetry));
  // True while background saves are held because config.json can't be written (see holdSaves)
  private savesHeld = false;
  // The hold is already logged or told to the user, until a write succeeds
  private holdReported = false;
  // Background saves that failed in a row (see scheduleSave)
  private failedSaves = 0;
  private heldSavesCheck: NodeJS.Timeout | null = null;

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
    let damaged = false;
    let unreadable = false;
    let read = false;
    try {
      const configDir = path.dirname(this.configPath);
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }

      try {
        this.config = await this.readConfigFromDisk();
        read = true;
        this._isFirstRun = false;
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          damaged = true;
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
          // There, but reading it failed (e.g. no permission, #419): nothing to replace or create
          unreadable = true;
          throw error;
        }
      }

      // Existing installs must not become welcome-page eligible merely because
      // their config had to be recovered.
      if (!this._isFirstRun && this.config['welcomeOnboardingEligible'] === undefined) {
        await this.performConfigMutation(migrateLegacyConfig);
      }

      this.config['version'] = VERSION;
      this.initialized = true;
      this.startConfigWatcher();
      if (corruptConfigTelemetry) this.recoveryEvents.record(corruptConfigTelemetry, false); // sent by the flush below
    } catch (error) {
      console.error('Failed to initialize config:', error);
      if (damaged || unreadable) {
        // Replacing the damaged config.json failed (its copy couldn't be made, the new
        // file couldn't be written, the lock couldn't be taken), or it can't be read at
        // all. It is left as it is, and this session uses what a replacement would have
        // written: the settings still readable in it and the defaults for the rest
        // (just the defaults, for a file that can't be read).
        const damagedText = damaged ? await fs.readFile(this.configPath, 'utf8').catch(() => '') : '';
        this.config = replacementConfig(this.getDefaultConfig(), null, damagedText);
        // Saves would fail the same way (one that can't read config.json writes
        // nothing): held, and tried again every HELD_SAVES_CHECK_MS
        this.failedSaves = 1;
        this.holdSaves(); // the warning below says why
        const reason = error instanceof Error ? error.message : String(error);
        warnUser(damaged
          ? `config.json could not be parsed, and replacing it failed (${reason}). For this session Desktop Commander uses the settings still readable in it and the defaults for the rest; config.json is left as it is.`
          : `config.json could not be read (${reason}). For this session Desktop Commander uses the default settings; config.json is left as it is.`);
      } else if (read && this.config && typeof this.config === 'object') {
        // Read, but a later step failed: the one-time migration's write (a read-only file
        // system, a full disk, a lock that can't be taken). The settings read stay in effect,
        // never the defaults' allowedDirectories [] (#419); changes wait until it is writable.
        migrateLegacyConfig(this.config);
        this.failedSaves = 1;
        this.holdSaves(); // the warning below says why
        this.queueMutation(migrateLegacyConfig);
        warnUser(`config.json was read, but saving to it failed (${error instanceof Error ? error.message : String(error)}). ` +
          `Desktop Commander uses the settings it read; changes to them can't be saved until config.json is writable.`);
      } else {
        this.config = this.getDefaultConfig();
      }
      this.initialized = true;
      this.startConfigWatcher();
    } finally {
      this.recoveryEvents.flush();
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
      defaultShell: getDefaultShell(),
      allowedDirectories: [],
      telemetryEnabled: true, // Default to opt-out approach (telemetry on by default)
      fileWriteLineLimit: 50,  // Default line limit for file write operations (changed from 100)
      fileReadLineLimit: 1000,  // Default line limit for file read operations (changed from character-based)
      pendingWelcomeOnboarding: true, // New install flag - triggers A/B test for welcome page
      welcomeOnboardingEligible: true // Distinguishes new installs from migrated legacy configs
    };
  }

  private async readConfigFromDisk(waitMs = PARTIAL_CONFIG_WAIT_MS): Promise<ServerConfig> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        return parseConfig(await fs.readFile(this.configPath, 'utf8'));
      } catch (error: any) {
        if (!(error instanceof SyntaxError) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  /** config.json's size, for the recovery event; null when it can't be read */
  private async configBytes(): Promise<number | null> {
    return (await fs.stat(this.configPath).catch(() => null))?.size ?? null;
  }

  /** Sends a recovery event (a method of its own, so tests can record the events instead) */
  private async emitCorruptConfigTelemetry(telemetry: CorruptConfigRecoveryTelemetry): Promise<void> {
    await sendRecoveryEvent(telemetry);
  }

  /**
   * Replaces a damaged config.json (the caller holds the config lock): keeps a copy
   * of it and writes replacementConfig() of its text (config-recovery.ts). Used at
   * startup, by the file watcher and by a write while running.
   */
  private async recoverCorruptConfigUnderLock(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    const damaged = await fs.readFile(this.configPath).catch(() => Buffer.alloc(0));
    const config = replacementConfig(this.getDefaultConfig(), this.initialized ? this.config : null, damaged.toString('utf8'));
    const copyName = await keepDamagedCopy(this.configPath, damaged);

    await this.writeConfigAtomically(config);
    this.config = { ...config, version: VERSION };

    console.error(`config.json could not be parsed (${error.message})${copyName ? `; kept as ${copyName}` : ''}; ` +
      'replaced with the settings still readable in it and the defaults for the rest.');
    return {
      config,
      telemetry: { phase, config_bytes: damaged.length, backup_created: copyName !== null, recovered_by_other_process: false },
    };
  }

  private async recoverCorruptConfig(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    // The size this process saw damaged: if another process replaces the file while
    // this one waits for the lock, it is all the event can say about it
    const observedBytes = await this.configBytes();
    const release = await this.acquireConfigLock();
    try {
      try {
        // The partial-write wait already ran before this was called: read once under the lock
        const latest = await this.readConfigFromDisk(0);
        return {
          config: latest,
          telemetry: { phase, config_bytes: observedBytes, backup_created: false, recovered_by_other_process: true },
        };
      } catch (latestError: any) {
        if (latestError instanceof SyntaxError) {
          // Still damaged under the lock: this process replaces it
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
          telemetry: { phase, config_bytes: observedBytes, backup_created: false, recovered_by_other_process: false },
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
      // is logged, and a write not yet committed is done again under a new lock
      // (performConfigMutation). Its release then fails (logged).
      onCompromised: (error) => {
        console.error(`The config lock was lost while held: ${error.message} (${(error as any).code})`);
        onLost?.();
      },
    });
  }

  /**
   * Read config.json, apply `mutate`, write it back, all under the cross-process
   * lock. If the lock was lost, or config.json changed, before the write
   * committed, nothing was written: the whole read, change and write runs again
   * under a new lock, so the change lands on what the other process saved.
   */
  private async performConfigMutation(
    mutate: (config: ServerConfig, existed: boolean) => void
  ): Promise<ServerConfig> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.performConfigMutationOnce(mutate);
      } catch (error) {
        if (!(error instanceof ConfigChangedBeforeCommitError) || attempt >= MAX_CONFIG_MUTATION_ATTEMPTS) throw error;
      }
    }
  }

  private async performConfigMutationOnce(
    mutate: (config: ServerConfig, existed: boolean) => void
  ): Promise<ServerConfig> {
    let lockLost = false;
    const release = await this.acquireConfigLock(() => { lockLost = true; });
    let result: ServerConfig | null = null;
    let corruptConfigTelemetry: CorruptConfigRecoveryTelemetry | null = null;
    // Changes held from earlier writes that didn't save: older than this one, so
    // applied first, and kept for later if this write doesn't commit either
    let held: Array<(config: ServerConfig) => void> = [];
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
          // Missing (a first start, or removed while running): start from the
          // defaults; `{}` would leave blockedCommands empty, blocking nothing
          latest = this.getDefaultConfig();
          existed = false;
        } else {
          throw error;
        }
      }
      // What config.json holds as read (or as replaced above): if it holds anything
      // else when the write is about to commit, another process saved meanwhile
      const readText = await this.readConfigText();
      held = this.pendingMutations.splice(0);
      for (const apply of held) apply(latest);
      mutate(latest, existed);
      await this.writeConfigAtomically(latest, async () => {
        if (lockLost || await this.readConfigText() !== readText) throw new ConfigChangedBeforeCommitError();
      });
      this.config = { ...latest, version: VERSION };
      result = latest;
      held = [];
      // Written: whatever held saves before is solved
      this.failedSaves = 0;
      this.holdReported = false;
      this.resumeSaves();
    } finally {
      // Not written: the held changes go back, ahead of any queued meanwhile
      if (held.length > 0) this.pendingMutations.unshift(...held);
      try {
        await release();
      } catch (error) {
        // The atomic rename is the commit boundary. A release failure after it
        // must not make callers replay a mutation that already persisted.
        console.error('Failed to release config lock:', error);
      }
      if (corruptConfigTelemetry) this.recoveryEvents.record(corruptConfigTelemetry, this.initialized);
    }
    if (!result) throw new Error('Config mutation completed without a result');
    return result;
  }

  /**
   * Keep the queued changes instead of retrying them every 250 ms against a
   * config.json that can't be written (a read-only file system, a full disk, a
   * lock that can't be taken, a file that can't be read): every
   * HELD_SAVES_CHECK_MS they are tried again; a save that still fails holds them
   * again. `error` is logged once per problem (without it, the caller told the user).
   */
  private holdSaves(error?: unknown): void {
    if (this.savesHeld) return;
    this.savesHeld = true;
    if (error && !this.holdReported) {
      console.error("config.json can't be written, so changes are kept and saved once it can:", error);
    }
    this.holdReported = true;
    this.heldSavesCheck = setInterval(() => this.resumeSaves(), HELD_SAVES_CHECK_MS);
    this.heldSavesCheck.unref?.();
  }

  /** Save the changes held meanwhile. */
  private resumeSaves(): void {
    if (!this.savesHeld) return;
    this.savesHeld = false;
    if (this.heldSavesCheck) clearInterval(this.heldSavesCheck);
    this.heldSavesCheck = null;
    if (this.pendingMutations.length > 0) this.scheduleSave();
  }

  private queueMutation(mutate: (config: ServerConfig) => void): void {
    this.pendingMutations.push(mutate);
    this.scheduleSave();
  }

  /** Non-blocking, coalesced persistence for high-frequency state updates. */
  scheduleSave(): void {
    if (this.saveScheduled || this.savesHeld) return;
    this.saveScheduled = true;
    const write = this.writeChain.then(async () => {
      this.saveScheduled = false;
      // A write in between may have saved them already
      if (this.pendingMutations.length === 0) return;
      try {
        // Saves the queued changes: every config write applies them first
        await this.performConfigMutation(() => {});
      } catch (error) {
        // Persistence failed before commit: performConfigMutation kept the changes for a later retry.
        // A failure can be brief (a lock, a file scanner): retried once after 250 ms. A second
        // one in a row (a read-only file system, a full disk) holds the changes for the
        // HELD_SAVES_CHECK_MS check instead of retrying every 250 ms
        if (++this.failedSaves > 1) {
          this.holdSaves(error);
          return;
        }
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
          this.recoveryEvents.record(recovery.telemetry, this.initialized);
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
   * holdIfNotSaved: if the save fails, the value is in effect all the same and
   * held, to be saved in its place among later writes (the call still rejects).
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
      // Held here, before the next write in the chain starts: a later value of the
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
    if (this.savesHeld) {
      // Can't be written now: keep one for the session, saved with the held changes
      const clientId = this.config.clientId || randomUUID();
      return await this.updateValueNonBlocking('clientId', (current) => current || clientId);
    }
    return await this.updateValue('clientId', (current) => current || randomUUID());
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
