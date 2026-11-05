/**
 * Runs the repro scripts in this folder, each in its own process with an
 * isolated temporary home (so none can touch the real Desktop Commander
 * config), and reports each script's exit code.
 *
 * Usage:
 *   node test/repro/run-repro.js                              # every script
 *   node test/repro/run-repro.js test-dc-tracking-gate.js ... # selected scripts
 * Options as test/run-all-tests.js takes them: --without-timed, --timed,
 * --changed [A [B]], --shard <i>/<n>, --skip <name>, --out <dir> (default test-results/repro).
 * Variables such as UV_THREADPOOL_SIZE, BLOCKERS or DC_REPRO_REALTIME are passed through.
 * A script still running after REPRO_TIMEOUT_MS (default 180000) is stopped and fails.
 * Exit 0 means the script's documented expectation held (see its header): for most,
 * that a problem does not show; for the hazard demos, that the hazard shows.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { byTimed, findTests, ROOT, readRunnerArgs, runTestFiles, withoutExcluded, withoutSkipped } from '../helpers/node-test-runner.js';
import { selectForRunner } from '../helpers/select-tests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_TIME_LIMIT_MS = Number(process.env.REPRO_TIMEOUT_MS) || 180_000;

const options = readRunnerArgs(process.argv.slice(2), path.join(ROOT, 'test-results', 'repro'));

// The scripts named on the command line, by file name as the other runners take them
// (so test/repro/test-x.js from the repository root works too), excluded or not; else
// every test-*.js here, less test/excluded.txt's
const requested = options.names.map((file) => path.basename(file));
const found = requested.length > 0 ? [] : findTests('repro', __dirname);
let files = requested.length > 0 ? requested : withoutExcluded(found, 'repro');
const excluded = found.filter((file) => !files.includes(file));
files = withoutSkipped(byTimed(files, options, 'repro'), options);
if (options.values.changed) {
  files = selectForRunner({ dir: __dirname, names: files, commits: options.values.changed, outDir: options.outDir });
}

const results = await runTestFiles({
  dir: __dirname,
  files,
  outDir: options.outDir,
  suiteName: 'repro',
  timeoutMs: SCRIPT_TIME_LIMIT_MS,
  shard: options.shard,
  excluded,
  onFileStart: (file) => console.log(`\n===== ${file} =====`),
  onFileEnd: ({ file, exitCode }) => {
    if (exitCode === 'timeout') console.error(`\n${file} still running after ${SCRIPT_TIME_LIMIT_MS}ms: stopped it`);
  },
});

console.log('\n===== REPRO SUMMARY =====');
for (const { file, exitCode, duration } of results) {
  console.log(`${exitCode === 0 ? '✓' : '✗'} ${file} (exit ${exitCode}, ${duration}ms)`);
}
console.log(`Reports: ${path.relative(ROOT, options.outDir)}/junit.xml, results.json, results.tap`);
process.exit(results.every((result) => result.exitCode === 0) ? 0 : 1);
