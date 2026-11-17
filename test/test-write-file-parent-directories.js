/**
 * Test script for write_file parent directory creation.
 */

import { writeFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_TEST_DIR = path.join(__dirname, 'test_write_file_parent_directories');
const RESTRICTED_TEST_DIR = path.join(__dirname, 'test_write_file_parent_directories_restricted');
const NESTED_FILE = path.join(BASE_TEST_DIR, 'nested', 'path', 'created.txt');
const SYMLINK_TO_RESTRICTED = path.join(BASE_TEST_DIR, 'link_to_restricted');
const SYMLINK_NESTED_FILE = path.join(SYMLINK_TO_RESTRICTED, 'nested', 'created.txt');
const RESTRICTED_NESTED_FILE = path.join(RESTRICTED_TEST_DIR, 'nested', 'created.txt');

async function cleanupTestDirectories() {
  await fs.rm(BASE_TEST_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(RESTRICTED_TEST_DIR, { recursive: true, force: true }).catch(() => {});
}

async function setup() {
  await cleanupTestDirectories();

  await fs.mkdir(BASE_TEST_DIR, { recursive: true });
  await fs.mkdir(RESTRICTED_TEST_DIR, { recursive: true });
  await fs.symlink(RESTRICTED_TEST_DIR, SYMLINK_TO_RESTRICTED);

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

async function testWriteFileCreatesParentDirectories() {
  console.log('\nTest 1: writeFile creates missing parent directories');

  await writeFile(NESTED_FILE, 'first line\nsecond line');

  const stats = await fs.stat(NESTED_FILE);
  const content = await fs.readFile(NESTED_FILE, 'utf8');

  assert.ok(stats.isFile(), 'Nested target should be created as a file');
  assert.strictEqual(content, 'first line\nsecond line');
  console.log('[OK] Missing parent directories were created');
}

async function testWriteFileRejectsSymlinkParentOutsideAllowedDirectory() {
  console.log('\nTest 2: writeFile does not create directories through an external symlink');

  await assert.rejects(
    () => writeFile(SYMLINK_NESTED_FILE, 'blocked'),
    /Path not allowed/,
    'writeFile should reject a path whose resolved parent is outside allowedDirectories'
  );

  await assert.rejects(
    () => fs.stat(RESTRICTED_NESTED_FILE),
    error => error && error.code === 'ENOENT',
    'writeFile should not create the external symlink target'
  );
  console.log('[OK] External symlink parent was blocked');
}

export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testWriteFileCreatesParentDirectories();
    await testWriteFileRejectsSymlinkParentOutsideAllowedDirectory();
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
