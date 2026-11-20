/**
 * Regression test for issue #791: two directories that differ only by letter
 * case must not compare as the same path where the filesystem keeps them
 * distinct. Where the volume folds case, the other spelling of the allowed
 * directory is the same directory and must still validate.
 *
 * The case behavior is read from the test folder's own volume, not from the
 * platform name, so a case-sensitive APFS volume is tested like Linux.
 */

// First: when run directly with node, gives this process a temporary home so
// the config it changes is never the user's real one
import './helpers/test-home.js';

import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import assert from 'assert';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

/** True when `a` and `b` are the same entry on disk */
async function sameEntry(a, b) {
  const [sa, sb] = await Promise.all([fs.stat(a, { bigint: true }), fs.stat(b, { bigint: true })]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

async function runTests() {
  const root = createTempDir('dc-case-allowlist-');
  // Two spellings that differ only by case; distinct entries on a case-sensitive volume
  const allowed = path.join(root, 'Case_Allowed');
  const twin = path.join(root, 'case_allowed');
  const originalAllowed = await configManager.getValue('allowedDirectories');

  try {
    await fs.mkdir(allowed, { recursive: true });
    await fs.mkdir(twin, { recursive: true });
    const caseSensitive = !(await sameEntry(allowed, twin));

    await configManager.setValue('allowedDirectories', [allowed]);

    if (caseSensitive) {
      console.log('Volume is case-sensitive: the other spelling is a different directory');
      await assert.rejects(validatePath(twin), /Path not allowed/,
        'twin-case directory outside the allowlist must be rejected');
      console.log('OK: twin-case outside path is rejected');

      await assert.rejects(validatePath(path.join(twin, 'secret.txt')), /Path not allowed/,
        'file inside the twin-case directory must be rejected');
      console.log('OK: file inside twin-case directory is rejected');
    } else {
      console.log('Volume folds case: the other spelling is the same directory');
      await validatePath(path.join(twin, 'ok.txt'));
      console.log('OK: other spelling of the allowed directory validates');
    }

    // No regression: the exact allowed path still works
    const okPath = await validatePath(path.join(allowed, 'ok.txt'));
    assert.ok(String(okPath).startsWith(allowed), `allowed path must still validate (got ${okPath})`);
    console.log('OK: exact-case allowed path still validates');

    // No probe file is left behind in the allowed directory
    assert.deepStrictEqual(await fs.readdir(allowed), [], 'case probe must clean up after itself');
    console.log('OK: no probe file left in the allowed directory');
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(root, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
