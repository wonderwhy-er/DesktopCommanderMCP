import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One data root for new installations; the existing main config location. */
export function dataDir(home: string = os.homedir()): string {
  return path.join(home, '.claude-server-commander');
}

/**
 * Preserve older Remote MCP sessions without copying or deleting credentials.
 * A new install uses dataDir/device. An older install keeps using its previous
 * device folder until the owner deliberately migrates it.
 */
export function remoteDeviceDir(home: string = os.homedir()): string {
  const modern = path.join(dataDir(home), 'device');
  const legacy = path.join(home, '.desktop-commander-device');
  const modernCredentials = path.join(modern, 'device.json');

  if (fs.existsSync(modernCredentials)) return modern;
  // Keep any existing remote-device directory (credentials, logs or both)
  // reachable until its owner explicitly moves it. Never auto-rename tokens.
  if (fs.existsSync(legacy)) return legacy;
  return modern;
}

/** Keep an existing fuzzy-search log readable instead of overwriting it. */
export function fuzzyLogPath(home: string = os.homedir()): string {
  const modern = path.join(dataDir(home), 'logs', 'fuzzy-search.log');
  const legacy = path.join(home, '.claude-server-commander-logs', 'fuzzy-search.log');
  return fs.existsSync(legacy) && !fs.existsSync(modern) ? legacy : modern;
}
