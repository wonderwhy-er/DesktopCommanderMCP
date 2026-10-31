import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import type { ServerConfig } from './config-manager.js';

/** Where a corrupt config.json was found: at start, by a write, or by the file watcher */
export type RecoveryPhase = 'startup' | 'mutation' | 'watcher';

/** The config_parse_error_recovered event */
export interface RecoveryEvent {
  phase: RecoveryPhase;
  config_bytes: number | null;
  backup_created: boolean;
  recovered_by_other_process: boolean;
}

/**
 * The settings still readable in a corrupt config.json: the longest beginning
 * of it that is a JSON object once closed, so every complete top-level setting
 * before the first error. {} when there is none.
 */
export function salvageSettings(text: string): ServerConfig {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // A readable beginning can end at each comma between top-level settings, or at
  // the brace that closes the object (anything after it is ignored)
  const ends: number[] = [];
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
      if (--depth === 0) { ends.push(i); break; }
    } else if (char === ',' && depth === 1) {
      ends.push(i);
    }
  }
  for (const end of ends.reverse()) {
    try {
      return JSON.parse(body.slice(0, end) + '}');
    } catch {
      // Not valid JSON up to here either, so try a shorter beginning
    }
  }
  return {};
}

/**
 * What a corrupt config.json is recovered as: the defaults, then the settings
 * last read (while running), then the settings salvaged from it. The welcome
 * page stays off, as for any existing install.
 */
export function buildRecoveredConfig(defaults: ServerConfig, lastRead: ServerConfig | null, text: string): ServerConfig {
  const { version: _version, ...settings } = lastRead ?? {};
  return { ...defaults, ...settings, ...salvageSettings(text), welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false };
}

/**
 * Backs up a corrupt config.json as config.json.corrupt.<ms>.<pid>, unless the
 * newest backup already holds `bytes` (a recovery tried again after its write
 * failed). Returns the backup's name, or null when there is no config.json.
 */
export async function backupCorruptConfig(configPath: string, bytes: Buffer): Promise<string | null> {
  if (!existsSync(configPath)) return null;
  const folder = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.corrupt.`;
  const newest = (await fs.readdir(folder).catch(() => [] as string[]))
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => parseInt(a.slice(prefix.length), 10) - parseInt(b.slice(prefix.length), 10))
    .pop();
  if (newest && (await fs.readFile(path.join(folder, newest)).catch(() => null))?.equals(bytes)) return newest;
  const name = `${prefix}${Date.now()}.${process.pid}`;
  await fs.copyFile(configPath, path.join(folder, name));
  return name;
}
