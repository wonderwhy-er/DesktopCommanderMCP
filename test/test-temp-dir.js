/**
 * createTempDir() (test/helpers/test-env.js) gives a new temporary folder by
 * its real path, and createTestEnv() makes the home with it. On macOS the
 * temporary folder is under /var, a link to /private/var, while the server
 * works with real paths: a test that compares paths needs the real one.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTempDir, createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

function isRealPathFolder(dir, prefix, what) {
  assert(fs.statSync(dir).isDirectory(), `${what} ${dir} is not a folder`);
  assert.strictEqual(dir, fs.realpathSync.native(dir), `${what} ${dir} is not given by its real path`);
  assert.strictEqual(path.dirname(dir), fs.realpathSync.native(os.tmpdir()), `${what} ${dir} is not in the temporary folder`);
  assert(path.basename(dir).startsWith(prefix), `${what} ${dir} does not start with ${prefix}`);
}

export default async function runTests() {
  const failures = [];
  const checks = {
    'createTempDir() gives a new folder by its real path': () => {
      const first = createTempDir('dc-temp-dir-');
      const second = createTempDir('dc-temp-dir-');
      try {
        isRealPathFolder(first, 'dc-temp-dir-', 'createTempDir()');
        assert.notStrictEqual(first, second, 'two calls gave the same folder');
      } finally {
        fs.rmSync(first, { recursive: true, force: true });
        fs.rmSync(second, { recursive: true, force: true });
      }
    },
    'createTestEnv() makes the home the same way': () => {
      const { home, env, cleanup } = createTestEnv();
      try {
        isRealPathFolder(home, 'dc-test-home-', 'the test home');
        assert.strictEqual(env.HOME, home);
        assert.strictEqual(env.USERPROFILE, home);
      } finally {
        cleanup();
      }
    },
  };
  for (const [name, check] of Object.entries(checks)) {
    try {
      check();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}: ${error.message}`);
    }
  }
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
