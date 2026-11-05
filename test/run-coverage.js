/**
 * `npm run test:coverage` after its coverage build: runs test/run-ci.js under c8
 * (.c8rc.json), then checks the report (test/check-coverage-report.js) and prints
 * its numbers per area (test/coverage-areas.js), also when a test failed. Exits 1
 * if the tests or the check failed.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from './helpers/node-test-runner.js';

/** The three steps, each through `node` (its arguments → its exit status); returns the exit code */
export function runCoverage({ node, args = [] }) {
  const tests = node([path.join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js'), process.execPath, path.join(ROOT, 'test', 'run-ci.js'), ...args]);
  const report = node([path.join(ROOT, 'test', 'check-coverage-report.js')]);
  node([path.join(ROOT, 'test', 'coverage-areas.js')]);
  return tests === 0 && report === 0 ? 0 : 1;
}

// Real paths on both sides: started through a symlink or junction, it still runs
if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status;
  process.exit(runCoverage({ node, args: process.argv.slice(2) }));
}
