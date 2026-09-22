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

interface CorruptConfigSnapshot {
  buffer: Buffer;
  text: string;
  bytes: number | null;
  mtimeMs: number | null;
}

/**
 * Names the policy fields in a config that recovery filled in because it could
 * not restore the user's own. It rides in the config itself: the fallback
 * outlives the session that applied it, and every later start reads a valid
 * file with nothing about it left to notice.
 */
const RECOVERY_FAIL_CLOSED_KEY = 'recoveryFailClosedFields';

/** Copies of a damaged config are evidence, not an archive. */
const MAX_CORRUPT_BACKUPS = 5;

const PARTIAL_WRITE_ATTEMPTS = 5;
const PARTIAL_WRITE_RETRY_MS = 10;

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

/** Index just past a string token starting at `start`, or -1 if it never closes. */
function scanStringToken(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** Index just past the array opening at `start`, or -1 if it never closes. */
function scanArray(text: string, start: number): number {
  let depth = 0;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const stringEnd = scanStringToken(text, i);
      if (stringEnd === -1) return -1;
      i = stringEnd - 1;
      continue;
    }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return i + 1;
  }
  return -1;
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * A `blockedCommands` nested in some other object is not this install's policy,
 * and taking it would hand the user a policy they never set instead of the
 * fail-closed fallback. Only a key of the root object counts.
 */
function extractTopLevelStringArray(text: string, key: string): string[] | null {
  const rootStart = skipWhitespace(text, 0);
  if (text[rootStart] !== '{') return null;

  let depth = 0;

  for (let i = rootStart; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      const stringEnd = scanStringToken(text, i);
      if (stringEnd === -1) return null;
      const isCandidateKey = depth === 1 && text.slice(i + 1, stringEnd - 1) === key;
      i = stringEnd - 1;
      if (!isCandidateKey) continue;

      const colon = skipWhitespace(text, stringEnd);
      if (text[colon] !== ':') continue;

      const valueStart = skipWhitespace(text, colon + 1);
      if (text[valueStart] !== '[') return null;
      const valueEnd = scanArray(text, valueStart);
      if (valueEnd === -1) return null;

      try {
        const value = JSON.parse(text.slice(valueStart, valueEnd));
        return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
      } catch {
        return null;
      }
    }

    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      // Zero closes the root object; below zero the text has left it behind.
      if (--depth <= 0) return null;
    }
  }
  return null;
}

/** Salvage, fallback and the warning all read this table: one field, one entry. */
interface RecoverablePolicyField {
  key: string;
  failClosed: (configPath: string) => string[];
  failClosedEffect: (configPath: string) => string;
}

const RECOVERABLE_POLICY_FIELDS: ReadonlyArray<RecoverablePolicyField> = [
  {
    key: 'blockedCommands',
    // `*` is deny-all to command validation until the user resets it.
    failClosed: () => ['*'],
    failClosedEffect: () => 'all commands are blocked',
  },
  {
    key: 'allowedDirectories',
    // The narrowest this field can express: an empty list means unrestricted
    // (isPathAllowed). It holds config.json, so a write can lift it - the way
    // back for a user whose settings were lost.
    failClosed: (configPath) => [path.dirname(configPath)],
    failClosedEffect: (configPath) => `file access is limited to ${path.dirname(configPath)}`,
  },
];

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
    let corruptConfigObserved = false;
    let recoveredConfig: ServerConfig | null = null;
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
          corruptConfigObserved = true;
          const recovery = await this.recoverCorruptConfig(error, 'startup');
          this.config = recovery.config;
          recoveredConfig = recovery.config;
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
    } catch (error) {
      console.error('Failed to initialize config:', error);
      if (recoveredConfig) {
        // Recovery's result is already on disk, and it is the user's own policy.
        this.config = { ...recoveredConfig, version: VERSION };
      } else {
        this.config = this.getDefaultConfig();
        if (corruptConfigObserved) {
          // The defaults are the permissive ones - an empty allowlist is full
          // filesystem access - and the lost policy may have denied exactly that.
          this.applyFailClosedPolicy([...RECOVERABLE_POLICY_FIELDS]);
        }
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

  private async readConfigOnce(): Promise<ServerConfig> {
    return JSON.parse(await fs.readFile(this.configPath, 'utf8'));
  }

  /** Re-reads a parse failure: a cooperating writer may be mid-write. */
  private async readConfigFromDisk(): Promise<ServerConfig> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PARTIAL_WRITE_ATTEMPTS; attempt++) {
      try {
        return await this.readConfigOnce();
      } catch (error: any) {
        lastError = error;
        if (error?.code === 'ENOENT') throw error;
        if (!(error instanceof SyntaxError) || attempt === PARTIAL_WRITE_ATTEMPTS - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, PARTIAL_WRITE_RETRY_MS));
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

  /** Read once: recovery runs under a lock other processes are waiting on. */
  private async readCorruptSnapshot(): Promise<CorruptConfigSnapshot> {
    const [stat, buffer] = await Promise.all([
      fs.stat(this.configPath).catch(() => null),
      fs.readFile(this.configPath).catch(() => Buffer.alloc(0)),
    ]);
    return {
      buffer,
      text: buffer.toString('utf8'),
      bytes: stat?.size ?? null,
      mtimeMs: stat?.mtimeMs ?? null,
    };
  }

  private async listConfigDir(): Promise<string[]> {
    return fs.readdir(path.dirname(this.configPath)).catch(() => [] as string[]);
  }

  private inspectCorruptConfig(
    error: SyntaxError,
    phase: CorruptConfigPhase,
    snapshot: CorruptConfigSnapshot,
    entries: string[]
  ): Omit<CorruptConfigRecoveryTelemetry, 'backup_created' | 'recovered_by_other_process'> {
    const configName = path.basename(this.configPath);
    const tempFileCount = entries.filter((name) =>
      name.startsWith(`${configName}.`) && name.endsWith('.tmp')
    ).length;
    const persistedVersion = /"version"\s*:\s*"([0-9A-Za-z._+-]{1,32})"/.exec(snapshot.text)?.[1] ?? 'unknown';

    return {
      phase,
      parse_error_kind: this.classifyConfigParseError(error, snapshot.text),
      config_bytes: snapshot.bytes,
      config_age_bucket: this.configAgeBucket(snapshot.mtimeMs),
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

  /** Loaded on use: telemetry imports this module back. */
  private async captureEvent(event: string, properties?: unknown): Promise<void> {
    const { capture } = await import('./utils/capture.js');
    await capture(event, properties);
  }

  private async emitCorruptConfigTelemetry(telemetry: CorruptConfigRecoveryTelemetry): Promise<void> {
    try {
      // Named in #693: `error` keeps it in the MCP error rollup, and the prefix
      // is deliberately not `server_`, which reads as a tool event.
      await this.captureEvent('config_parse_error_recovered', telemetry);
    } catch {
      // Recovery must never depend on telemetry delivery.
    }
  }

  /**
   * Whether these bytes are preserved, by this call or an earlier one. The
   * damaged file stays where it is, so a start that fails again meets the same
   * bytes: copying them every time would fill the config directory.
   */
  private async preserveCorruptConfig(snapshot: CorruptConfigSnapshot, entries: string[]): Promise<boolean> {
    const prefix = `${path.basename(this.configPath)}.corrupt.`;
    const configDir = path.dirname(this.configPath);
    const existing = await Promise.all(entries
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        const stat = await fs.stat(path.join(configDir, name)).catch(() => null);
        return { name, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? -1 };
      }));

    // Bytes, not decoded text: two files that decode to the same replacement
    // characters are still two different pieces of evidence.
    for (const { name, size } of existing) {
      if (size !== snapshot.buffer.length) continue;
      const kept = await fs.readFile(path.join(configDir, name)).catch(() => null);
      if (kept && Buffer.compare(kept, snapshot.buffer) === 0) return true;
    }

    await fs.copyFile(this.configPath, `${this.configPath}.corrupt.${Date.now()}.${process.pid}`);

    const stale = existing
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(MAX_CORRUPT_BACKUPS - 1);
    for (const { name } of stale) {
      await fs.unlink(path.join(configDir, name)).catch(() => {});
    }
    return true;
  }

  private async recoverCorruptConfigUnderLock(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    const snapshot = await this.readCorruptSnapshot();
    const entries = await this.listConfigDir();
    const forensics = this.inspectCorruptConfig(error, phase, snapshot, entries);

    // In-memory policy first: on startup there is none, and the damaged text is
    // all there is to salvage from.
    const corruptText = snapshot.text;
    const clientIdMatch = corruptText.match(/"clientId"\s*:\s*"([0-9a-fA-F-]{36})"/);
    const preservedClientId = clientIdMatch?.[1];
    const telemetryWasDisabled = /"telemetryEnabled"\s*:\s*false\b/.test(corruptText);
    const preservedPolicy = new Map<string, string[] | null>();
    for (const field of RECOVERABLE_POLICY_FIELDS) {
      const inMemory = this.config[field.key];
      preservedPolicy.set(field.key, Array.isArray(inMemory)
        && inMemory.every((item) => typeof item === 'string')
        ? [...inMemory]
        : extractTopLevelStringArray(corruptText, field.key));
    }

    let backupCreated = false;
    if (existsSync(this.configPath)) {
      try {
        backupCreated = await this.preserveCorruptConfig(snapshot, entries);
      } catch (backupError) {
        console.error('Failed to preserve corrupt config before recovery:', backupError);
        throw backupError;
      }
    }

    const defaults = this.getDefaultConfig();
    if (preservedClientId) defaults['clientId'] = preservedClientId;
    if (telemetryWasDisabled) defaults['telemetryEnabled'] = false;
    const failedClosed: RecoverablePolicyField[] = [];
    for (const field of RECOVERABLE_POLICY_FIELDS) {
      const preserved = preservedPolicy.get(field.key);
      if (preserved) {
        defaults[field.key] = preserved;
      } else {
        defaults[field.key] = field.failClosed(this.configPath);
        failedClosed.push(field);
      }
    }
    // This is an existing install, not a first run. Do not replay onboarding.
    defaults['welcomeOnboardingEligible'] = false;
    defaults['pendingWelcomeOnboarding'] = false;
    // A fallback that is damaged again salvages as an ordinary policy, so a mark
    // carried in from the damaged config counts alongside what just failed.
    const carriedMark = Array.isArray(this.config[RECOVERY_FAIL_CLOSED_KEY])
      ? this.config[RECOVERY_FAIL_CLOSED_KEY] as string[]
      : extractTopLevelStringArray(corruptText, RECOVERY_FAIL_CLOSED_KEY) ?? [];
    const marked = RECOVERABLE_POLICY_FIELDS
      .filter((field) => failedClosed.includes(field) || carriedMark.includes(field.key))
      .map((field) => field.key);
    const stillFailClosed = this.failClosedFieldsIn({ ...defaults, [RECOVERY_FAIL_CLOSED_KEY]: marked });
    const recovered = this.markFailClosed(defaults, stillFailClosed);
    await this.writeConfigAtomically(recovered);
    this.config = { ...recovered, version: VERSION };

    console.error(`Recovered corrupt config during ${phase}; using defaults${backupCreated ? ' and preserved the corrupt file' : ''}.`);
    if (stillFailClosed.length > 0) console.error(this.failClosedNotice(stillFailClosed));
    return {
      config: recovered,
      telemetry: { ...forensics, backup_created: backupCreated, recovered_by_other_process: false },
    };
  }

  /**
   * The mark leads the config it describes. Truncation eats a file from the end,
   * so a mark written behind the policy is what a cut takes first, leaving
   * deny-all values that read as a policy nobody has to explain.
   */
  private markFailClosed(config: ServerConfig, fields: RecoverablePolicyField[]): ServerConfig {
    if (fields.length === 0) return config;
    return { [RECOVERY_FAIL_CLOSED_KEY]: fields.map((field) => field.key), ...config };
  }

  private applyFailClosedPolicy(fields: RecoverablePolicyField[]): void {
    for (const field of fields) this.config[field.key] = field.failClosed(this.configPath);
    this.config = this.markFailClosed(this.config, fields);
    console.error(this.failClosedNotice(fields));
  }

  /** The marked fields whose values are still recovery's, not the user's. */
  private failClosedFieldsIn(config: ServerConfig): RecoverablePolicyField[] {
    const marked = config[RECOVERY_FAIL_CLOSED_KEY];
    if (!Array.isArray(marked) || marked.length === 0) return [];
    return RECOVERABLE_POLICY_FIELDS.filter((field) => {
      if (!marked.includes(field.key)) return false;
      const current = config[field.key];
      const failClosed = field.failClosed(this.configPath);
      return Array.isArray(current)
        && current.length === failClosed.length
        && current.every((item, index) => item === failClosed[index]);
    });
  }

  /** The fallback sentence when the policy in force is recovery's, else null. */
  failClosedExplanation(): string | null {
    const fields = this.failClosedFieldsIn(this.config);
    return fields.length > 0 ? this.failClosedNotice(fields) : null;
  }

  /**
   * A refusal, carrying that sentence when it applies. stderr is not where the
   * user is looking; the tool that just refused them is.
   */
  explainRefusal(refusal: string): string {
    const explanation = this.failClosedExplanation();
    return explanation ? `${refusal}
${explanation}` : refusal;
  }

  /** A fail-closed value stands only until the config carries its own again. */
  private pruneFailClosedMarker(config: ServerConfig): void {
    if (!Array.isArray(config[RECOVERY_FAIL_CLOSED_KEY])) return;
    const stillInForce = this.failClosedFieldsIn(config);
    if (stillInForce.length === 0) delete config[RECOVERY_FAIL_CLOSED_KEY];
    else config[RECOVERY_FAIL_CLOSED_KEY] = stillInForce.map((field) => field.key);
  }

  private failClosedNotice(fields: RecoverablePolicyField[]): string {
    const effects = fields.map((field) => field.failClosedEffect(this.configPath)).join(' and ');
    const names = fields.map((field) => field.key).join(' and ');
    return `Security settings could not be recovered from the damaged config: ${effects}. `
      + `Set ${names} in ${this.configPath} to restore access.`;
  }

  private async recoverCorruptConfig(
    error: SyntaxError,
    phase: CorruptConfigPhase
  ): Promise<{ config: ServerConfig; telemetry: CorruptConfigRecoveryTelemetry }> {
    // If another process repairs the file while we wait for the lock, these bytes
    // are the only evidence of the corruption this process met.
    const observed = await this.readCorruptSnapshot();
    const release = await this.acquireConfigLock();
    try {
      try {
        // Under the lock no cooperating writer can be mid-write.
        const latest = await this.readConfigOnce();
        const observedForensics = this.inspectCorruptConfig(error, phase, observed, await this.listConfigDir());
        return {
          config: latest,
          telemetry: { ...observedForensics, backup_created: false, recovered_by_other_process: true },
        };
      } catch (latestError: any) {
        if (latestError instanceof SyntaxError) {
          // Recovery reads the file itself, so its forensics describe what it replaced.
          return await this.recoverCorruptConfigUnderLock(latestError, phase);
        }
        if (latestError?.code !== 'ENOENT') throw latestError;

        const observedForensics = this.inspectCorruptConfig(error, phase, observed, await this.listConfigDir());
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
      this.pruneFailClosedMarker(latest);
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
      if (corruptConfigTelemetry) this.recordCorruptConfigTelemetry(corruptConfigTelemetry);
    }
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
      const markWasStale = Array.isArray(latest[RECOVERY_FAIL_CLOSED_KEY])
        && this.failClosedFieldsIn(latest).length === 0;
      this.config = latest;
      if (markWasStale) {
        // A hand-edited config is the one repair no mutation follows.
        this.pruneFailClosedMarker(this.config);
        this.queueMutation((config) => this.pruneFailClosedMarker(config));
      }
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
        await this.captureEvent('server_telemetry_opt_out', { reason: 'user_disabled', prev_value: currentValue });
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
