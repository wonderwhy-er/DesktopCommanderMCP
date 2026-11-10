/**
 * `npm run test:coverage`'s steps (run-coverage.js): the tests under c8, then the
 * report's check, then the table per area, also when a step failed; it fails when
 * the tests or the check did. A stand-in for `node` records each step and answers
 * with an exit status; nothing runs.
 */
import assert from 'assert';
import { test } from 'node:test';
import * as coverageRunner from './run-coverage.js';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runCoverage, stampCoverage } from './run-coverage.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

/** runCoverage with each step's exit status: the steps it ran, by script name, and its exit code */
function withStatuses(statuses, args = []) {
  const steps = [];
  const node = (argv) => {
    const script = argv.map((arg) => path.basename(arg)).find((name) => /\.js$/.test(name) && name !== 'c8.js') ?? '?';
    const ranUnderC8 = argv.some((arg) => path.basename(arg) === 'c8.js');
    steps.push(ranUnderC8 ? `c8 ${script} ${argv.slice(argv.findIndex((arg) => arg.endsWith(script)) + 1).join(' ')}`.trim() : script);
    return statuses[script] ?? 0;
  };
  const root = createTempDir('dc-run-coverage-steps-');
  try {
    return { code: runCoverage({ node, args, root, stamp: () => steps.push('stamp') }), steps };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export default async function run() {
  const passing = withStatuses({}, ['--changed', 'A', 'B']);
  assert.deepStrictEqual(passing.steps, ['c8 run-ci.js --changed A B', 'stamp', 'check-coverage-report.js', 'coverage-areas.js'],
    'the tests under c8 with the arguments given, the report\'s commit, then the check, then the areas');
  assert.strictEqual(passing.code, 0);

  const testsFail = withStatuses({ 'run-ci.js': 1 });
  assert.strictEqual(testsFail.code, 1, 'failed tests fail it');
  assert.strictEqual(testsFail.steps.length, 4, 'the stamp, the check and the areas still run after failed tests');

  const checkFails = withStatuses({ 'check-coverage-report.js': 1 });
  assert.strictEqual(checkFails.code, 1, 'a failed check fails it');
  assert.strictEqual(checkFails.steps.length, 4, 'the areas still print after a failed check');

  assert.strictEqual(withStatuses({ 'coverage-areas.js': 1 }).code, 0, 'the table only reports: it fails nothing');
  console.log('✓ test:coverage: the tests under c8, the check, the areas; it fails with the tests or the check');

  // The stamp: the commit the report is of, and whether the tree was clean, so a review knows a report made at its commit
  const repo = createTempDir('dc-run-coverage-stamp-');
  try {
    const git = (args) => {
      const done = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      assert.strictEqual(done.status, 0, done.stderr);
      return done.stdout;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'coverage/\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'one']);
    const head = git(['rev-parse', 'HEAD']).trim();
    const dir = path.join(repo, 'coverage');
    stampCoverage({ git, dir });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')), { head, clean: true }, 'the commit, a clean tree');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    stampCoverage({ git, dir });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')), { head, clean: false }, 'a changed tracked file: not clean');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  console.log('✓ the coverage report\'s stamp: its commit, and a clean tree or not');
}

runIfMain(import.meta.url, run);


test('an untracked test prevents a clean coverage stamp', () => {
  const root = createTempDir('dc-run-coverage-untracked-');
  try {
    const git = args => {
      const done = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      assert.strictEqual(done.status, 0, done.stderr);
      return done.stdout;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'coverage/\n');
    git(['add', '.']); git(['commit', '-qm', 'fixture']);
    fs.writeFileSync(path.join(root, 'test-untracked.js'), 'throw new Error("untracked");');
    const dir = path.join(root, 'coverage');
    stampCoverage({ git, dir });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))).clean, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed Git status or HEAD lookup cannot produce a clean valid stamp', () => {
  const root = createTempDir('dc-run-coverage-git-failure-');
  try {
    const dir = path.join(root, 'coverage');
    stampCoverage({ git: args => args[0] === 'status' ? null : 'a'.repeat(40), dir });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))), {
      head: 'a'.repeat(40), clean: false,
    });
    stampCoverage({ git: args => args[0] === 'rev-parse' ? null : '', dir });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))), { head: null, clean: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed Git command preserves failure instead of empty successful stdout', () => {
  assert.strictEqual(typeof coverageRunner.coverageGit, 'function');
  assert.strictEqual(coverageRunner.coverageGit(['not-a-real-git-command']), null);
  assert.match(coverageRunner.coverageGit(['rev-parse', 'HEAD']), /^[a-f0-9]{40}\s*$/);
});

test('an early test exit cannot restamp stale test results or coverage', () => {
  const root = createTempDir('dc-run-coverage-stale-');
  try {
    for (const [name, file] of [['coverage', 'lcov.info'], ['test-results/suite', 'results.json']]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, file), 'stale');
    }
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'keep.js'), 'coverage build');
    let calls = 0;
    const node = () => {
      if (calls++ === 0) {
        assert.strictEqual(fs.existsSync(path.join(root, 'test-results')), false, 'old results removed before tests');
        assert.strictEqual(fs.existsSync(path.join(root, 'coverage')), false, 'old coverage removed before tests');
        return 1;
      }
      return 0;
    };
    assert.strictEqual(runCoverage({ root, node, stamp: () => {
      fs.mkdirSync(path.join(root, 'coverage'));
      fs.writeFileSync(path.join(root, 'coverage', 'run.json'), '{}');
    } }), 1);
    assert.strictEqual(fs.existsSync(path.join(root, 'test-results/suite/results.json')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'coverage/lcov.info')), false);
    assert.strictEqual(fs.readFileSync(path.join(root, 'dist/keep.js'), 'utf8'), 'coverage build');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
