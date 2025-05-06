/**
 * Test script for directory creation functionality
 * 
 * This script tests the create_directory functionality by:
 * 1. Testing creation of a directory with an existing parent
 * 2. Testing creation of a directory with a non-existent parent path
 * 3. Testing nested directory creation
 */

// Import the filesystem module and assert for testing
import { createDirectory } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test paths
const BASE_TEST_DIR = path.join(__dirname, 'test_directories');
const SIMPLE_DIR = path.join(BASE_TEST_DIR, 'simple_dir');
const NONEXISTENT_PARENT_DIR = path.join(BASE_TEST_DIR, 'nonexistent', 'test_dir');
const NESTED_DIR = path.join(BASE_TEST_DIR, 'nested', 'path', 'structure');

/**
 * Helper function to clean up test directories
 */
async function cleanupTestDirectories() {
  try {
    console.log('Cleaning up test directories...');
    await fs.rm(BASE_TEST_DIR, { recursive: true, force: true });
    console.log('Cleanup complete.');
  } catch (error) {
    // Ignore errors if directory doesn't exist
    if (error.code !== 'ENOENT') {
      console.error('Error during cleanup:', error);
    }
  }
}

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  // Clean up before tests
  await cleanupTestDirectories();
  
  // Create base test directory
  await fs.mkdir(BASE_TEST_DIR, { recursive: true });
  console.log(`✓ Setup: created base test directory: ${BASE_TEST_DIR}`);
  
  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  
  // Set allowed directories to include our test directory
  await configManager.setValue('allowedDirectories', [BASE_TEST_DIR]);
  console.log(`✓ Setup: set allowed directories to include: ${BASE_TEST_DIR}`);
  
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  if (originalConfig) {
    // Restore original config
    await configManager.updateConfig(originalConfig);
  }
  
  await cleanupTestDirectories();
  console.log('✓ Teardown: test directories cleaned up');
}

/**
 * Test function for directory creation
 */
async function testDirectoryCreation() {
  console.log('=== Directory Creation Tests ===\n');
  
  // Test 1: Create directory with existing parent
  console.log('\nTest 1: Create directory with existing parent');
  await createDirectory(SIMPLE_DIR);
  
  // Test 2: Create directory with non-existent parent
  console.log('\nTest 2: Create directory with non-existent parent');
  await createDirectory(NONEXISTENT_PARENT_DIR);
  
  // Test 3: Create nested directory structure
  console.log('\nTest 3: Create nested directory structure');
  await createDirectory(NESTED_DIR);
  
  // Verify directories were created using assertions
  console.log('\nVerifying directory creation:');
  
  for (const dir of [SIMPLE_DIR, NONEXISTENT_PARENT_DIR, NESTED_DIR]) {
    const stats = await fs.stat(dir);
    assert.ok(stats.isDirectory(), `Directory should exist and be a directory: ${dir}`);
    console.log(`✓ Verified: ${dir} exists and is a directory`);
  }
  
  console.log('\n✅ All tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testDirectoryCreation();
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
