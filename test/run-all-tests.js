/**
 * Main test runner script
 * Runs all test modules and provides comprehensive summary
 *
 *   node test/run-all-tests.js [options] [test files]
 *     test files           names in test/, run even if excluded (default: every test*.js
 *                          and *.test.js, less test/excluded.txt's)
 *     --no-build           skip `npm run build` (the files test dist/: build first)
 *     --without-timed      leave out the timed tests in test/timed.txt (they run on a quiet machine)
 *     --timed              only the timed tests in test/timed.txt
 *     --changed [A [B]]    only the files that reach a changed file: the commits
 *                          since A (default: where HEAD left origin/main) plus
 *                          uncommitted changes; with B, only what changed from A to
 *                          B, the same answer on any machine run at B. See helpers/select-tests.js
 *     --shard <i>/<n>      the i-th of n parts of the files
 *     --skip <name>        leave that file out (any number of times)
 *     --out <dir>          where junit.xml, results.json and results.tap go (default test-results/suite)
 *
 * Each file runs through Node's test runner (helpers/node-test-runner.js) in its
 * own process from test/, with its own temporary home; it passes when it exits with 0.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { byTimed, findTests, ROOT, readRunnerArgs, runTestFiles, withoutExcluded, withoutSkipped } from './helpers/node-test-runner.js';
import { selectForRunner } from './helpers/select-tests.js';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m'
};

/**
 * Run a command and return its output
 */
function runCommand(command, args, cwd = __dirname) {
  return new Promise((resolve, reject) => {
    const commandLine = [command, ...args].join(' ');
    console.log(`${colors.blue}Running command: ${commandLine}${colors.reset}`);

    // One command string: with shell: true, Node 24 deprecates separate args (DEP0190)
    const proc = spawn(commandLine, {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/** The line each file gets when it starts, and its result line when it ends */
function printFileStart(testFile) {
  console.log(`\n${colors.cyan}Running test module: ${testFile}${colors.reset}`);
}

function printFileEnd(result) {
  const { file, duration, exitCode, skipped } = result;
  if (result.success) {
    console.log(`${colors.green}✓ Test passed: ${file} (${duration}ms)${colors.reset}`);
    if (skipped.length > 0) {
      console.log(`${colors.yellow}⚠️  ${skipped.length} check(s) skipped in ${file}${colors.reset}`);
    }
  } else {
    console.error(`${colors.red}✗ Test failed: ${file} (${duration}ms) - Exit code: ${exitCode}${colors.reset}`);
  }
}

/**
 * Build the project
 */
async function buildProject() {
  console.log(`\n${colors.cyan}===== Building project =====${colors.reset}\n`);
  await runCommand('npm', ['run', 'build']);
}

/**
 * Discover and run all test modules
 */
async function runTestModules(options) {
  console.log(`\n${colors.cyan}===== Running tests =====${colors.reset}\n`);

  // Discover all test files
  let testFiles = [];
  // The files found that test/excluded.txt leaves out, for the reports
  let excluded = [];
  try {
    // The files named on the command line (`node test/run-all-tests.js test-x.js`),
    // so one test can run isolated too, excluded or not; else every file here that
    // starts with 'test' or ends with '.test.js', less test/excluded.txt's
    const requested = options.names.map(file => path.basename(file));
    const found = requested.length > 0 ? [] : findTests('', __dirname);
    let discoveredTests = requested.length > 0 ? requested : withoutExcluded(found, '');
    excluded = found.filter(file => !discoveredTests.includes(file));
    discoveredTests = withoutSkipped(byTimed(discoveredTests, options, ''), options);
    if (options.values.changed) {
      discoveredTests = selectForRunner({ dir: __dirname, names: discoveredTests, commits: options.values.changed, outDir: options.outDir });
    }

    // Ensure main test.js runs first if it exists
    if (discoveredTests.includes('test.js')) {
      testFiles.push('./test.js');
      discoveredTests.splice(discoveredTests.indexOf('test.js'), 1);
    }

    // Add remaining tests
    testFiles.push(...discoveredTests.map(file => `./${file}`));

  } catch (error) {
    console.error(`${colors.red}Error: Could not scan test directory: ${error.message}${colors.reset}`);
    process.exit(1);
  }

  if (testFiles.length === 0) {
    console.warn(`${colors.yellow}Warning: No test files found${colors.reset}`);
    // Empty reports, so a script reading them sees a run with no files rather than an old run
    await runTestFiles({ dir: __dirname, files: [], outDir: options.outDir, suiteName: 'suite', excluded });
    return { success: true, results: [] };
  }

  console.log(`${colors.blue}Found ${testFiles.length} test files:${colors.reset}`);
  testFiles.forEach(file => console.log(`  - ${file}`));
  console.log('');

  // Run each test file
  const results = await runTestFiles({
    dir: __dirname,
    files: testFiles,
    outDir: options.outDir,
    suiteName: 'suite',
    shard: options.shard,
    excluded,
    onFileStart: printFileStart,
    onFileEnd: printFileEnd,
  });
  const totalDuration = results.reduce((sum, result) => sum + (result.duration || 0), 0);

  // Calculate summary statistics
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const failedTests = results.filter(r => !r.success);
  const skippedChecks = results.flatMap(r => (r.skipped || []).map(reason => ({ file: r.file, reason })));

  // Print detailed summary
  console.log(`\n${colors.bold}${colors.cyan}===== TEST SUMMARY =====${colors.reset}\n`);

  // Overall stats
  console.log(`${colors.bold}Overall Results:${colors.reset}`);
  console.log(`  Total tests:     ${passed + failed}`);
  console.log(`  ${colors.green}✓ Passed:        ${passed}${colors.reset}`);
  console.log(`  ${failed > 0 ? colors.red : colors.green}✗ Failed:        ${failed}${colors.reset}`);
  console.log(`  ${skippedChecks.length > 0 ? colors.yellow : colors.green}⚠️  Skipped checks: ${skippedChecks.length}${colors.reset}`);
  console.log(`  Total duration:  ${totalDuration}ms (${(totalDuration / 1000).toFixed(1)}s)`);

  // Skipped checks details: preconditions missing on this machine
  if (skippedChecks.length > 0) {
    console.log(`\n${colors.yellow}${colors.bold}Skipped Checks:${colors.reset}`);
    skippedChecks.forEach(({ file, reason }) => {
      console.log(`  ${colors.yellow}⚠️  ${file}: ${reason}${colors.reset}`);
    });
  }

  // Failed tests details
  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}Failed Tests:${colors.reset}`);
    failedTests.forEach(test => {
      console.log(`  ${colors.red}✗ ${test.file}${colors.reset}`);
      if (test.exitCode !== undefined) {
        console.log(`    Exit code: ${test.exitCode}`);
      }
    });
  }

  // Test performance summary
  if (results.length > 0) {
    console.log(`\n${colors.bold}Performance Summary:${colors.reset}`);
    const avgDuration = totalDuration / results.length;
    const slowestTest = results.reduce((prev, current) =>
      (current.duration || 0) > (prev.duration || 0) ? current : prev
    );
    const fastestTest = results.reduce((prev, current) =>
      (current.duration || 0) < (prev.duration || 0) ? current : prev
    );

    console.log(`  Average test duration: ${avgDuration.toFixed(0)}ms`);
    console.log(`  Fastest test: ${fastestTest.file} (${fastestTest.duration || 0}ms)`);
    console.log(`  Slowest test: ${slowestTest.file} (${slowestTest.duration || 0}ms)`);
  }

  // Final status
  if (failed === 0) {
    console.log(`\n${colors.green}${colors.bold}🎉 ALL TESTS PASSED! 🎉${colors.reset}`);
    console.log(`${colors.green}All ${passed} tests completed successfully.${colors.reset}`);
  } else {
    console.log(`\n${colors.red}${colors.bold}❌ TESTS FAILED ❌${colors.reset}`);
    console.log(`${colors.red}${failed} out of ${passed + failed} tests failed.${colors.reset}`);
  }

  console.log(`\n${colors.cyan}===== Test run completed =====${colors.reset}\n`);
  console.log(`Reports: ${path.relative(ROOT, options.outDir)}/junit.xml, results.json, results.tap`);

  return {
    success: failed === 0,
    results,
    summary: {
      total: passed + failed,
      passed,
      failed,
      duration: totalDuration
    }
  };
}

/**
 * Main function
 */
async function main() {
  const overallStartTime = Date.now();
  const options = readRunnerArgs(process.argv.slice(2), path.join(ROOT, 'test-results', 'suite'));

  try {
    console.log(`${colors.bold}${colors.cyan}===== DESKTOP COMMANDER TEST RUNNER =====${colors.reset}`);
    console.log(`${colors.blue}Starting test execution at ${new Date().toISOString()}${colors.reset}\n`);

    // Build the project first
    if (!options.flags.has('--no-build')) {
      await buildProject();
    }

    // Run all test modules
    const testResult = await runTestModules(options);

    // Final timing
    const overallDuration = Date.now() - overallStartTime;
    console.log(`${colors.blue}Total execution time: ${overallDuration}ms (${(overallDuration / 1000).toFixed(1)}s)${colors.reset}`);

    // Exit with appropriate code
    process.exit(testResult.success ? 0 : 1);

  } catch (error) {
    console.error(`\n${colors.red}${colors.bold}FATAL ERROR:${colors.reset}`);
    console.error(`${colors.red}${error.message}${colors.reset}`);
    if (error.stack) {
      console.error(`${colors.red}${error.stack}${colors.reset}`);
    }
    process.exit(1);
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error(`\n${colors.red}${colors.bold}UNCAUGHT EXCEPTION:${colors.reset}`);
  console.error(`${colors.red}${error.message}${colors.reset}`);
  if (error.stack) {
    console.error(`${colors.red}${error.stack}${colors.reset}`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`\n${colors.red}${colors.bold}UNHANDLED REJECTION:${colors.reset}`);
  console.error(`${colors.red}${reason}${colors.reset}`);
  process.exit(1);
});

// Run the main function
main().catch(error => {
  console.error(`\n${colors.red}${colors.bold}MAIN FUNCTION ERROR:${colors.reset}`);
  console.error(`${colors.red}${error.message}${colors.reset}`);
  if (error.stack) {
    console.error(`${colors.red}${error.stack}${colors.reset}`);
  }
  process.exit(1);
});
