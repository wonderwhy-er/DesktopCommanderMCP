/**
 * What CI runs (run-ci.js): the suite, the repro scripts and the integration
 * tests, each without its timed tests, and Docker's tests on Linux; elsewhere the
 * run says why Docker's didn't run. Under coverage, the release-packages repro
 * runs last and uncovered, with a hang guard long enough for its two npm installs
 * on a slow machine, then the coverage build again. Every part runs even when one
 * fails, and any failure fails the run. An on-demand run's `tests` value picks the
 * parts: none (everything a label run runs), test, integration, repro, docker,
 * timed, changed:A..B or files:a.js,b.js. Stand-ins run the parts; nothing starts.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ciParts, planFor, runParts } from './run-ci.js';
import { runIfMain } from './helpers/run-if-main.js';

const script = (part) => path.basename(part.args[0]);
/** A plan as "part: script args…", the args from the checkout's root, for comparing */
const described = (parts) => parts.map((part) => `${part.name}: ${part.args.map((arg) => (path.isAbsolute(arg) ? path.basename(arg) : arg)).join(' ')}`);
const env = { NODE_V8_COVERAGE: '/c8-tmp', PATH: '/bin' };

/** The on-demand runs' `tests` values, each its runners' existing options */
function testPlans() {
  const plan = (tests, underCoverage = true, platform = 'linux') => described(planFor(tests, { underCoverage, env, platform }));
  assert.deepStrictEqual(plan(''), described(ciParts({ underCoverage: true, env, platform: 'linux' })), 'no value, the default: what a push or label run runs');
  assert.deepStrictEqual(plan('test'), ['suite: run-all-tests.js --no-build --without-timed'], 'test: the suite, npm test\'s files');
  assert.deepStrictEqual(plan('integration'), ['integration: run-all-integration-tests.js --without-timed']);
  assert.deepStrictEqual(plan('repro'), [
    'repro: run-repro.js --without-timed --skip test-release-packages-ship-contract.js',
    'repro, rebuilds dist/ (not covered): run-repro.js test-release-packages-ship-contract.js --out repro-rebuilds-dist',
    'coverage build again: tsc -p tsconfig.coverage.json',
    'copied scripts mapped again: map-copied-scripts.js',
  ], 'repro: test/repro/, the release repro last and uncovered');
  assert.deepStrictEqual(plan('repro', false), ['repro: run-repro.js --without-timed'], 'repro without coverage: one part');
  assert.deepStrictEqual(plan('timed'), [
    'suite, timed: run-all-tests.js --no-build --timed',
    'repro, timed: run-repro.js --timed',
    'integration, timed: run-all-integration-tests.js --timed',
  ], 'timed: only the timed tests, in each runner');
  assert.deepStrictEqual(plan('docker'), ['docker: run-docker-tests.js'], 'docker: test/docker/, and with none to run it fails: the run asked for them');
  assert.ok(!('NODE_V8_COVERAGE' in planFor('docker', { underCoverage: true, env, platform: 'linux' })[0].env), 'docker runs uncovered: its server runs in a container');
  assert.deepStrictEqual(plan('changed:origin/main..abc1234'), described(ciParts({ underCoverage: true, passed: ['--changed', 'origin/main', 'abc1234'], env, platform: 'linux' })),
    'changed:A..B: what CI runs, each runner with --changed A B');
  assert.deepStrictEqual(plan('files:test/test-a.js,test-b.js, test/repro/test-c.js,integration/d.js,test/docker/test-e.js'), [
    'suite: run-all-tests.js --no-build test-a.js test-b.js',
    'repro: run-repro.js test-c.js',
    'integration: run-all-integration-tests.js d.js',
    'docker: run-docker-tests.js test-e.js',
  ], 'files: exactly those, each through its folder\'s runner, timed or not');
  assert.deepStrictEqual(plan('files:repro/test-release-packages-ship-contract.js'), [
    'repro, rebuilds dist/ (not covered): run-repro.js test-release-packages-ship-contract.js --out repro-rebuilds-dist',
    'coverage build again: tsc -p tsconfig.coverage.json',
    'copied scripts mapped again: map-copied-scripts.js',
  ], 'the release repro named alone: uncovered, then the coverage build again');
  for (const wrong of ['all', 'everything', 'changed:A', 'changed:..B', 'files:', 'files:src/index.ts', 'files:test/helpers/search.js']) {
    assert.throws(() => planFor(wrong, { underCoverage: true, env, platform: 'linux' }), /tests/, `"${wrong}" stops with what tests can be`);
  }
  console.log('✓ each tests value: none (the default), test, integration, repro, docker, timed, changed:A..B, files:…; no all');
}

/** Docker's tests run on Linux; on Windows and macOS the run says why they didn't */
function dockerByPlatform() {
  const dockerOf = (platform, github) => described(ciParts({ underCoverage: false, env: { PATH: '/bin', ...(github ? { GITHUB_ACTIONS: 'true' } : {}) }, platform })).at(-1);
  assert.strictEqual(dockerOf('linux', true), 'docker: run-docker-tests.js --none-ok --without-timed',
    'on Linux: Docker\'s tests, and with none at this commit nothing fails');
  assert.strictEqual(dockerOf('darwin', true), "docker: run-docker-tests.js --not-run GitHub's macOS runner has no Docker");
  assert.strictEqual(dockerOf('win32', true), "docker: run-docker-tests.js --not-run GitHub's Windows runner has no Docker for Linux containers");
  assert.strictEqual(dockerOf('darwin', false), "docker: run-docker-tests.js --not-run Docker's tests run on Linux only, not on macOS", 'off GitHub, the reason names no runner');
  assert.deepStrictEqual(described(planFor('docker', { underCoverage: true, env: { ...env, GITHUB_ACTIONS: 'true' }, platform: 'darwin' })),
    ["docker: run-docker-tests.js --not-run GitHub's macOS runner has no Docker"], 'tests=docker on macOS says why too');
  console.log('✓ Docker\'s tests on Linux; on Windows and macOS the run says why not');
}

export default async function run() {
  testPlans();
  dockerByPlatform();
  const covered = ciParts({ underCoverage: true, passed: ['--changed', 'A', 'B'], env, platform: 'linux' });
  assert.deepStrictEqual(covered.map(({ name }) => name),
    ['suite', 'repro', 'integration', 'docker', 'repro, rebuilds dist/ (not covered)', 'coverage build again', 'copied scripts mapped again']);
  for (const part of covered.slice(0, 3)) {
    assert.ok(part.args.includes('--without-timed'), `${part.name} leaves its timed tests out`);
    assert.deepStrictEqual(part.args.slice(-3), ['--changed', 'A', 'B'], `${part.name} gets the arguments run-ci.js was given`);
    assert.strictEqual(part.env, undefined, `${part.name} runs under coverage, in run-ci.js's own environment`);
  }
  assert.deepStrictEqual(covered.map(script).slice(0, 4), ['run-all-tests.js', 'run-repro.js', 'run-all-integration-tests.js', 'run-docker-tests.js']);
  assert.ok(covered[0].args.includes('--no-build'), 'the suite doesn\'t build again: the coverage build is already there');
  const repro = covered[1].args;
  assert.strictEqual(repro[repro.indexOf('--skip') + 1], 'test-release-packages-ship-contract.js', 'the release repro is left out of the covered repro part');
  assert.ok(!('NODE_V8_COVERAGE' in covered[3].env) && covered[3].args.slice(-3).join(' ') === '--changed A B', 'docker runs uncovered, with the arguments given');

  const release = covered[4];
  assert.ok(release.args.includes('test-release-packages-ship-contract.js') && script(release) === 'run-repro.js', 'the release repro, through run-repro.js');
  assert.ok(!('NODE_V8_COVERAGE' in release.env) && release.env.PATH === '/bin', 'it runs uncovered, in the rest of the environment');
  assert.ok(Number(release.env.REPRO_TIMEOUT_MS) >= 600_000,
    'a hang guard of 10 minutes: its two npm installs, with an empty cache, outlast 3 on GitHub\'s Windows');
  // Its npm cache: one CI names (REPRO_NPM_CACHE), else a new one; from an empty cache its first install took 522 s on GitHub's Windows
  const releaseRepro = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'repro', 'test-release-packages-ship-contract.js'), 'utf8');
  assert.ok(releaseRepro.includes('npm_config_cache: process.env.REPRO_NPM_CACHE ||'), 'the release repro takes the npm cache it\'s given');
  for (const part of covered.slice(3)) assert.ok(!('NODE_V8_COVERAGE' in part.env), `${part.name} runs uncovered`);
  assert.deepStrictEqual(covered.slice(5).map(script), ['tsc', 'map-copied-scripts.js'], 'then the coverage build again, its copied scripts mapped');
  console.log('✓ under coverage: three parts without their timed tests and Docker\'s uncovered, then the release repro uncovered, then the coverage build again');

  const plain = ciParts({ underCoverage: false, passed: [], env: { PATH: '/bin' }, platform: 'linux' });
  assert.deepStrictEqual(plain.map(({ name }) => name), ['suite', 'repro', 'integration', 'docker'], 'without coverage: four parts');
  assert.ok(!plain[1].args.includes('--skip'), 'the release repro runs with the other repro scripts');
  console.log('✓ without coverage: the four parts, the release repro among the repro scripts');

  // The reports on disk, as a stand-in: a part that runs writes its report (results.json), unless the case says not
  const onDisk = new Set();
  const files = { exists: (file) => onDisk.has(file), remove: (file) => onDisk.delete(file) };
  const writes = (part) => { if (part.report) onDisk.add(part.report); };

  // Every part runs, even after a failure; any failure fails the run
  const ran = [];
  const lines = [];
  const code = await runParts(covered, {
    runPart: async (part) => { ran.push(part.name); writes(part); return part.name === 'repro' ? 1 : 0; }, log: (line) => lines.push(line), files,
  });
  assert.strictEqual(ran.length, covered.length, 'every part ran after the failed one');
  assert.strictEqual(code, 1, 'a failed part fails the run');
  assert.ok(lines.includes('✗ repro (exit 1)') && lines.includes('✓ suite (exit 0)'), 'the summary names each part and its exit');
  assert.strictEqual(await runParts(plain, { runPart: async (part) => { writes(part); return 0; }, log: () => {}, files }), 0, 'all parts passing pass the run');
  console.log('✓ every part runs; any failure fails the run');

  // Fail closed: each test part names its report; one that exits 0 without writing it fails the run, and an
  // earlier run's report left on disk doesn't count
  assert.ok(covered.slice(0, 5).every((part) => part.report?.endsWith('results.json')), 'each test part names its results.json');
  assert.deepStrictEqual(covered.slice(5).map((part) => part.report), [undefined, undefined], 'the build parts write none');
  assert.ok(planFor('timed', { underCoverage: false, env, platform: 'linux' }).every((part) => part.report), 'the timed parts too');
  onDisk.clear();
  onDisk.add(covered[2].report);
  const closedLines = [];
  const closed = await runParts(covered, {
    runPart: async (part) => { if (part.name !== 'integration') writes(part); return 0; }, log: (line) => closedLines.push(line), files,
  });
  assert.strictEqual(closed, 1, 'a part that left no results fails the run');
  assert.ok(closedLines.some((line) => line.startsWith('✗ integration (exit 0, no results: ') && line.includes('integration/results.json')), closedLines.join('\n'));
  console.log('✓ fail closed: a test part that exits 0 without its results.json fails the run');
}

runIfMain(import.meta.url, run);
