/**
 * Test script for allowedDirectories configuration functionality
 * 
 * This script tests how different allowedDirectories settings affect file access:
 * 1. Testing file access with empty allowedDirectories array (should allow full access)
 * 2. Testing file access with specific directory in allowedDirectories
 * 3. Testing file access outside allowed directories
 * 4. Testing file access with root directory in allowedDirectories
 */

import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import os from 'os';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test paths for different locations
const HOME_DIR = os.homedir();
const TEST_DIR = path.join(__dirname, 'test_allowed_dirs');
const OUTSIDE_DIR = path.join(os.tmpdir(), 'test_outside_allowed');
const ROOT_PATH = '/';

// For Windows compatibility
const isWindows = process.platform === 'win32';
const TEST_ROOT_PATH = isWindows ? 'C:\\' : '/';

/**
 * Helper function to clean up test directories
 */
async function cleanupTestDirectories() {
  try {
    console.log('Cleaning up test directories...');
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.rm(OUTSIDE_DIR, { recursive: true, force: true });
    console.log('Cleanup complete.');
  } catch (error) {
    // Ignore errors if directory doesn't exist
    if (error.code !== 'ENOENT') {
      console.error('Error during cleanup:', error);
    }
  }
}

/**
 * Check if a path is accessible
 */
async function isPathAccessible(testPath) {
  try {
    const validatedPath = await validatePath(testPath);
    return !validatedPath.startsWith('__ERROR__');
  } catch (error) {
    return false;
  }
}

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  // Clean up before tests
  await cleanupTestDirectories();
  
  // Create test directories
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.mkdir(OUTSIDE_DIR, { recursive: true });
  
  console.log(`✓ Setup: created test directories`);
  console.log(`  - Test dir: ${TEST_DIR}`);
  console.log(`  - Outside dir: ${OUTSIDE_DIR}`);
  
  // Create a test file in each directory
  await fs.writeFile(path.join(TEST_DIR, 'test-file.txt'), 'Test content');
  await fs.writeFile(path.join(OUTSIDE_DIR, 'outside-file.txt'), 'Outside content');
  
  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  // Reset configuration to original
  await configManager.updateConfig(originalConfig);
  
  // Clean up test directories
  await cleanupTestDirectories();
  console.log('✓ Teardown: test directories cleaned up and config restored');
}

/**
 * Test empty allowedDirectories array (should allow full access)
 */
async function testEmptyAllowedDirectories() {
  console.log('\nTest 1: Empty allowedDirectories array');
  
  // Set empty allowedDirectories
  await configManager.setValue('allowedDirectories', []);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.deepStrictEqual(config.allowedDirectories, [], 'allowedDirectories should be an empty array');
  
  // Test access to various locations
  const homeAccess = await isPathAccessible(HOME_DIR);
  const testDirAccess = await isPathAccessible(TEST_DIR);
  const outsideDirAccess = await isPathAccessible(OUTSIDE_DIR);
  const rootAccess = await isPathAccessible(TEST_ROOT_PATH);
  
  // All paths should be accessible with an empty array
  assert.strictEqual(homeAccess, true, 'Home directory should be accessible with empty allowedDirectories');
  assert.strictEqual(testDirAccess, true, 'Test directory should be accessible with empty allowedDirectories');
  assert.strictEqual(outsideDirAccess, true, 'Outside directory should be accessible with empty allowedDirectories');
  assert.strictEqual(rootAccess, true, 'Root path should be accessible with empty allowedDirectories');
  
  console.log('✓ Empty allowedDirectories array allows access to all directories as expected');
}

/**
 * Test with specific directory in allowedDirectories
 */
async function testSpecificAllowedDirectory() {
  console.log('\nTest 2: Specific directory in allowedDirectories');
  
  // Set allowedDirectories to just the test directory
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.deepStrictEqual(config.allowedDirectories, [TEST_DIR], 'allowedDirectories should contain only the test directory');
  
  // Test access to various locations
  const testDirAccess = await isPathAccessible(TEST_DIR);
  const testFileAccess = await isPathAccessible(path.join(TEST_DIR, 'test-file.txt'));
  const homeDirAccess = await isPathAccessible(HOME_DIR);
  const outsideDirAccess = await isPathAccessible(OUTSIDE_DIR);
  const rootAccess = await isPathAccessible(TEST_ROOT_PATH);
  
  // Only test directory and its contents should be accessible
  assert.strictEqual(testDirAccess, true, 'Test directory should be accessible');
  assert.strictEqual(testFileAccess, true, 'Files in test directory should be accessible');
  assert.strictEqual(homeDirAccess, TEST_DIR === HOME_DIR, 'Home directory should not be accessible (unless it equals test dir)');
  assert.strictEqual(outsideDirAccess, false, 'Outside directory should not be accessible');
  assert.strictEqual(rootAccess, false, 'Root path should not be accessible');
  
  console.log('✓ Specific allowedDirectories setting correctly restricts access');
}

/**
 * Test with root directory in allowedDirectories
 */
async function testRootInAllowedDirectories() {
  console.log('\nTest 3: Root directory in allowedDirectories');
  
  // Set allowedDirectories to include root
  await configManager.setValue('allowedDirectories', [TEST_ROOT_PATH]);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.deepStrictEqual(config.allowedDirectories, [TEST_ROOT_PATH], 'allowedDirectories should contain only the root path');
  
  // Test access to various locations
  const homeAccess = await isPathAccessible(HOME_DIR);
  const testDirAccess = await isPathAccessible(TEST_DIR);
  const outsideDirAccess = await isPathAccessible(OUTSIDE_DIR);
  const rootAccess = await isPathAccessible(TEST_ROOT_PATH);
  
  // All paths should be accessible when root is allowed
  assert.strictEqual(homeAccess, true, 'Home directory should be accessible with root in allowedDirectories');
  assert.strictEqual(testDirAccess, true, 'Test directory should be accessible with root in allowedDirectories');
  assert.strictEqual(outsideDirAccess, true, 'Outside directory should be accessible with root in allowedDirectories');
  assert.strictEqual(rootAccess, true, 'Root path should be accessible with root in allowedDirectories');
  
  console.log('✓ Root in allowedDirectories allows access to all directories as expected');
}

/**
 * Main test function
 */
async function testAllowedDirectories() {
  console.log('=== allowedDirectories Configuration Tests ===\n');
  
  // Test 1: Empty allowedDirectories array
  await testEmptyAllowedDirectories();
  
  // Test 2: Specific directory in allowedDirectories
  await testSpecificAllowedDirectory();
  
  // Test 3: Root directory in allowedDirectories
  await testRootInAllowedDirectories();
  
  console.log('\n✅ All allowedDirectories tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testAllowedDirectories();
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
  return true;
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
