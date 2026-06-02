/**
 * Integration test runner.
 *
 * Runs long-running MCP integration tests under test/integration. These are
 * intentionally excluded from the default test/run-all-tests.js discovery.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runTestFile(testFile) {
  return new Promise((resolve) => {
    console.log(`\nRunning integration test: ${testFile}`);
    const startedAt = Date.now();
    const proc = spawn('node', [testFile], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: false,
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startedAt;
      if (code === 0) {
        console.log(`PASS ${testFile} (${duration}ms)`);
        resolve({ file: testFile, success: true, duration });
      } else {
        console.error(`FAIL ${testFile} (${duration}ms, exit code ${code})`);
        resolve({ file: testFile, success: false, duration, exitCode: code });
      }
    });

    proc.on('error', (error) => {
      const duration = Date.now() - startedAt;
      console.error(`FAIL ${testFile} (${duration}ms): ${error.message}`);
      resolve({ file: testFile, success: false, duration, error: error.message });
    });
  });
}

function formatDuration(duration) {
  return `${duration}ms (${(duration / 1000).toFixed(1)}s)`;
}

async function main() {
  const files = (await fs.readdir(__dirname))
    .filter((file) => file.endsWith('.js') && file !== 'run-all-integration-tests.js')
    .sort();

  if (files.length === 0) {
    console.log('No integration tests found.');
    return;
  }

  console.log(`Found ${files.length} integration test file(s):`);
  for (const file of files) {
    console.log(`  - ${file}`);
  }

  const results = [];
  for (const file of files) {
    results.push(await runTestFile(`./${file}`));
  }

  const failed = results.filter((result) => !result.success);
  const totalDuration = results.reduce((sum, result) => sum + result.duration, 0);

  console.log('\nIntegration test timings:');
  for (const result of results) {
    const status = result.success ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${result.file}: ${formatDuration(result.duration)}`);
  }

  console.log(`\nIntegration test summary: ${results.length - failed.length}/${results.length} passed (${formatDuration(totalDuration)})`);
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
