/**
 * Runs what CI runs, one after another: the suite, the repro scripts and the
 * integration tests, without the timed tests in test/timed.txt, and Docker's tests
 * on Linux (elsewhere it records why they didn't run). Each runner writes its
 * reports in test-results/<suite|repro|integration|docker>/. Every part runs even
 * when one fails; exits 1 if any did.
 *
 *   node test/run-ci.js [--changed [A [B]]]   # build first: npm run build (or build:coverage)
 *   TESTS=<value> node test/run-ci.js         # what an on-demand run's `tests` asks for
 *
 * TESTS (planFor): empty for all of the above, or test, integration, repro,
 * docker, timed, changed:A..B or files:a.js,b.js. `npm run test:coverage` runs
 * this under c8 (test/run-coverage.js).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Repro scripts that rebuild dist/ while they run: npm 10's `npm pack` runs the
 * prepare build, which drops the coverage build's source maps, and every file
 * loaded after it would report as dist/. Under coverage (c8 sets NODE_V8_COVERAGE)
 * they run last and uncovered, and then the coverage build is made again, so
 * the report's 0 % list reads mapped files.
 */
const REBUILD_DIST = ['test-release-packages-ship-contract.js'];
// Their hang guard (run-repro.js's REPRO_TIMEOUT_MS, 3 minutes by default): the
// release repro's two npm installs, with an empty npm cache, take longer on
// GitHub's Windows
const REBUILD_DIST_TIMEOUT_MS = 600_000;
const DOCKER_RUNNER = path.join(__dirname, 'docker', 'run-docker-tests.js');
// The results.json a test part's runner writes: its default --out, or the release repro's own
const report = (folder) => path.join(ROOT, 'test-results', folder, 'results.json');

/** Under coverage: the release repro, uncovered, then the coverage build again */
function rebuildParts({ passed, uncovered }) {
  return [
    {
      name: 'repro, rebuilds dist/ (not covered)',
      args: [path.join(__dirname, 'repro', 'run-repro.js'), ...REBUILD_DIST, '--out', path.join(ROOT, 'test-results', 'repro-rebuilds-dist'), ...passed],
      env: { ...uncovered, REPRO_TIMEOUT_MS: String(REBUILD_DIST_TIMEOUT_MS) },
      report: report('repro-rebuilds-dist'),
    },
    {
      name: 'coverage build again',
      args: [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'tsconfig.coverage.json')],
      env: uncovered,
    },
    { name: 'copied scripts mapped again', args: [path.join(__dirname, 'map-copied-scripts.js')], env: uncovered },
  ];
}

/**
 * Docker's tests (test/docker/), on Linux, with `args`; on another platform the
 * runner only records why they didn't run, in its reports. They run
 * outside coverage: one checks the shell installers (install-docker.sh and .ps1),
 * which coverage can't count, and the other runs the same server code inside the
 * image, where c8 doesn't reach.
 */
function dockerPart({ platform, env, uncovered, args }) {
  if (platform === 'linux') return { name: 'docker', args: [DOCKER_RUNNER, ...args], env: uncovered, report: report('docker') };
  const where = { darwin: 'macOS', win32: 'Windows' }[platform] ?? platform;
  let reason = `Docker's tests run on Linux only, not on ${where}`;
  if (env.GITHUB_ACTIONS === 'true') {
    reason = platform === 'win32' ? 'GitHub\'s Windows runner has no Docker for Linux containers' : `GitHub's ${where} runner has no Docker`;
  }
  return { name: 'docker', args: [DOCKER_RUNNER, '--not-run', reason], env: uncovered, report: report('docker') };
}

/**
 * What a push or label run runs, in order: { name, args (node's), env (none:
 * run-ci.js's own), report (a test part's results.json) }. With no Docker test
 * at this commit, Docker's part passes and says so.
 */
export function ciParts({ underCoverage, passed = [], env = process.env, platform = process.platform }) {
  const { NODE_V8_COVERAGE, ...uncovered } = env;
  const skipRebuilders = underCoverage ? REBUILD_DIST.flatMap((name) => ['--skip', name]) : [];
  return [
    { name: 'suite', args: [path.join(__dirname, 'run-all-tests.js'), '--no-build', '--without-timed', ...passed], report: report('suite') },
    { name: 'repro', args: [path.join(__dirname, 'repro', 'run-repro.js'), '--without-timed', ...skipRebuilders, ...passed], report: report('repro') },
    {
      name: 'integration',
      args: [path.join(__dirname, 'integration', 'run-all-integration-tests.js'), '--without-timed', ...passed],
      report: report('integration'),
    },
    dockerPart({ platform, env, uncovered, args: ['--none-ok', '--without-timed', ...passed] }),
    ...(underCoverage ? rebuildParts({ passed, uncovered }) : []),
  ];
}

const TESTS_VALUES = 'empty (everything but the timed tests), test, integration, repro, docker, timed, changed:A..B or files:a.js,b.js';

/** The parts that run named files: each through its folder's runner (a suite file has no folder) */
function filesParts(files, { underCoverage, env, platform }) {
  const { NODE_V8_COVERAGE, ...uncovered } = env;
  const byFolder = { suite: [], repro: [], integration: [], docker: [] };
  for (const file of files) {
    const parts = file.replace(/^test\//, '').split('/');
    const folder = parts.length === 1 ? 'suite' : parts[0];
    if (!byFolder[folder] || parts.length > 2 || !/\.js$/.test(file)) {
      throw new Error(`tests: "${file}" isn't a test file in test/, test/repro/, test/integration/ or test/docker/`);
    }
    byFolder[folder].push(parts.at(-1));
  }
  const rebuilders = underCoverage ? byFolder.repro.filter((name) => REBUILD_DIST.includes(name)) : [];
  const repro = byFolder.repro.filter((name) => !rebuilders.includes(name));
  return [
    byFolder.suite.length && { name: 'suite', args: [path.join(__dirname, 'run-all-tests.js'), '--no-build', ...byFolder.suite], report: report('suite') },
    repro.length && { name: 'repro', args: [path.join(__dirname, 'repro', 'run-repro.js'), ...repro], report: report('repro') },
    byFolder.integration.length && {
      name: 'integration', args: [path.join(__dirname, 'integration', 'run-all-integration-tests.js'), ...byFolder.integration], report: report('integration'),
    },
    byFolder.docker.length && dockerPart({ platform, env, uncovered, args: byFolder.docker }),
    ...(rebuilders.length ? rebuildParts({ passed: [], uncovered }) : []),
  ].filter(Boolean);
}

/**
 * The parts an on-demand run's `tests` value asks for, through the runners' own
 * options; empty, the default, is what a push or label run runs. An unknown value
 * stops with what it can be.
 */
export function planFor(tests, { underCoverage, env = process.env, platform = process.platform }) {
  const value = (tests ?? '').trim();
  const { NODE_V8_COVERAGE, ...uncovered } = env;
  const everything = ciParts({ underCoverage, env, platform });
  if (value === '') return everything;
  if (value === 'test') return everything.filter(({ name }) => name === 'suite');
  if (value === 'integration') return everything.filter(({ name }) => name === 'integration');
  if (value === 'repro') return everything.filter(({ name }) => name.startsWith('repro') || name.includes('again'));
  // Asked for: with no Docker test to run, it fails
  if (value === 'docker') return [dockerPart({ platform, env, uncovered, args: [] })];
  if (value === 'timed') {
    return [
      { name: 'suite, timed', args: [path.join(__dirname, 'run-all-tests.js'), '--no-build', '--timed'], report: report('suite') },
      { name: 'repro, timed', args: [path.join(__dirname, 'repro', 'run-repro.js'), '--timed'], report: report('repro') },
      { name: 'integration, timed', args: [path.join(__dirname, 'integration', 'run-all-integration-tests.js'), '--timed'], report: report('integration') },
    ];
  }
  if (value.startsWith('changed:')) {
    const [from, to, ...rest] = value.slice('changed:'.length).split('..');
    if (from && to && rest.length === 0) return ciParts({ underCoverage, passed: ['--changed', from, to], env, platform });
  }
  if (value.startsWith('files:')) {
    const files = value.slice('files:'.length).split(',').map((file) => file.trim()).filter(Boolean);
    if (files.length > 0) return filesParts(files, { underCoverage, env, platform });
  }
  throw new Error(`tests: "${value}" isn't one of: ${TESTS_VALUES}`);
}

const onDisk = { exists: fs.existsSync, remove: (file) => fs.rmSync(file, { force: true }) };

/**
 * Runs every part, even after a failure, prints a line per part; returns 1 if any
 * failed. Fail closed: a test part's report is removed before it runs, and a part
 * that exits 0 without writing it fails ("no results"), so an earlier run's report
 * can't stand in for it. `files`: the disk, or a test's stand-in.
 */
export async function runParts(parts, { runPart, log = console.log, files = onDisk }) {
  const codes = [];
  for (const part of parts) {
    log(`\n########## ${part.name} ##########\n`);
    if (part.report) files.remove(part.report);
    const code = await runPart(part);
    const missing = code === 0 && part.report && !files.exists(part.report);
    codes.push({ name: part.name, code, failed: code !== 0 || missing, note: missing ? `, no results: ${path.relative(ROOT, part.report).split(path.sep).join('/')}` : '' });
  }
  log('\n########## CI parts ##########');
  for (const { name, code, failed, note } of codes) log(`${failed ? '✗' : '✓'} ${name} (exit ${code}${note})`);
  return codes.some(({ failed }) => failed) ? 1 : 0;
}

function spawnPart({ args, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT, env: env ?? process.env });
    child.on('close', (code) => resolve(code));
    child.on('error', (error) => {
      console.error(error.message);
      resolve(1);
    });
  });
}

// Real paths on both sides: started through a symlink or junction, it still runs
if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  const underCoverage = Boolean(process.env.NODE_V8_COVERAGE);
  const passed = process.argv.slice(2);
  let parts;
  try {
    // An on-demand run's tests value; otherwise, as on a push, every part with the arguments given
    parts = process.env.TESTS ? planFor(process.env.TESTS, { underCoverage }) : ciParts({ underCoverage, passed });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  process.exit(await runParts(parts, { runPart: spawnPart }));
}
