/**
 * Main test runner script
 * Runs all test modules and provides comprehensive summary
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

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
    console.log(`${colors.blue}Running command: ${command} ${args.join(' ')}${colors.reset}`);
    
    const proc = spawn(command, args, {
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

/**
 * Run a single Node.js test file as a subprocess
 */
function runTestFile(testFile) {
  return new Promise((resolve) => {
    console.log(`\n${colors.cyan}Running test module: ${testFile}${colors.reset}`);
    
    const startTime = Date.now();
    const proc = spawn('node', [testFile], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: false
    });
    
    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        console.log(`${colors.green}✓ Test passed: ${testFile} (${duration}ms)${colors.reset}`);
        resolve({ success: true, file: testFile, duration, exitCode: code });
      } else {
        console.error(`${colors.red}✗ Test failed: ${testFile} (${duration}ms) - Exit code: ${code}${colors.reset}`);
        resolve({ success: false, file: testFile, duration, exitCode: code });
      }
    });
    
    proc.on('error', (err) => {
      const duration = Date.now() - startTime;
      console.error(`${colors.red}✗ Error running ${testFile}: ${err.message}${colors.reset}`);
      resolve({ success: false, file: testFile, duration, error: err.message });
    });
  });
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
async function runTestModules() {
  console.log(`\n${colors.cyan}===== Running tests =====${colors.reset}\n`);
  
  // Discover all test files
  let testFiles = [];
  try {
    const files = await fs.readdir(__dirname);
    
    // Get all test files, starting with 'test' and ending with '.js'
    const discoveredTests = files
      .filter(file => file.startsWith('test') && file.endsWith('.js') && file !== 'run-all-tests.js')
      .sort(); // Sort for consistent order
    
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
    return { success: true, results: [] };
  }
  
  console.log(`${colors.blue}Found ${testFiles.length} test files:${colors.reset}`);
  testFiles.forEach(file => console.log(`  - ${file}`));
  console.log('');
  
  // Results tracking
  const results = [];
  let totalDuration = 0;
  
  // Run each test file
  for (const testFile of testFiles) {
    const result = await runTestFile(testFile);
    results.push(result);
    totalDuration += result.duration || 0;
  }
  
  // Calculate summary statistics
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const failedTests = results.filter(r => !r.success);
  
  // Print detailed summary
  console.log(`\n${colors.bold}${colors.cyan}===== TEST SUMMARY =====${colors.reset}\n`);
  
  // Overall stats
  console.log(`${colors.bold}Overall Results:${colors.reset}`);
  console.log(`  Total tests:     ${passed + failed}`);
  console.log(`  ${colors.green}✓ Passed:        ${passed}${colors.reset}`);
  console.log(`  ${failed > 0 ? colors.red : colors.green}✗ Failed:        ${failed}${colors.reset}`);
  console.log(`  Total duration:  ${totalDuration}ms (${(totalDuration / 1000).toFixed(1)}s)`);
  
  // Failed tests details
  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}Failed Tests:${colors.reset}`);
    failedTests.forEach(test => {
      console.log(`  ${colors.red}✗ ${test.file}${colors.reset}`);
      if (test.exitCode !== undefined) {
        console.log(`    Exit code: ${test.exitCode}`);
      }
      if (test.error) {
        console.log(`    Error: ${test.error}`);
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
  
  try {
    console.log(`${colors.bold}${colors.cyan}===== DESKTOP COMMANDER TEST RUNNER =====${colors.reset}`);
    console.log(`${colors.blue}Starting test execution at ${new Date().toISOString()}${colors.reset}\n`);
    
    // Build the project first
    await buildProject();
    
    // Run all test modules
    const testResult = await runTestModules();
    
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
