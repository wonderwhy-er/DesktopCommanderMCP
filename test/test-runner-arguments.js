/**
 * The runners take the files named on the command line by file name, so a path
 * from the repository root (what shell tab-completion gives) runs that file.
 * run-all-tests.js and the integration runner did; run-repro.js joined the path
 * onto test/repro/ and reported test/repro/test/repro/x.js as a failed repro.
 */
import assert from 'assert';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runIfMain } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default async function runTests() {
  // A fast repro (well under a second), named by its path from the repository root
  const script = path.join('test', 'repro', 'test-env-threadpool-timing.js');
  const result = spawnSync(process.execPath, [path.join('test', 'repro', 'run-repro.js'), script], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  try {
    assert.strictEqual(result.status, 0, `run-repro.js ${script} exited ${result.status}: ${output.split('\n').filter((line) => /Cannot find module|✗|✓/.test(line)).join(' | ')}`);
    assert(output.includes('✓ test-env-threadpool-timing.js'), `run-repro.js ${script} did not run the repro: ${output.slice(-400)}`);
    console.log('✓ run-repro.js runs a repro named by its path from the repository root');
    return true;
  } catch (error) {
    console.log(`✗ ${error.message}`);
    return false;
  }
}

runIfMain(import.meta.url, runTests);
