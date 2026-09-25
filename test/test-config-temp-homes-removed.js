/**
 * The fork-based corrupt-config tests make their own temporary home, with a
 * config.json in it, for their worker processes. Each removes it once its
 * workers have exited, so repeated runs leave no homes or configs behind in the
 * temporary folder.
 *
 * Each file runs in a child process whose temporary folder (TEMP, TMP, TMPDIR)
 * is a new, empty folder of this test's own; it must be empty again afterwards,
 * whether the file passed or failed (its result is its own; the suite runs it
 * too).
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['test-config-corrupt-fail-closed.js', 'test-config-corrupt-concurrency.js'];

async function run() {
  const failures = [];
  for (const file of FILES) {
    const temp = createTempDir('dc-test-temp-homes-');
    try {
      const child = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
        cwd: path.dirname(TEST_DIR),
        env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const left = fs.readdirSync(temp);
      assert.deepStrictEqual(left, [], `${file} (exit ${child.status}) left these in the temporary folder: ${left.join(', ')}`);
      console.log(`✓ ${file} removes the temporary home it made (exit ${child.status})`);
    } catch (error) {
      failures.push(file);
      console.log(`✗ ${error.message}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of ${FILES.length} files left their temporary home behind`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
