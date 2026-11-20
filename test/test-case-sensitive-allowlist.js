/**
 * Regression test for issue #791: case-folding in normalizePath must not make
 * a path outside an allowed directory compare as inside it on a case-sensitive
 * filesystem (Linux). Skips on filesystems that fold case (win32, macOS).
 */

import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { runIfMain } from './helpers/run-if-main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Two directories that differ only by case; distinct on a case-sensitive fs
const ALLOWED = path.join(__dirname, 'test_case_Allowed');
const TWINS = path.join(__dirname, 'test_case_allowed');

async function cleanup() {
  await fs.rm(ALLOWED, { recursive: true, force: true }).catch(() => {});
  await fs.rm(TWINS, { recursive: true, force: true }).catch(() => {});
}

// The original bug is real only where the filesystem keeps case distinct
const caseSensitive = process.platform !== 'win32' && process.platform !== 'darwin';

async function runTests() {
  await cleanup();
  await fs.mkdir(ALLOWED, { recursive: true });
  await fs.mkdir(TWINS, { recursive: true });

  await configManager.setValue('allowedDirectories', [ALLOWED]);

  if (caseSensitive) {
    // Bypass: twin-case path resolves to a real directory OUTSIDE the allowlist
    let wrote;
    try {
      wrote = await validatePath(TWINS);
      console.error(`FAIL: twin-case path validated as allowed (${wrote})`);
      process.exitCode = 1;
    } catch {
      console.log('OK: twin-case outside path is rejected');
    }
    if (!process.exitCode) {
      // A path inside the twin directory must not be writable
      try {
        await validatePath(path.join(TWINS, 'secret.txt'));
        console.error('FAIL: file inside twin-case directory validated as allowed');
        process.exitCode = 1;
      } catch {
        console.log('OK: file inside twin-case directory is rejected');
      }
    }
  } else {
    console.log(`SKIP: platform ${process.platform} folds case by default`);
  }

  // No regression: the exact allowed path still works
  const okPath = await validatePath(path.join(ALLOWED, 'ok.txt'));
  assert.ok(String(okPath).startsWith(ALLOWED), 'allowed path must still validate');
  console.log('OK: exact-case allowed path still validates');

  await configManager.setValue('allowedDirectories', []);
  await cleanup();
}

runIfMain(import.meta.url, runTests);
