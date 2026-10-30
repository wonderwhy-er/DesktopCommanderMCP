/**
 * Cross-tests: one commit's tests on another commit's code, with coverage
 * (test/cross-test.js). A git worktree of the code commit gets test/ exactly as
 * the tests commit has it: its tests, helpers, fixtures, timed.txt and
 * excluded.txt. npm ci installs the code commit's packages, npm run
 * test:coverage runs there, and the results and coverage come back with
 * cross-test.json naming both commits; the worktree is removed. Fail closed: a
 * commit without the test framework stops the cross-test before anything runs.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// What the tests commit brings: its own runner and coverage scripts, which run the tests
const TESTS_NEED = ['test/run-coverage.js', 'test/run-ci.js', 'test/helpers/node-test-runner.js'];

function git(cwd, ...args) {
  const finished = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (finished.status !== 0) throw new Error(`git ${args.join(' ')}: ${finished.stderr.trim()}`);
  return finished.stdout.trim();
}
const has = (root, commit, file) =>
  spawnSync('git', ['cat-file', '-e', `${commit}:${file}`], { cwd: root }).status === 0;

/** What a commit lacks to take its side ('tests' or 'code') in a cross-test, [] when nothing */
function missingFramework(root, commit, side) {
  if (side === 'tests') return TESTS_NEED.filter((file) => !has(root, commit, file));
  // The code commit installs the packages, c8 among them, and names the coverage run
  let pkg;
  try {
    pkg = JSON.parse(git(root, 'show', `${commit}:package.json`));
  } catch {
    return ['package.json'];
  }
  return [
    ...(pkg.devDependencies?.c8 || pkg.dependencies?.c8 ? [] : ['c8 in package.json']),
    ...(pkg.scripts?.['test:coverage'] ? [] : ['the test:coverage script']),
  ];
}

/** --tests-from <commit> (needed), --code <commit> (HEAD by default), --out <dir> */
export function readCrossArgs(argv) {
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const testsFrom = value('--tests-from');
  if (!testsFrom) throw new Error('--tests-from <commit> names the commit whose tests run');
  return { testsFrom, code: value('--code') ?? 'HEAD', outDir: value('--out') };
}

/** Runs a command in a folder with its output passed through; resolves with its exit code */
export function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/**
 * Runs the tests of `testsFrom` on the code of `code` (commits in the repository at
 * `root`), with coverage; resolves with the run's exit code. `outDir` gets
 * test-results/, coverage/ and cross-test.json ({ code, testsFrom, exit }).
 */
export async function crossTest({
  root, code, testsFrom, outDir = path.join(root, 'test-results', 'cross'), run = runCommand, log = console.log,
}) {
  const codeSha = git(root, 'rev-parse', '--verify', `${code}^{commit}`);
  const testsSha = git(root, 'rev-parse', '--verify', `${testsFrom}^{commit}`);
  const missing = [
    ...missingFramework(root, testsSha, 'tests').map((what) => `${testsSha.slice(0, 7)} (the tests) has no ${what}`),
    ...missingFramework(root, codeSha, 'code').map((what) => `${codeSha.slice(0, 7)} (the code) has no ${what}`),
  ];
  if (missing.length > 0) {
    throw new Error(`A cross-test needs the test framework on both commits: ${missing.join('; ')}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cross-'));
  git(root, 'worktree', 'add', '--detach', '-q', dir, codeSha);
  try {
    // test/ exactly as the tests commit has it: the code commit's own test files go first
    if (has(root, codeSha, 'test')) git(dir, 'rm', '-r', '-q', 'test');
    git(dir, 'checkout', testsSha, '--', 'test');
    log(`Cross-test: the code of ${codeSha.slice(0, 7)}, the tests of ${testsSha.slice(0, 7)}`);
    let exit = await run('npm ci', dir);
    if (exit === 0) exit = await run('npm run test:coverage', dir);
    fs.mkdirSync(outDir, { recursive: true });
    for (const folder of ['test-results', 'coverage']) {
      const made = path.join(dir, folder);
      if (fs.existsSync(made)) fs.cpSync(made, path.join(outDir, folder), { recursive: true });
    }
    const named = { code: codeSha, testsFrom: testsSha, exit };
    fs.writeFileSync(path.join(outDir, 'cross-test.json'), `${JSON.stringify(named, null, 2)}\n`);
    log(`Cross-test ${exit === 0 ? 'passed' : 'failed'} (exit ${exit}): ${path.relative(root, outDir) || outDir}`);
    return exit;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
