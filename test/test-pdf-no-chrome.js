/**
 * On a machine with no Chrome (none installed, none that can be downloaded),
 * the tests whose checks render markdown to PDF skip those checks, say so, and
 * don't fail their file; a file's own summary counts the skip.
 *
 * Each file runs in a child process whose Chrome is hidden: the paths Chrome
 * is looked for at (installed, or in a Puppeteer cache) don't exist, and every
 * HTTPS request fails, so it can't be downloaded either.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const HIDE_CHROME = `
  import fs from 'fs';
  import https from 'https';
  import { EventEmitter } from 'events';
  import { syncBuiltinESMExports } from 'module';
  const existsSync = fs.existsSync;
  fs.existsSync = (file) => /chrom/i.test(String(file)) ? false : existsSync(file);
  const offline = () => {
    const request = new EventEmitter();
    request.end = request.setTimeout = request.destroy = () => request;
    process.nextTick(() => request.emit('error', Object.assign(new Error('connect ENETUNREACH (no downloads in this test)'), { code: 'ENETUNREACH' })));
    return request;
  };
  https.request = offline;
  https.get = offline;
  syncBuiltinESMExports();`;

/** Runs test/<file> with Chrome hidden; its skips stay out of the runner's list (this file's checks report them) */
function runWithoutChrome(file) {
  const { DC_TEST_SKIP_FILE, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(HIDE_CHROME)}`, path.join(TEST_DIR, file)], {
    cwd: path.dirname(TEST_DIR), env, encoding: 'utf8', timeout: 180_000,
  });
  return { status: child.status, output: `${child.stdout ?? ''}\n${child.stderr ?? ''}` };
}

async function run() {
  if (!isTestHome()) {
    return skip('PDF tests without Chrome: run through the test runner (it uses a temporary home)');
  }
  const cases = [
    // file, and the summary line it must end with when its render check skipped
    ['test-file-handlers.js', 'File handler tests passed, 1 skipped'],
    ['test-pdf-creation.js', null],
  ];
  const failures = [];
  for (const [file, summary] of cases) {
    const { status, output } = runWithoutChrome(file);
    const tail = output.trim().split('\n').slice(-12).join('\n');
    try {
      assert.strictEqual(status, 0, `${file} failed without Chrome (exit ${status}):\n${tail}`);
      assert(/SKIPPED: .*no Chrome/.test(output), `${file} passed without Chrome but didn't say it skipped its render check:\n${tail}`);
      if (summary) assert(output.includes(summary), `${file}'s summary should count the skip ("${summary}"):\n${tail}`);
      console.log(`✓ ${file} without Chrome: its render check is skipped, and it says so`);
    } catch (error) {
      failures.push(file);
      console.log(`✗ ${error.message}`);
    }
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of ${cases.length} files failed without Chrome`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
