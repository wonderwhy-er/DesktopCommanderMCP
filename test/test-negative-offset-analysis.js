/**
 * Negative Offset Analysis for read_file
 *
 * Originally recorded a bug: with a negative offset and a length, the read
 * range was computed as slice(offset, Math.min(offset, totalLines) + length),
 * e.g. offset: -2, length: 5 on a 6-line file → slice(-2, 3) → empty result,
 * while offset: -100 without a length only worked by accident.
 *
 * This test checks those exact cases against read_file on a file with known
 * content and reports what actually happens: ✅ if negative offsets return the
 * last lines, ❌ (and exit 1) if the bug is back.
 */

import { configManager } from '../dist/config-manager.js';
import { readFile } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_FILE = path.join(__dirname, 'test-negative-offset-analysis.txt');
const FILE_LINES = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'];

// The case from the original bug report, and the one that "worked by accident"
const CASES = [
  { offset: -2, length: 5, expected: ['line5', 'line6'] },
  { offset: -100, length: undefined, expected: FILE_LINES },
];

/** The file's lines in a read_file result (the status header is not a file line) */
async function readLines(options) {
  const result = await readFile(TEST_FILE, options);
  return String(result.content).split('\n').filter((line) => FILE_LINES.includes(line));
}

export default async function runTests() {
  console.log('🔍 NEGATIVE OFFSET BEHAVIOR ANALYSIS');
  console.log('====================================');

  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [__dirname]);
  await fs.writeFile(TEST_FILE, FILE_LINES.join('\n') + '\n');

  try {
    for (const { offset, length, expected } of CASES) {
      const actual = await readLines({ offset, length });
      assert.deepStrictEqual(actual, expected,
        `offset: ${offset}, length: ${length} should return [${expected}], got [${actual}]`);
      console.log(`✓ offset: ${offset}, length: ${length} → [${actual.join(', ')}]`);
    }
    console.log('\n✅ CONCLUSION: Negative offsets work in the current implementation');
    return true;
  } catch (error) {
    console.log(`\n❌ CONCLUSION: Negative offsets are BROKEN: ${error.message}`);
    return false;
  } finally {
    await fs.rm(TEST_FILE, { force: true });
    await configManager.updateConfig(originalConfig);
  }
}

runIfMain(import.meta.url, runTests);
