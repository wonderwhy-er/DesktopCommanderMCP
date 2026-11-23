/**
 * --changed (helpers/select-tests.js) picks the test files a change reaches:
 * through imports, through dist/ paths a test names, and through a fixture or
 * preload a test starts by its path. A changed file no test reaches is listed.
 * `--changed <A> <B>` compares two commits only and reads the graph from B, so,
 * run at B, it gives the same answer on any machine; the default form also takes
 * uncommitted changes, marked as such. It reads this checkout's files and a
 * throwaway git repository's; it starts no server.
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { buildGraph, changedFiles, selectTests } from './helpers/select-tests.js';
import { createTempDir } from './helpers/test-env.js';

const testFiles = (dir, prefix) => fs.readdirSync(path.join(ROOT, dir))
  .filter((file) => file.startsWith(prefix) && file.endsWith('.js'))
  .map((file) => `${dir}/${file}`);

/** A throwaway repository: commit A, commit B (src/a.ts changed), then uncommitted edits */
function makeRepository() {
  const repo = createTempDir('dc-select-tests-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  git('init', '--quiet');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  write('test/test-a.js', "import { a } from '../dist/a.js';\nconsole.log(a);\n");
  write('test/test-b.js', "import { b } from '../dist/b.js';\nconsole.log(b);\n");
  git('add', '.');
  git('commit', '--quiet', '-m', 'A');
  const commitA = git('rev-parse', 'HEAD');
  write('src/a.ts', 'export const a = 2;\n');
  git('commit', '--quiet', '-am', 'B');
  const commitB = git('rev-parse', 'HEAD');
  // Not committed: an edit, and a new file that test-a.js now imports
  write('src/b.ts', 'export const b = 2;\n');
  write('src/new.ts', 'export const fresh = 1;\n');
  write('test/test-a.js', "import { a } from '../dist/a.js';\nimport { fresh } from '../dist/new.js';\nconsole.log(a, fresh);\n");
  return { repo, commitA, commitB };
}

export default async function run() {
  const graph = buildGraph();
  const tests = [...testFiles('test', 'test'), ...testFiles('test/repro', 'test-')];
  const select = (changed, among = tests) => selectTests({ tests: among, changed, graph });

  // A test file itself, and the source file it imports through dist/
  assert.ok(select(['test/test-line-count.js']).picked.has('test/test-line-count.js'), 'a changed test file is picked');
  assert.ok(select(['src/handlers/filesystem-handlers.ts']).picked.has('test/test-line-count.js'),
    'a test importing ../dist/handlers/filesystem-handlers.js is picked when src/handlers/filesystem-handlers.ts changes');
  console.log('✓ a test file, and a source file it imports through dist/');

  // A fixture the test starts by path, and a preload it passes to --import
  assert.ok(select(['test/fixtures/split-line.js']).picked.has('test/test-prompt-detection.js'),
    'test-prompt-detection.js runs fixtures/split-line.js by its path');
  assert.ok(select(['test/fixtures/config-lock-at-child-spawn.mjs']).picked.has('test/repro/test-search-child-config-lock.js'),
    'repro/test-search-child-config-lock.js preloads fixtures/config-lock-at-child-spawn.mjs');
  console.log('✓ a fixture and a preload, reached by their paths');

  // The launchers: remote-launchers.test.js names the Unix ones, and the Windows ones are
  // named by test/remote-launcher-windows.test.ps1, which test-powershell-tests.js runs
  const withLaunchers = [...tests, 'test/remote-launchers.test.js'];
  for (const script of ['scripts/remote/remote-linux.sh', 'scripts/remote/remote-macos.sh']) {
    assert.ok(select([script], withLaunchers).picked.has('test/remote-launchers.test.js'), `a change to ${script} runs remote-launchers.test.js`);
  }
  for (const changed of ['scripts/remote/remote-windows.ps1', 'scripts/remote/remote-windows.cmd', 'test/remote-launcher-windows.test.ps1']) {
    const { picked } = select([changed], withLaunchers);
    assert.ok(picked.has('test/test-powershell-tests.js'), `a change to ${changed} runs the PowerShell tests`);
    assert.ok(picked.get('test/test-powershell-tests.js').includes('test/remote-launcher-windows.test.ps1'), `through the .ps1 test: ${picked.get('test/test-powershell-tests.js')}`);
  }
  console.log('✓ a launcher change runs its test: the Unix ones remote-launchers.test.js, the Windows ones the PowerShell tests');

  // Everything, nothing, and a changed file no test reaches
  assert.strictEqual(select(['package.json']).runAll, 'package.json', 'package.json reaches every test');
  // Every runner script runs every test it reads: a change to one runs everything, the Docker runner's too
  for (const runner of ['test/run-all-tests.js', 'test/repro/run-repro.js', 'test/integration/run-all-integration-tests.js', 'test/docker/run-docker-tests.js']) {
    assert.strictEqual(select([runner]).runAll, runner, `a change to ${runner} runs everything`);
  }
  const docs = select(['README.md']);
  assert.strictEqual(docs.runAll, null);
  assert.strictEqual(docs.picked.size, 0, 'a change to the docs picks no test');
  assert.deepStrictEqual(select(['test/fixtures/split-line.js'], ['test/test-line-count.js']).unreached, ['test/fixtures/split-line.js'],
    'a changed fixture none of the tests reaches is listed');
  console.log('✓ package.json runs everything, docs nothing, and an unreached fixture is listed');

  const { repo, commitA, commitB } = makeRepository();
  try {
    const repoTests = ['test/test-a.js', 'test/test-b.js'];

    // Two commits: only what changed between them, and the graph as it is in B
    const strict = changedFiles({ root: repo, from: commitA, to: commitB });
    assert.deepStrictEqual(strict, [{ file: 'src/a.ts', uncommitted: false }], 'A..B is the commits only, not the uncommitted edits');
    const graphB = buildGraph({ root: repo, commit: commitB });
    assert.ok(!graphB.fileSet.has('src/new.ts'), 'the graph of B has no uncommitted file');
    const strictPick = selectTests({ tests: repoTests, changed: strict.map(({ file }) => file), graph: graphB });
    assert.deepStrictEqual([...strictPick.picked.keys()], ['test/test-a.js'], 'src/a.ts reaches test-a.js only');
    console.log('✓ --changed A B: the commits only, the graph read from B');

    // The default form: the commits since the base, plus uncommitted and new files, marked
    const loose = changedFiles({ root: repo, from: commitA });
    assert.deepStrictEqual(loose, [
      { file: 'src/a.ts', uncommitted: false },
      { file: 'src/b.ts', uncommitted: true },
      { file: 'src/new.ts', uncommitted: true },
      { file: 'test/test-a.js', uncommitted: true },
    ], 'since A: the commit, the edits and the new file, the edits marked uncommitted');
    const loosePick = selectTests({ tests: repoTests, changed: loose.map(({ file }) => file), graph: buildGraph({ root: repo }) });
    assert.deepStrictEqual([...loosePick.picked.keys()].sort(), repoTests, 'the uncommitted edits reach test-b.js too');
    console.log('✓ --changed: the commits since the base and the uncommitted files, marked');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

runIfMain(import.meta.url, run);
