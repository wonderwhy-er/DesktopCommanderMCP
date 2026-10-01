import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import type { ServerConfig } from './config-manager.js';

/**
 * What to do with a damaged config.json, one that can't be parsed: the settings
 * still readable in it, what replaces it, the copy of it that is kept, and the
 * event that reports it. config-manager.ts decides when (at start, on a file
 * change, at a write) and does it under the config lock.
 */

export type CorruptConfigPhase = 'startup' | 'mutation' | 'watcher';

export interface CorruptConfigRecoveryTelemetry {
  phase: CorruptConfigPhase;
  config_bytes: number | null;
  backup_created: boolean;
  recovered_by_other_process: boolean;
}

/**
 * The settings still readable in a damaged config.json: the longest beginning of
 * it that is a JSON object once closed, so every complete top-level setting
 * before the damage, whatever its key. Each comma between the object's own
 * settings (strings and nested values skipped) is a place to cut it and close
 * it; the last cut that parses wins. {} when nothing is readable.
 */
export function readableSettings(text: string): ServerConfig {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Where a readable beginning may end, and whether it still needs its closing '}'
  const cuts: Array<[end: number, closed: boolean]> = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      // The object itself closes: damage after it (e.g. trailing bytes) leaves all of it
      if (--depth === 0) { cuts.push([i + 1, true]); break; }
    } else if (char === ',' && depth === 1) {
      cuts.push([i, false]);
    }
  }
  for (const [end, closed] of cuts.reverse()) {
    try {
      const value = JSON.parse(body.slice(0, end) + (closed ? '' : '}'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Damaged before this cut too: try the one before it
    }
  }
  return {};
}

/**
 * What replaces a damaged config.json: the defaults; while running, the
 * settings last read over them (`lastRead`, null at start); and every setting
 * still readable in the damaged text on top. An existing install: the welcome
 * page stays off.
 */
export function replacementConfig(defaults: ServerConfig, lastRead: ServerConfig | null, damagedText: string): ServerConfig {
  const config = { ...defaults };
  if (lastRead) {
    const { version: _version, ...settings } = lastRead;
    Object.assign(config, settings);
  }
  Object.assign(config, readableSettings(damagedText));
  config['welcomeOnboardingEligible'] = false;
  config['pendingWelcomeOnboarding'] = false;
  return config;
}

/** The newest <config>.corrupt.<ms>.<pid> copy beside `configPath`, if it holds `bytes` */
export async function newestCorruptCopyMatching(configPath: string, bytes: Buffer): Promise<string | null> {
  const folder = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.corrupt.`;
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  // The newest has the largest <ms>
  const newest = names.filter((name) => name.startsWith(prefix))
    .sort((a, b) => parseInt(a.slice(prefix.length), 10) - parseInt(b.slice(prefix.length), 10))
    .pop();
  if (!newest) return null;
  const copy = await fs.readFile(path.join(folder, newest)).catch(() => null);
  return copy !== null && copy.equals(bytes) ? newest : null;
}

/**
 * Keeps a copy of the damaged config.json, whose bytes were read as `bytes`:
 * <config>.corrupt.<ms>.<pid>, or the newest copy if it already holds them (a
 * replacement done again after one whose write failed). A copy, not a move: if
 * writing the new config fails, config.json stays as it was and the next start
 * replaces it, instead of finding it missing and taking it for a first run.
 * Returns the copy's name, null when there is no config.json; throws when the
 * copy can't be made.
 */
export async function keepDamagedCopy(configPath: string, bytes: Buffer): Promise<string | null> {
  if (!existsSync(configPath)) return null;
  try {
    let name = await newestCorruptCopyMatching(configPath, bytes);
    if (!name) {
      name = `${path.basename(configPath)}.corrupt.${Date.now()}.${process.pid}`;
      await fs.copyFile(configPath, path.join(path.dirname(configPath), name));
    }
    return name;
  } catch (copyError) {
    console.error('Failed to keep a copy of the damaged config.json:', copyError);
    throw copyError;
  }
}

/** Sends one config_parse_error_recovered event (when telemetry is on) */
export async function sendRecoveryEvent(telemetry: CorruptConfigRecoveryTelemetry): Promise<void> {
  try {
    const { capture } = await import('./utils/capture.js');
    await capture('config_parse_error_recovered', telemetry);
  } catch {
    // Recovery must never depend on telemetry delivery.
  }
}

/**
 * The recovery events of one config manager: those of a recovery made before it
 * is initialized are held until flush(), the others are sent at once, by `send`.
 */
export class RecoveryEvents {
  private pending: CorruptConfigRecoveryTelemetry[] = [];

  constructor(private readonly send: (telemetry: CorruptConfigRecoveryTelemetry) => Promise<void>) {}

  record(telemetry: CorruptConfigRecoveryTelemetry, initialized: boolean): void {
    if (!initialized) {
      this.pending.push(telemetry);
      return;
    }
    void this.send(telemetry);
  }

  flush(): void {
    for (const telemetry of this.pending.splice(0)) void this.send(telemetry);
  }
}
