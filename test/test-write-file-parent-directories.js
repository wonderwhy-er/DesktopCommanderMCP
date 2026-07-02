/**
 * Test script for write_file parent directory creation.
 *
 * This verifies that writeFile can create a new file in a nested path without
 * requiring a separate create_directory call first.
 */

import { writeFile, readFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_TEST_DIR = path.join(__dirname, 'test_write_file_parent_directories');
const NESTED_FILE = path.join(BASE_TEST_DIR, 'nested', 'path', 'created.txt');

async function cleanupTestDirectories() {
  try {
    await fs.rm(BASE_TEST_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error during cleanup:', error);
    }
  }
}

async function setup() {
  await cleanupTestDirectories();
  await fs.mkdir(BASE_TEST_DIR, { recursive: true });

  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [BASE_TEST_DIR]);

  return originalConfig;
}

async function teardown(originalConfig) {
  if (originalConfig) {
    await configManager.updateConfig(originalConfig);
  }
  await cleanupTestDirectories();
}

async function testWriteFileCreatesParents() {
  console.log('=== writeFile parent directory creation test ===\n');

  await writeFile(NESTED_FILE, 'first line\nsecond line');

  const stats = await fs.stat(NESTED_FILE);
  assert.ok(stats.isFile(), 'Nested target should be created as a file');

  const result = await readFile(NESTED_FILE, { length: 10 });
  const content = result.content.toString();
  assert.ok(content.includes('first line'), 'File should contain written content');
  assert.ok(content.includes('second line'), 'File should contain all written lines');

  console.log('[OK] writeFile created missing parent directories and wrote content');
}

export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testWriteFileCreatesParents();
  } catch (error) {
    console.error('[FAIL] Test failed:', error.message);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(success => {
    if (!success) {
      process.exit(1);
    }
  }).catch(error => {
    console.error('[FAIL] Unhandled error:', error);
    process.exit(1);
  });
}
