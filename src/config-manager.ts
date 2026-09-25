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

// Desktop Commander 0.2.48 and older write config.json in place, so while such
// a version runs alongside, the file can be empty or partly written for a
// moment: up to ~260ms measured on Windows (#697). A file that does not parse
// is read again until it does, for up to this long; then it counts as damaged.
const PARTIAL_CONFIG_WAIT_MS = 1_000;
// While background saves are held because config.json can't be written, how
// often they are tried again
const HELD_SAVES_CHECK_MS = 5_000;

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
 * Where the array value of the config object's own `key` field starts (its '['),
 * or null. Only a top-level field counts: the scan tracks the open objects and
 * arrays, with strings skipped, so a nested object holding the same key (e.g.
 * {"usageStats":{"allowedDirectories":["/"]},"allowedDirectories":["/work"],…)
 * is never taken for it. The first top-level `key` decides.
 */
function topLevelArrayStart(text: string, key: string): number | null {
  const open: string[] = [];
  const colon = /\s*:\s*/y;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return null; // cut inside a string
      if (open.length === 1 && open[0] === '{') {
        colon.lastIndex = end + 1;
        const after = colon.exec(text);
        if (after && text.slice(i + 1, end) === key) {
          const value = end + 1 + after[0].length;
          return text[value] === '[' ? value : null;
        }
      }
      i = end + 1;
      continue;
    }
    if (char === '{' || char === '[') open.push(char);
    else if (char === '}' || char === ']') open.pop();
    i++;
  }
  return null;
}

function extractRecoverableStringArray(text: string, key: string): string[] | null {
  const start = topLevelArrayStart(text, key);
  if (start === null) return null;

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
  private pendingCorruptConfigTelemetry: CorruptConfigRecoveryTelemetry[] = [];
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
          // There, but reading it failed (e.g. no permission, #419): nothing to repair or create
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
      if (corruptConfigTelemetry) this.pendingCorruptConfigTelemetry.push(corruptConfigTelemetry);
    } catch (error) {
      console.error('Failed to initialize config:', error);
      if (damaged || unreadable) {
        // The repair itself failed (the corrupt file couldn't be copied, the
        // repaired config couldn't be written, the lock couldn't be taken), or the
        // file can't be read: the defaults' allowedDirectories [] would open the
        // whole filesystem (#419). Use what a repair would have written, for this
        // session only (from nothing, for a file that can't be read).
        this.config = this.recoveredConfig(damaged ? await this.readDamagedConfigText() : '');
        // Saves would fail the same way: held, and tried again every HELD_SAVES_CHECK_MS
        this.failedSaves = 1;
        this.holdSaves(); // the warning below says why
        const reason = error instanceof Error ? error.message : String(error);
        warnUser((damaged ? `config.json could not be read, and repairing it failed (${reason}). ` : `config.json could not be read (${reason}). `) +
          `For this session Desktop Commander uses the default settings with what it could recover: ` +
          `file tools only reach ${JSON.stringify(this.config.allowedDirectories)}` +
          (this.config.blockedCommands?.includes('*') ? ', every command is blocked' : '') +
          (this.config.telemetryEnabled === false ? ', telemetry stays off' : '') + '.');
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
      this.flushCorruptConfigTelemetry();
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

    const corruptText = await fs.readFile(this.configPath, 'utf8').catch(() => '');
    const recovered = this.recoveredConfig(corruptText);

    let backupCreated = false;
    if (existsSync(this.configPath)) {
      const backupPath = `${this.configPath}.corrupt.${Date.now()}.${process.pid}`;
      try {
        // A copy, not a move: if writing the repaired config below fails, config.json
        // stays as it was and the next start repairs it, instead of finding it missing
        // and taking it for a first run (allowedDirectories [] opens every folder).
        // A repair done again after such a failure keeps the copy it already made.
        if (!(await this.newestCorruptCopyMatches())) await fs.copyFile(this.configPath, backupPath);
        backupCreated = true;
      } catch (backupError) {
        console.error('Failed to preserve corrupt config before recovery:', backupError);
        throw backupError;
      }
    }

    await this.writeConfigAtomically(recovered);
    this.config = { ...recovered, version: VERSION };

    console.error(`Recovered corrupt config during ${phase}; using defaults${backupCreated ? ' and preserved the corrupt file' : ''}.`);
    return {
      config: recovered,
      telemetry: { ...forensics, backup_created: backupCreated, recovered_by_other_process: false },
    };
  }

  /**
   * The damaged config's text after a failed repair (which leaves config.json as
   * it was); '' when it can't be read (recoveredConfig then gives the closed policy).
   */
  private async readDamagedConfigText(): Promise<string> {
    return fs.readFile(this.configPath, 'utf8').catch((error) => {
      console.error('Failed to read the damaged config.json again:', error);
      return '';
    });
  }

  /**
   * What recovery writes in place of a corrupt config.json. While running: the
   * config last parsed from disk, every setting kept. At startup, when nothing
   * was parsed yet: the defaults, with the blocked commands and allowed folders
   * the damaged text still gives, else a closed policy.
   */
  private recoveredConfig(corruptText: string): ServerConfig {
    // Prefer the last parsed in-memory policy during runtime recovery. On startup,
    // salvage only complete string-array policy fields from the damaged JSON.
    // This keeps recovery narrow without introducing a persistent shadow config.
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

    const defaults = this.getDefaultConfig();
    // While running, the last parsed config is known: keep all of it (telemetry
    // off, line limits, shell, client id, ...), not only its policy lists
    if (this.initialized) {
      const { version: _version, ...lastParsed } = this.config;
      Object.assign(defaults, lastParsed);
    }
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
    return defaults;
  }

  /** Whether the newest config.json.corrupt.<ms>.<pid> copy holds config.json's bytes */
  private async newestCorruptCopyMatches(): Promise<boolean> {
    const folder = path.dirname(this.configPath);
    const prefix = `${path.basename(this.configPath)}.corrupt.`;
    const names = await fs.readdir(folder).catch(() => [] as string[]);
    // The newest has the largest <ms>
    const newest = names.filter((name) => name.startsWith(prefix))
      .sort((a, b) => parseInt(a.slice(prefix.length), 10) - parseInt(b.slice(prefix.length), 10))
      .pop();
    if (!newest) return false;
    const [copy, current] = await Promise.all([
      fs.readFile(path.join(folder, newest)).catch(() => null),
      fs.readFile(this.configPath),
    ]);
    return copy !== null && copy.equals(current);
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
        // The partial-write wait already ran before this was called: read once under the lock
        const latest = await this.readConfigFromDisk(0);
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
    await writeFileAtomic(this.configPath, JSON.stringify(config, null, 2));
  }

  private async acquireConfigLock(): Promise<() => Promise<void>> {
    return lockfile.lock(this.configPath, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
      // This process couldn't refresh the lock for 30 s (frozen: machine sleep, a
      // suspended process, a blocked event loop) and another one took it over or
      // removed it. The default throws from a timer, which ends the server; the
      // write in progress still commits atomically, and its release fails (logged).
      onCompromised: (error) => console.error(`The config lock was lost while held: ${error.message} (${(error as any).code})`),
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
          // Missing (a first start, or removed while running): start from the
          // defaults; `{}` would leave blockedCommands empty, blocking nothing
          latest = this.getDefaultConfig();
          existed = false;
        } else {
          throw error;
        }
      }
      mutate(latest, existed);
      await this.writeConfigAtomically(latest);
      this.config = { ...latest, version: VERSION };
      result = latest;
      // Written: whatever held saves before is solved
      this.failedSaves = 0;
      this.holdReported = false;
      this.resumeSaves();
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
      const mutations = this.pendingMutations.splice(0);
      if (mutations.length === 0) return;
      try {
        await this.performConfigMutation((latest) => {
          for (const mutate of mutations) mutate(latest);
        });
      } catch (error) {
        // Persistence failed before commit, so keep these mutations for a later retry.
        this.pendingMutations.unshift(...mutations);
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
   */
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
