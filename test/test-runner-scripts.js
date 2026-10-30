/**
 * The runner scripts themselves, each started as CI starts it, on a small choice
 * of files, each writing its reports where --out says:
 * - run-all-tests.js keeps the files named, less a timed one and a skipped one;
 * - repro/run-repro.js keeps the scripts named, less a timed one;
 * - the integration runner, --timed, runs none (none of its files is timed);
 * - the Docker runner fails with nothing to run, but not with --none-ok (a run
 *   of everything), and --not-run <reason> records why Docker's tests didn't
 *   run on this platform;
 * - the suite finds *.test.js files too, leaves test/excluded.txt's out and
 *   lists them in its reports with their reasons, and runs one named anyway.
 * The test-home hook gives a test file its own temporary home, and a process the
 * file forks keeps it. Each runs in a process of its own.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { ROOT, timedNames } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir, createTestEnv, withEnv } from './helpers/test-env.js';

// Without this file's own test home and node:test context, as CI starts a runner
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NODE_TEST_CONTEXT|DC_TEST_)/.test(name)));

/** A runner script with its arguments: its exit code, output and results.json */
function runner(script, args, outDir, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'test', ...script.split('/')), ...args, '--out', outDir],
    { cwd: ROOT, env: { ...cleanEnv(), ...env }, encoding: 'utf8', timeout: 180_000 });
  const reportFile = path.join(outDir, 'results.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : undefined;
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    files: report?.files.map(({ file, success }) => [path.basename(file), success]),
    notRun: report?.notRun,
    excluded: report?.excluded,
  };
}

export default async function run() {
  const dir = createTempDir('dc-runner-scripts-');
  try {
    const timed = timedNames();
    const suiteTimed = timed.find((name) => !name.includes('/'));
    const reproTimed = path.basename(timed.find((name) => name.startsWith('repro/')));

    // The suite runner: the files named, less the timed one and the skipped one
    const suite = runner('run-all-tests.js', ['--no-build', '--without-timed', '--skip', 'test-ci-comment.js', suiteTimed, 'test-coverage-areas.js', 'test-ci-comment.js'],
      path.join(dir, 'suite'));
    assert.strictEqual(suite.status, 0, suite.output.slice(-2000));
    assert.deepStrictEqual(suite.files, [['test-coverage-areas.js', true]], `the suite ran only test-coverage-areas.js:\n${suite.output.slice(-1500)}`);
    console.log('✓ run-all-tests.js: the files named, without the timed and the skipped ones, its reports in --out');

    const repro = runner('repro/run-repro.js', ['--without-timed', reproTimed, 'test-dc-tracking-gate.js'], path.join(dir, 'repro'));
    assert.strictEqual(repro.status, 0, repro.output.slice(-2000));
    assert.deepStrictEqual(repro.files, [['test-dc-tracking-gate.js', true]], `the repro runner ran only test-dc-tracking-gate.js:\n${repro.output.slice(-1500)}`);
    console.log('✓ repro/run-repro.js: the scripts named, without the timed one');

    // The integration runner: --timed with no timed integration test runs nothing, and passes
    const integration = runner('integration/run-all-integration-tests.js', ['--timed'], path.join(dir, 'integration'));
    assert.strictEqual(integration.status, 0, integration.output.slice(-2000));
    assert.deepStrictEqual(integration.files, [], 'no integration file is timed: none ran, and the reports say so');
    console.log('✓ the integration runner: --timed, and none of its files is timed');

    // The Docker runner: with nothing left to run it fails, since the run asked for Docker's tests
    const dockerDir = path.join(ROOT, 'test', 'docker');
    const dockerTests = fs.readdirSync(dockerDir).filter((file) => file.startsWith('test-') && file.endsWith('.js'));
    const docker = runner('docker/run-docker-tests.js', dockerTests.flatMap((file) => ['--skip', file]), path.join(dir, 'docker'));
    assert.strictEqual(docker.status, 1, `nothing to run fails:\n${docker.output}`);
    assert.ok(docker.output.includes('No Docker tests to run') && Array.isArray(docker.files) && docker.files.length === 0, docker.output);
    // A run of everything (no tests value): with none to run it passes, and its reports say why
    const noneOk = runner('docker/run-docker-tests.js', ['--none-ok', ...dockerTests.flatMap((file) => ['--skip', file])], path.join(dir, 'docker-none-ok'));
    assert.strictEqual(noneOk.status, 0, `--none-ok: nothing to run passes:\n${noneOk.output}`);
    assert.ok(noneOk.files.length === 0 && /no Docker tests/.test(noneOk.notRun ?? ''), `its reports say so: ${noneOk.notRun}`);
    // On a platform without Docker: nothing runs, and the reports carry the reason for the PR comment
    const reason = 'GitHub\'s macOS runner has no Docker';
    const notHere = runner('docker/run-docker-tests.js', ['--not-run', reason], path.join(dir, 'docker-not-here'));
    assert.strictEqual(notHere.status, 0, notHere.output);
    assert.ok(notHere.files.length === 0 && notHere.notRun === reason && notHere.output.includes(reason), `the reason, in the reports and the output: ${notHere.notRun}`);
    console.log('✓ the Docker runner: nothing to run fails, unless --none-ok; --not-run records why, its reports written');
    for (const [name, ran] of Object.entries({ suite, repro, integration, docker, noneOk, notHere })) {
      assert.deepStrictEqual(ran.excluded, [], `${name}: test/excluded.txt leaves nothing out, and the reports say so`);
    }

    // The excluded tests: left out of the files the suite finds, and listed with their reasons;
    // a file named on the command line still runs. The lists come from DC_TEST_LISTS_DIR.
    const lists = path.join(dir, 'lists');
    fs.mkdirSync(lists);
    fs.copyFileSync(path.join(ROOT, 'test', 'timed.txt'), path.join(lists, 'timed.txt'));
    fs.writeFileSync(path.join(lists, 'excluded.txt'), [
      '# Two of the suite\'s files, one of them named *.test.js',
      'remote-launchers.test.js  # a stand-in reason',
      'test-check-coverage-report.js  # another',
    ].join('\n'));
    const kept = ['test-coverage-areas.js', 'test-check-coverage-report.js', 'remote-launchers.test.js'];
    const others = fs.readdirSync(path.join(ROOT, 'test'))
      .filter((file) => file.endsWith('.js') && (file.startsWith('test') || file.endsWith('.test.js')) && !kept.includes(file));
    const excluding = runner('run-all-tests.js', ['--no-build', ...others.flatMap((file) => ['--skip', file])], path.join(dir, 'excluding'), { DC_TEST_LISTS_DIR: lists });
    assert.strictEqual(excluding.status, 0, excluding.output.slice(-2000));
    assert.deepStrictEqual(excluding.files, [['test-coverage-areas.js', true]], `only the file that isn't excluded ran:\n${excluding.output.slice(-1500)}`);
    assert.deepStrictEqual(excluding.excluded, [
      { name: 'remote-launchers.test.js', reason: 'a stand-in reason' },
      { name: 'test-check-coverage-report.js', reason: 'another' },
    ], 'the reports list each excluded file with its reason: the suite finds *.test.js files too');
    const named = runner('run-all-tests.js', ['--no-build', 'test-check-coverage-report.js'], path.join(dir, 'named'), { DC_TEST_LISTS_DIR: lists });
    assert.strictEqual(named.status, 0, named.output.slice(-2000));
    assert.deepStrictEqual([named.files, named.excluded], [[['test-check-coverage-report.js', true]], []], 'an excluded file named on the command line runs');
    console.log('✓ the excluded tests: left out of what the suite finds (*.test.js included), listed with their reasons; one named still runs');

    // The repro and integration runners leave out their own folder's excluded tests too (test/docker/ has none to name yet)
    for (const [script, folder, file] of [['repro/run-repro.js', 'repro', 'test-dc-tracking-gate.js'], ['integration/run-all-integration-tests.js', 'integration', 'read-file-unknown-params.js']]) {
      fs.writeFileSync(path.join(lists, 'excluded.txt'), `${folder}/${file}  # a stand-in reason\n`);
      const folderFiles = fs.readdirSync(path.join(ROOT, 'test', folder)).filter((name) => name.endsWith('.js') && name !== file && name !== path.basename(script));
      const left = runner(script, folderFiles.flatMap((name) => ['--skip', name]), path.join(dir, `excluding-${folder}`), { DC_TEST_LISTS_DIR: lists });
      assert.strictEqual(left.status, 0, left.output.slice(-2000));
      assert.deepStrictEqual([left.files, left.excluded], [[], [{ name: `${folder}/${file}`, reason: 'a stand-in reason' }]], `${script}: its excluded file left out, and listed`);
    }
    console.log('✓ the repro and integration runners leave out their own excluded tests, and list them');

    // The test-home hook: a temporary home before the file's own code, its skip record in the run's folder
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(dir, 'home-probe.mjs'), [
      "import { fork } from 'child_process';",
      "const own = { home: process.env.HOME, profile: process.env.USERPROFILE, set: process.env.DC_TEST_HOME_SET,",
      "  skips: process.env.DC_TEST_SKIP_FILE, telemetry: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY, color: process.env.FORCE_COLOR,",
      "  xdgConfig: process.env.XDG_CONFIG_HOME };",
      "if (process.argv[2] === 'child') { console.log(JSON.stringify(own)); process.exit(0); }",
      "const child = fork(process.argv[1], ['child'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });",
      "let out = ''; child.stdout.on('data', (chunk) => { out += chunk; });",
      "child.on('close', () => console.log(JSON.stringify({ ...own, child: JSON.parse(out) })));",
    ].join('\n'));
    const hook = pathToFileURL(path.join(ROOT, 'test', 'helpers', 'test-home.js')).href;
    // This file's own test home, under the runner: the probe's must be another
    const ownHome = process.env.HOME ?? process.env.USERPROFILE;
    // Without the telemetry setting this process has, so only the hook can turn telemetry off
    const { DESKTOP_COMMANDER_DISABLE_TELEMETRY, ...withoutTelemetry } = cleanEnv();
    const probe = spawnSync(process.execPath, ['--import', hook, path.join(dir, 'home-probe.mjs')],
      { cwd: dir, env: { ...withoutTelemetry, DC_TEST_RUN_DIR: runDir, FORCE_COLOR: '1', XDG_CONFIG_HOME: path.join(dir, 'real-config') }, encoding: 'utf8', timeout: 60_000 });
    assert.strictEqual(probe.status, 0, `${probe.stdout}${probe.stderr}`);
    const seen = JSON.parse(probe.stdout.trim().split('\n').at(-1));
    assert.ok(seen.home && seen.home !== ownHome && seen.home === seen.profile, `a home of its own, as HOME and USERPROFILE: ${seen.home}`);
    assert.ok(path.basename(seen.home).startsWith('dc-test-home-'), `a temporary test home (createTestEnv's): ${seen.home}`);
    assert.strictEqual(seen.set, '1');
    assert.strictEqual(seen.skips, path.join(runDir, 'home-probe.mjs.skips.txt'), 'skip() records into the run\'s folder');
    assert.strictEqual(seen.telemetry, '1', 'telemetry off');
    assert.strictEqual(seen.color, undefined, 'no FORCE_COLOR');
    // A runner's XDG_CONFIG_HOME (GitHub's Linux sets one) would put pwsh's profile, and other tools' settings, outside the test home
    assert.strictEqual(seen.xdgConfig, undefined, 'no XDG_CONFIG_HOME: a tool\'s settings go under the test home');
    assert.strictEqual(seen.child.xdgConfig, undefined, 'none in a forked process either');
    assert.strictEqual(fs.readFileSync(path.join(runDir, 'home-probe.mjs.home.txt'), 'utf8'), seen.home, 'the run\'s folder names the home, for the runner to remove');
    assert.strictEqual(seen.child.home, seen.home, 'a forked process keeps the home it was given');
    assert.ok(!fs.existsSync(seen.home), 'the home is gone when the file\'s process ends');
    await withEnv({ XDG_CONFIG_HOME: path.join(dir, 'real-config'), FORCE_COLOR: '1' }, async () => {
      const testEnv = createTestEnv();
      testEnv.cleanup();
      assert.ok(!('XDG_CONFIG_HOME' in testEnv.env) && !('FORCE_COLOR' in testEnv.env), 'createTestEnv leaves out XDG_CONFIG_HOME and FORCE_COLOR');
    });
    console.log('✓ test-home.js: a temporary home of its own, the skip record in the run\'s folder, kept by a forked process, gone at exit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
