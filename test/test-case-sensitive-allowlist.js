/**
 * Regression test for issue #791: two directories that differ only by letter
 * case must not compare as the same path where the filesystem keeps them
 * distinct. Where the volume folds case, the other spelling of the allowed
 * directory is the same directory and must still validate.
 *
 * The case behavior is read from the test folder's own volume, not from the
 * platform name, so a case-sensitive APFS volume is tested like Linux.
 *
 * Also covered: a folded match never reaches a distinct sibling twin when only
 * the allowed directory's contents fold case, the case probe runs again when
 * the directory's device or inode changes, and an allowed directory that
 * doesn't exist yet is matched through its existing ancestor.
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

const PROBE_PREFIX = '.dc-case-probe-';

/** Replaces fs/promises' `name` (the object filesystem.ts calls) until the returned restore runs */
function patchFs(name, wrap) {
  const original = fs[name];
  fs[name] = wrap(original);
  return () => { fs[name] = original; };
}

/** Counts case-probe files created in `dir` */
function countProbes(dir, realDir) {
  const counter = { count: 0 };
  counter.restore = patchFs('writeFile', (original) => (file, ...rest) => {
    const parent = path.dirname(String(file));
    if ((parent === dir || parent === realDir) && path.basename(String(file)).startsWith(PROBE_PREFIX)) {
      counter.count++;
    }
    return original(file, ...rest);
  });
  return counter;
}

/**
 * Makes case probes report a case-insensitive directory, as on an ext4
 * directory with casefold enabled inside a case-sensitive parent: the swapped
 * spelling of a probe file is looked up as the probe file itself.
 */
function foldProbedNames() {
  return patchFs('lstat', (original) => (file, ...rest) => {
    const base = path.basename(String(file));
    const target = base.toLowerCase().startsWith(PROBE_PREFIX) && base !== base.toLowerCase()
      ? path.join(path.dirname(String(file)), base.toLowerCase())
      : file;
    return original(target, ...rest);
  });
}

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
    assert.ok(String(okPath).startsWith(await fs.realpath(allowed)), `allowed path must still validate (got ${okPath})`);
    console.log('OK: exact-case allowed path still validates');

    // No probe file is left behind in the allowed directory
    assert.deepStrictEqual(await fs.readdir(allowed), [], 'case probe must clean up after itself');
    console.log('OK: no probe file left in the allowed directory');

    // Mixed sensitivity: only the allowed directory's contents fold case
    if (caseSensitive) {
      const mixed = path.join(root, 'Mixed');
      const mixedTwin = path.join(root, 'mixed');
      await fs.mkdir(mixed);
      await fs.mkdir(mixedTwin);
      await configManager.setValue('allowedDirectories', [mixed]);
      const restoreLstat = foldProbedNames();
      try {
        await assert.rejects(validatePath(path.join(mixedTwin, 'secret.txt')), /Path not allowed/,
          'sibling twin on a case-sensitive parent must be rejected even though the allowed directory folds case');
        await assert.rejects(validatePath(path.join(mixedTwin.toLowerCase(), 'secret.txt')), /Path not allowed/,
          'fully lowercased path to the sibling twin must be rejected');
      } finally {
        restoreLstat();
      }
      console.log('OK: sibling case-twin is rejected when only the allowed directory folds case');
    }

    // The probe result is reused only while the directory's device and inode stay the same
    const cached = path.join(root, 'Cached');
    await fs.mkdir(cached);
    await configManager.setValue('allowedDirectories', [cached]);
    const otherSpelling = path.join(root, 'cached', 'x.txt');
    const validateOtherSpelling = () => validatePath(otherSpelling).catch(() => {});
    const probes = countProbes(cached, await fs.realpath(cached));
    try {
      await validateOtherSpelling();
      assert.strictEqual(probes.count, 1, 'first check must probe the allowed directory');
      await validateOtherSpelling();
      assert.strictEqual(probes.count, 1, 'same device and inode must reuse the cached probe');
      // A new directory at the same path, while the old one still exists, has a different inode
      await fs.rename(cached, path.join(root, 'cached_old'));
      await fs.mkdir(cached);
      await validateOtherSpelling();
      assert.strictEqual(probes.count, 2, 'changed inode must probe again');
    } finally {
      probes.restore();
    }
    console.log('OK: case probe runs again when the directory inode changes');

    // An allowed directory that doesn't exist yet uses its existing ancestor's case rules
    const ancestor = path.join(root, 'Ancestor');
    await fs.mkdir(ancestor);
    const future = path.join(ancestor, 'Future');
    const futureOtherSpelling = path.join(ancestor, 'future', 'new.txt');
    await configManager.setValue('allowedDirectories', [future]);
    const restoreLstat = caseSensitive ? foldProbedNames() : () => {};
    try {
      await validatePath(futureOtherSpelling);
    } finally {
      restoreLstat();
    }
    console.log('OK: other spelling of a not-yet-created allowed directory validates where its ancestor folds case');
    if (caseSensitive) {
      const futureTwin = path.join(root, 'Ancestor2');
      await fs.mkdir(futureTwin);
      await configManager.setValue('allowedDirectories', [path.join(futureTwin, 'Future')]);
      await assert.rejects(validatePath(path.join(futureTwin, 'future', 'new.txt')), /Path not allowed/,
        'other spelling of a not-yet-created allowed directory must be rejected on a case-sensitive ancestor');
      console.log('OK: other spelling of a not-yet-created allowed directory is rejected on a case-sensitive ancestor');
    }
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(root, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
