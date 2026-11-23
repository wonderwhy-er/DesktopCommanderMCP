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

/**
 * The report's stamp, coverage/run.json: the commit it was made at and whether the tree was clean,
 * so the AI review (test/ci-review.js) uses a report made at the commit it reviews, never an older one
 */
export function stampCoverage({ git, dir = path.join(ROOT, 'coverage') }) {
  const head = git(['rev-parse', 'HEAD'])?.trim() || null;
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  const clean = Boolean(head) && typeof status === 'string' && status.trim() === '';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify({ head, clean })}\n`);
}

/** The three steps, each through `node` (its arguments → its exit status), and the stamp after the tests; returns the exit code */
export function runCoverage({ node, args = [], stamp = () => {}, root = ROOT }) {
  // A test command can stop before writing any results; old files must not receive this run's stamp.
  const directory = path.resolve(root);
  for (const name of ['test-results', 'coverage']) {
    const target = path.join(directory, name);
    if (path.dirname(target) !== directory) throw new Error('Coverage output must stay inside its checkout.');
    fs.rmSync(target, { recursive: true, force: true });
  }
  const tests = node([
    path.join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js'),
    process.execPath, path.join(ROOT, 'test', 'run-ci.js'), ...args,
  ]);
  stamp();
  const report = node([path.join(ROOT, 'test', 'check-coverage-report.js')]);
  node([path.join(ROOT, 'test', 'coverage-areas.js')]);
  return tests === 0 && report === 0 ? 0 : 1;
}

/** A failed Git command cannot establish the checkout's commit or cleanliness. */
export function coverageGit(args) {
  const done = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  return done.status === 0 ? done.stdout : null;
}

// Real paths on both sides: started through a symlink or junction, it still runs
if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status;
  process.exit(runCoverage({ node, args: process.argv.slice(2), stamp: () => stampCoverage({ git: coverageGit }) }));
}
