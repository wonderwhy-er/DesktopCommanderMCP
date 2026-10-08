/**
 * Regression test for `read_file` ignoring the per-call page size when the
 * caller names it `limit` instead of `length`.
 *
 * Issue: wonderwhy-er/DesktopCommanderMCP#686 — a caller sending
 * `{ offset: 0, limit: 3 }` got the whole file back (capped only by
 * fileReadLineLimit), because `limit` was not part of the argument schema and
 * was silently dropped. The tool now accepts `limit` as an alias for `length`.
 *
 * This test checks:
 * 1. `limit` alone limits the returned lines.
 * 2. `offset` + `limit` reads the requested window.
 * 3. `length` still works and wins when both names are present.
 * 4. The configured fileReadLineLimit applies when neither is supplied.
 */

import { configManager } from '../dist/config-manager.js';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_FILE = path.join(__dirname, 'test-read-file-limit-alias.txt');
const TOTAL_LINES = 50;

/**
 * Setup: allowed directory, numbered test file, known read limit.
 */
async function setup() {
  console.log('🔧 Setting up read_file limit alias test...');

  const originalConfig = await configManager.getConfig();
  try {
    await configManager.setValue('allowedDirectories', [__dirname]);
    // Keep a non-default limit so "no page size given" is distinguishable from
    // "page size applied".
    await configManager.setValue('fileReadLineLimit', 7);

    const content = Array.from(
      { length: TOTAL_LINES },
      (_, i) => `Line ${i + 1}: alias test content`
    ).join('\n');
    await fs.writeFile(TEST_FILE, content, 'utf8');
  } catch (error) {
    // Never leave the developer's configuration mutated when setup fails.
    await configManager.updateConfig(originalConfig);
    throw error;
  }

  console.log(`✓ Created ${TOTAL_LINES}-line test file, fileReadLineLimit=7`);
  return originalConfig;
}

async function teardown(originalConfig) {
  console.log('🧹 Cleaning up read_file limit alias test...');
  await configManager.updateConfig(originalConfig);
  try {
    await fs.rm(TEST_FILE, { force: true });
    console.log('✓ Test file cleaned up');
  } catch (error) {
    console.log('⚠️  Warning: Could not clean up test file:', error.message);
  }
}

/** Numbered body lines in a read_file result, in order. */
function bodyLines(result) {
  return result.content[0].text
    .split('\n')
    .filter(line => line.startsWith('Line '));
}

async function runAllTests() {
  console.log('🧪 Testing read_file page-size arguments (limit alias)');
  let allTestsPassed = true;
  let originalConfig;

  try {
    originalConfig = await setup();

    const cases = [
      {
        name: 'limit: 3 returns 3 lines',
        args: { path: TEST_FILE, limit: 3 },
        expected: 3,
      },
      {
        name: 'offset: 0, limit: 3 returns 3 lines',
        args: { path: TEST_FILE, offset: 0, limit: 3 },
        expected: 3,
      },
      {
        name: 'offset: 10, limit: 5 returns lines 11-15',
        args: { path: TEST_FILE, offset: 10, limit: 5 },
        expected: 5,
        firstLine: 'Line 11:',
        lastLine: 'Line 15:',
      },
      {
        name: 'length: 4 still returns 4 lines',
        args: { path: TEST_FILE, length: 4 },
        expected: 4,
      },
      {
        name: 'length wins when both length and limit are given',
        args: { path: TEST_FILE, length: 6, limit: 2 },
        expected: 6,
      },
      {
        name: 'no page size falls back to fileReadLineLimit (7)',
        args: { path: TEST_FILE },
        expected: 7,
      },
    ];

    for (const testCase of cases) {
      console.log(`\n  🧪 ${testCase.name}`);
      try {
        const result = await handleReadFile(testCase.args);
        if (result.isError) {
          console.log(`  ❌ Error: ${result.content[0].text}`);
          allTestsPassed = false;
          continue;
        }
        const lines = bodyLines(result);
        if (lines.length !== testCase.expected) {
          console.log(`  ❌ FAIL: expected ${testCase.expected} line(s), got ${lines.length}`);
          allTestsPassed = false;
          continue;
        }
        // When the case names a window, assert the window itself: a handler
        // that ignores `offset` would still return the right count.
        if (testCase.firstLine && !lines[0].startsWith(testCase.firstLine)) {
          console.log(`  ❌ FAIL: first line is "${lines[0]}", expected "${testCase.firstLine}..."`);
          allTestsPassed = false;
          continue;
        }
        if (testCase.lastLine && !lines[lines.length - 1].startsWith(testCase.lastLine)) {
          console.log(
            `  ❌ FAIL: last line is "${lines[lines.length - 1]}", expected "${testCase.lastLine}..."`
          );
          allTestsPassed = false;
          continue;
        }
        console.log(`  ✅ PASS: ${lines.length} line(s)`);
      } catch (error) {
        console.log(`  ❌ Exception: ${error.message}`);
        allTestsPassed = false;
      }
    }

    console.log(
      `\n🎯 Overall result: ${allTestsPassed ? '✅ ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'}`
    );
  } catch (error) {
    console.error('❌ Test setup/execution failed:', error.message);
    allTestsPassed = false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }

  return allTestsPassed;
}

export default runAllTests;

if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Unhandled error:', error);
      process.exit(1);
    });
}
