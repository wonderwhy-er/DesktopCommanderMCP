/**
 * Preload for repro/test-search-child-config-lock.js. Whenever this process
 * starts a Node.js child (child_process.spawn or spawnSync with
 * process.execPath), it takes the config lock first, with the config manager's
 * own options, and releases it HOLD_MS later on a timer: the way a config write
 * of this process that a telemetry capture started (its client id) can hold the
 * lock at that moment. Under spawnSync that timer can't run until the child has
 * ended, so the lock stays held while the child's own config writes wait on it;
 * under spawn it runs.
 */
import fs from 'fs';
import path from 'path';
import { createRequire, syncBuiltinESMExports } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const HOLD_MS = 200;
const require = createRequire(import.meta.url);
const childProcess = require('child_process');
const lockfile = require('proper-lockfile');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { CONFIG_FILE } = await import(pathToFileURL(path.join(ROOT, 'dist', 'config.js')).href);

function holdConfigLock() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const release = lockfile.lockSync(CONFIG_FILE, { realpath: false, stale: 30_000, update: 10_000 });
  process.stderr.write(`[config-lock-at-child-spawn] holding the config lock while a Node.js child starts\n`);
  setTimeout(() => {
    try {
      release();
    } catch (error) {
      // Once the child has taken the stale lock over, it is no longer ours to
      // release; the repro judges the run by its time and exit, not by this
      process.stderr.write(`[config-lock-at-child-spawn] release failed: ${error.message}\n`);
    }
  }, HOLD_MS);
}

for (const name of ['spawn', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = function (command, ...rest) {
    if (command === process.execPath) holdConfigLock();
    return original.call(this, command, ...rest);
  };
}
// The tests import { spawn } / { spawnSync } from 'child_process': update those bindings too
syncBuiltinESMExports();
