/**
 * Docker test runner: the test-*.js files in test/docker/, which need Docker
 * (they build the image and start containers), so no other runner reads this
 * folder. test/run-ci.js starts it on Linux, in what a push runs and for
 * tests=docker.
 * Each file runs through Node's test runner (helpers/node-test-runner.js) in its
 * own process, with its own temporary home. Options as test/run-all-tests.js
 * takes them: --changed [A [B]], --shard <i>/<n>, --skip <name>, --timed and
 * --without-timed (test/timed.txt names its files as docker/<name>), --out <dir>
 * (default test-results/docker). And its own:
 *   --none-ok          with no Docker test to run, pass and say so (a run of
 *                      everything); without it, that fails: the run asked for them
 *   --not-run <reason> run nothing and record why in the reports (results.json's
 *                      notRun), for the PR comment: Docker's tests on a platform
 *                      without Docker
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { byTimed, ROOT, readRunnerArgs, runTestFiles, testsIn, withoutExcluded, withoutSkipped } from '../helpers/node-test-runner.js';
import { selectForRunner } from '../helpers/select-tests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Empty reports, with why nothing ran in results.json's notRun, and the tests test/excluded.txt left out */
async function notRun(outDir, reason, excluded = []) {
  await runTestFiles({ dir: __dirname, files: [], outDir, suiteName: 'docker', excluded });
  const reportFile = path.join(outDir, 'results.json');
  fs.writeFileSync(reportFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(reportFile, 'utf8')), notRun: reason }, null, 2)}\n`);
  console.log(`Docker's tests didn't run: ${reason}`);
}

async function main() {
  // --not-run takes a reason with spaces in it: out of the arguments before the shared options read them
  const argv = process.argv.slice(2);
  const notRunAt = argv.indexOf('--not-run');
  const reason = notRunAt >= 0 ? argv.splice(notRunAt, 2)[1] : undefined;
  const options = readRunnerArgs(argv, path.join(ROOT, 'test-results', 'docker'));
  if (reason !== undefined) return notRun(options.outDir, reason);

  // The files named on the command line, by file name as the other runners take them, excluded
  // or not; else every test-*.js here, less test/excluded.txt's
  const requested = options.names.map((file) => path.basename(file));
  const here = testsIn('docker', await fsp.readdir(__dirname));
  const found = requested.length > 0 ? requested : withoutExcluded(here, 'docker');
  const excluded = requested.length > 0 ? [] : here.filter((file) => !found.includes(file));
  let files = withoutSkipped(byTimed(found, options, 'docker'), options);
  if (options.values.changed) {
    files = selectForRunner({ dir: __dirname, names: files, commits: options.values.changed, outDir: options.outDir });
  }

  if (files.length === 0) {
    const why = here.length === 0 ? 'no Docker tests at this commit' : 'no Docker tests left to run';
    if (options.flags.has('--none-ok')) return notRun(options.outDir, why, excluded);
    await runTestFiles({ dir: __dirname, files: [], outDir: options.outDir, suiteName: 'docker', excluded });
    console.error(`No Docker tests to run: ${why}, and the run asked for them.`);
    process.exit(1);
  }

  console.log(`Found ${files.length} Docker test file(s):`);
  for (const file of files) console.log(`  - ${file}`);
  const results = await runTestFiles({
    dir: __dirname,
    files: files.map((file) => `./${file}`),
    outDir: options.outDir,
    suiteName: 'docker',
    shard: options.shard,
    excluded,
    onFileStart: (file) => console.log(`\nRunning Docker test: ${file}`),
    onFileEnd: (result) => console.log(`${result.success ? 'PASS' : 'FAIL'} ${result.file} (${result.duration}ms${result.success ? '' : `, exit code ${result.exitCode}`})`),
  });

  const failed = results.filter((result) => !result.success);
  console.log(`\nDocker test summary: ${results.length - failed.length}/${results.length} passed`);
  console.log(`Reports: ${path.relative(ROOT, options.outDir)}/junit.xml, results.json, results.tap`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`Docker test runner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
