/**
 * The runners' shared part (helpers/node-test-runner.js): the options every
 * runner takes, the timed tests test/timed.txt names and how each runner keeps
 * or leaves them out, and a run of test files through node:test with its three
 * reports (JUnit, JSON, TAP), a failed file's output and a check skip() skipped
 * among them. The run is of three small files in a temporary folder, in a
 * process of its own.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { byTimed, ROOT, readRunnerArgs, timedNames, withoutSkipped } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

export default async function run() {
  const options = readRunnerArgs(['--out', 'reports', '--shard', '2/3', '--changed', 'A', 'B', '--skip', 'test/test-a.js', '--without-timed', 'test-b.js'], 'default-out');
  assert.strictEqual(options.outDir, path.resolve('reports'));
  assert.deepStrictEqual(options.shard, { index: 2, total: 3 });
  assert.deepStrictEqual(options.values.changed, ['A', 'B']);
  assert.deepStrictEqual(options.skip, ['test-a.js'], 'a skipped file by its name');
  assert.ok(options.flags.has('--without-timed'));
  assert.deepStrictEqual(options.names, ['test-b.js']);
  const fewer = readRunnerArgs(['--changed', 'test-c.js'], 'default-out');
  assert.deepStrictEqual(fewer.values.changed, [], '--changed with no commit: a test file after it is a name');
  assert.deepStrictEqual(fewer.names, ['test-c.js']);
  assert.strictEqual(fewer.outDir, 'default-out');
  assert.deepStrictEqual(withoutSkipped(['test-a.js', 'test-b.js', 'repro/test-a.js'], options), ['test-b.js']);
  // The old names fail loudly: ignored, they would let timed tests into a run that means to leave them out
  for (const old of ['--run-alone', '--without-run-alone']) {
    assert.throws(() => readRunnerArgs([old], 'default-out'), new RegExp(`${old} is now --${old === '--run-alone' ? 'timed' : 'without-timed'}`));
  }
  console.log('✓ the options every runner takes; the old run-alone names fail loudly');

  // test/timed.txt: the tests whose result depends on time, by runner folder
  const timed = timedNames();
  assert.ok(timed.length > 0 && timed.every((name) => !name.includes('#') && name === name.trim()), 'names only: no comments, no blank lines');
  for (const name of timed) assert.ok(fs.existsSync(path.join(ROOT, 'test', name)), `test/timed.txt names test/${name}, which exists`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'test', 'run-alone.txt')), 'test/run-alone.txt is now test/timed.txt');
  const suiteTimed = timed.find((name) => !name.includes('/'));
  const reproTimed = timed.find((name) => name.startsWith('repro/'));
  const keep = (flag, names, folder) => byTimed(names, readRunnerArgs(flag ? [flag] : [], 'out'), folder);
  assert.deepStrictEqual(keep('--without-timed', [suiteTimed, 'test-ordinary.js'], ''), ['test-ordinary.js'], 'the suite without its timed tests');
  assert.deepStrictEqual(keep('--timed', [suiteTimed, 'test-ordinary.js'], ''), [suiteTimed], 'the suite\'s timed tests only');
  assert.deepStrictEqual(keep('--without-timed', [path.basename(reproTimed), 'test-ordinary.js'], 'repro'), ['test-ordinary.js'], 'repro/ names in the repro runner');
  assert.deepStrictEqual(keep('--timed', [path.basename(reproTimed), suiteTimed], 'repro'), [path.basename(reproTimed)], 'a suite name isn\'t a repro');
  assert.deepStrictEqual(keep('--without-timed', [suiteTimed, path.basename(reproTimed), 'other.js'], 'integration'), [suiteTimed, path.basename(reproTimed), 'other.js'],
    'the integration runner reads only integration/ names, not the suite\'s or repro\'s');
  assert.deepStrictEqual(keep(undefined, [suiteTimed, 'test-ordinary.js'], ''), [suiteTimed, 'test-ordinary.js'], 'neither flag: every file');
  console.log('✓ test/timed.txt, and each runner keeps or leaves out its own timed tests');

  // A run of three files: one passes, one fails with output, one skips a check
  const dir = createTempDir('dc-node-test-runner-');
  try {
    fs.writeFileSync(path.join(dir, 'pass.mjs'), "console.log('fine');\n");
    fs.writeFileSync(path.join(dir, 'fail.mjs'), "console.log('boom');\nprocess.exit(3);\n");
    fs.writeFileSync(path.join(dir, 'skip.mjs'), "import fs from 'fs';\nfs.appendFileSync(process.env.DC_TEST_SKIP_FILE, 'no python\\n');\n");
    const runner = pathToFileURL(path.join(ROOT, 'test', 'helpers', 'node-test-runner.js')).href;
    fs.writeFileSync(path.join(dir, 'run.mjs'), [
      `import { runTestFiles } from ${JSON.stringify(runner)};`,
      "const [dir, outDir] = process.argv.slice(2);",
      "await runTestFiles({ dir, files: ['./pass.mjs', './fail.mjs', './skip.mjs'], outDir, suiteName: 'demo' });",
    ].join('\n'));
    // A process of its own, without this file's own test home and node:test context
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NODE_TEST_CONTEXT|DC_TEST_)/.test(name)));
    const outDir = path.join(dir, 'out');
    const result = spawnSync(process.execPath, [path.join(dir, 'run.mjs'), dir, outDir], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);

    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    assert.strictEqual(json.suite, 'demo');
    assert.deepStrictEqual(json.files.map(({ file, success }) => [file, success]), [['./pass.mjs', true], ['./fail.mjs', false], ['./skip.mjs', true]]);
    const failed = json.files[1];
    assert.ok(failed.exitCode === 3 && failed.outputTail.includes('boom'), 'a failed file: its exit code and its last output');
    assert.deepStrictEqual(json.files[2].skipped, ['no python'], 'a skipped check, by its reason');
    assert.ok(json.summary.failed === 1 && json.summary.skippedChecks === 1);

    const junit = fs.readFileSync(path.join(outDir, 'junit.xml'), 'utf8');
    assert.ok(junit.includes('<testsuite') && (junit.match(/<failure/g) ?? []).length === 1 && junit.includes('boom'), 'JUnit: one failure, with its output');
    assert.ok(junit.includes('name="skipped: no python"'), 'JUnit: the skipped check as its own entry');
    const tap = fs.readFileSync(path.join(outDir, 'results.tap'), 'utf8');
    assert.strictEqual((tap.match(/^not ok /gm) ?? []).length, 1, 'TAP: one file not ok');
    console.log('✓ a run of test files: JUnit, JSON and TAP, a failure\'s output, a skipped check');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
