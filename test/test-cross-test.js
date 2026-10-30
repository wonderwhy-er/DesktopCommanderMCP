/**
 * Cross-tests (test/cross-test.js, helpers/cross-test.js): one commit's tests on
 * another commit's code, with coverage. A worktree of the code commit gets test/
 * exactly as the tests commit has it (its tests, helpers, fixtures and lists),
 * the run's results and coverage come back with cross-test.json naming both
 * commits, and the worktree is removed. A commit without the framework (the
 * runner, run-coverage.js; c8 for the code) stops the run before anything runs,
 * naming what it lacks. Against a throwaway repository, with a stand-in for npm.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { crossTest, readCrossArgs } from './helpers/cross-test.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const commit = (root, message) => {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
};
const PACKAGE = JSON.stringify({ name: 'x', scripts: { 'test:coverage': 'node test/run-coverage.js' }, devDependencies: { c8: '^12.0.0' } });

/** A: the framework, src/a.js "A", A's tests. B: other tests and src. C: B without run-coverage.js. D: A without c8. */
function makeRepository(root) {
  git(root, 'init', '-q');
  write(root, 'package.json', PACKAGE);
  write(root, 'src/a.js', 'A\n');
  for (const file of ['test/run-coverage.js', 'test/run-ci.js', 'test/helpers/node-test-runner.js']) write(root, file, '// the framework\n');
  write(root, 'test/test-x.js', 'x at A\n');
  write(root, 'test/only-a.js', 'only at A\n');
  const a = commit(root, 'A');
  write(root, 'src/a.js', 'B\n');
  write(root, 'test/test-x.js', 'x at B\n');
  fs.rmSync(path.join(root, 'test/only-a.js'));
  write(root, 'test/only-b.js', 'only at B\n');
  const b = commit(root, 'B');
  fs.rmSync(path.join(root, 'test/run-coverage.js'));
  const c = commit(root, 'C: no run-coverage.js');
  git(root, 'checkout', '-q', a);
  write(root, 'package.json', JSON.stringify({ name: 'x', scripts: { 'test:coverage': 'node test/run-coverage.js' } }));
  const d = commit(root, 'D: no c8');
  return { a, b, c, d };
}

export default async function run() {
  const base = createTempDir('dc-cross-test-');
  try {
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    const { a, b, c, d } = makeRepository(root);

    // A's code with B's tests: the run sees exactly that, and its results come back naming both
    const outDir = path.join(base, 'out');
    const seen = [];
    let worktree;
    const exit = await crossTest({
      root, code: a, testsFrom: b, outDir, log: () => {},
      run: async (command, cwd) => {
        worktree = cwd;
        seen.push(command);
        if (command === 'npm run test:coverage') {
          assert.strictEqual(fs.readFileSync(path.join(cwd, 'src/a.js'), 'utf8'), 'A\n', 'the code commit\'s code');
          assert.strictEqual(fs.readFileSync(path.join(cwd, 'test/test-x.js'), 'utf8'), 'x at B\n', 'the tests commit\'s tests');
          assert.ok(fs.existsSync(path.join(cwd, 'test/only-b.js')) && !fs.existsSync(path.join(cwd, 'test/only-a.js')), 'test/ exactly as the tests commit has it');
          write(cwd, 'test-results/suite/results.json', '{"files":[]}');
          write(cwd, 'coverage/coverage-summary.json', '{"total":{}}');
        }
        return 0;
      },
    });
    assert.strictEqual(exit, 0);
    assert.deepStrictEqual(seen, ['npm ci', 'npm run test:coverage'], 'installs the code commit\'s packages, then runs the tests with coverage');
    assert.ok(fs.existsSync(path.join(outDir, 'test-results/suite/results.json')) && fs.existsSync(path.join(outDir, 'coverage/coverage-summary.json')),
      'the results and the coverage come back');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'cross-test.json'), 'utf8')), { code: a, testsFrom: b, exit: 0 }, 'naming both commits');
    assert.ok(!fs.existsSync(worktree) && !git(root, 'worktree', 'list').includes(path.basename(worktree)), 'the worktree is removed');
    console.log('✓ a cross-test: the code commit\'s code with the tests commit\'s test/, its results back naming both');

    // A failed run's exit comes back too, and the worktree is still removed
    const failed = await crossTest({ root, code: a, testsFrom: b, outDir: path.join(base, 'failed'), log: () => {}, run: async (command) => (command === 'npm ci' ? 0 : 1) });
    assert.strictEqual(failed, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(base, 'failed', 'cross-test.json'), 'utf8')).exit, 1);
    console.log('✓ a failing cross-test fails, and says so in cross-test.json');

    // Fail closed: a commit without the framework stops the run before anything runs
    const ran = [];
    await assert.rejects(crossTest({ root, code: a, testsFrom: c, outDir: path.join(base, 'c'), log: () => {}, run: async (command) => { ran.push(command); return 0; } }),
      (error) => error.message.includes(c.slice(0, 7)) && /test\/run-coverage\.js/.test(error.message), 'the tests commit without run-coverage.js');
    await assert.rejects(crossTest({ root, code: d, testsFrom: b, outDir: path.join(base, 'd'), log: () => {}, run: async (command) => { ran.push(command); return 0; } }),
      (error) => error.message.includes(d.slice(0, 7)) && /c8/.test(error.message), 'the code commit without c8');
    assert.deepStrictEqual(ran, [], 'nothing ran');
    console.log('✓ a commit without the framework stops the cross-test, naming what it lacks');

    // The command line: --tests-from is needed; the code is HEAD unless --code names it
    assert.deepStrictEqual(readCrossArgs(['--tests-from', 'abc1234']), { testsFrom: 'abc1234', code: 'HEAD', outDir: undefined });
    assert.deepStrictEqual(readCrossArgs(['--code', 'main', '--tests-from', 'abc1234', '--out', 'x']), { testsFrom: 'abc1234', code: 'main', outDir: 'x' });
    assert.throws(() => readCrossArgs(['--code', 'main']), /--tests-from/);
    console.log('✓ the command line: --tests-from <commit> [--code <commit>] [--out <dir>]');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
