/**
 * Integration test runner.
 *
 * Runs long-running MCP integration tests under test/integration. These are
 * intentionally excluded from the default test/run-all-tests.js discovery.
 * Each file runs through Node's test runner (helpers/node-test-runner.js) in its
 * own process, with its own temporary home. Options as test/run-all-tests.js
 * takes them: --changed [A [B]], --shard <i>/<n>, --skip <name>, --timed and
 * --without-timed (test/timed.txt names its files as integration/<name>), --out
 * <dir> (default test-results/integration).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { byTimed, findTests, ROOT, readRunnerArgs, runTestFiles, withoutExcluded, withoutSkipped } from '../helpers/node-test-runner.js';
import { selectForRunner } from '../helpers/select-tests.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function formatDuration(duration) {
  return `${duration}ms (${(duration / 1000).toFixed(1)}s)`;
}

async function main() {
  const options = readRunnerArgs(process.argv.slice(2), path.join(ROOT, 'test-results', 'integration'));
  // The files named on the command line, so one test can run isolated too, excluded or
  // not; else all of them, less test/excluded.txt's
  const requested = options.names.map((file) => path.basename(file));
  const found = requested.length > 0 ? [] : findTests('integration', __dirname);
  let files = requested.length > 0 ? requested : withoutExcluded(found, 'integration');
  const excluded = found.filter((file) => !files.includes(file));
  files = withoutSkipped(byTimed(files, options, 'integration'), options);
  if (options.values.changed) {
    files = selectForRunner({ dir: __dirname, names: files, commits: options.values.changed, outDir: options.outDir });
  }

  if (files.length === 0) {
    console.log('No integration tests found.');
    await runTestFiles({ dir: __dirname, files: [], outDir: options.outDir, suiteName: 'integration', excluded });
    return;
  }

  console.log(`Found ${files.length} integration test file(s):`);
  for (const file of files) {
    console.log(`  - ${file}`);
  }

  const results = await runTestFiles({
    dir: __dirname,
    files: files.map((file) => `./${file}`),
    outDir: options.outDir,
    suiteName: 'integration',
    shard: options.shard,
    excluded,
    onFileStart: (file) => console.log(`\nRunning integration test: ${file}`),
    onFileEnd: (result) => {
      if (result.success) {
        console.log(`PASS ${result.file} (${result.duration}ms)`);
      } else {
        console.error(`FAIL ${result.file} (${result.duration}ms, exit code ${result.exitCode})`);
      }
    },
  });

  const failed = results.filter((result) => !result.success);
  const totalDuration = results.reduce((sum, result) => sum + result.duration, 0);

  console.log('\nIntegration test timings:');
  for (const result of results) {
    const status = result.success ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${result.file}: ${formatDuration(result.duration)}`);
  }

  console.log(`\nIntegration test summary: ${results.length - failed.length}/${results.length} passed (${formatDuration(totalDuration)})`);
  console.log(`Reports: ${path.relative(ROOT, options.outDir)}/junit.xml, results.json, results.tap`);
  if (failed.length > 0) {
    for (const result of failed) {
      console.error(`  - ${result.file}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Integration test runner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
