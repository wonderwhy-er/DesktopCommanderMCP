/**
 * Test script for directory creation functionality
 * 
 * This script tests the create_directory functionality by:
 * 1. Testing creation of a directory with an existing parent
 * 2. Testing creation of a directory with a non-existent parent path
 * 3. Testing nested directory creation
 */

// Import the filesystem module
import { createDirectory } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test paths
const BASE_TEST_DIR = path.join(__dirname, 'test_directories');
const SIMPLE_DIR = path.join(BASE_TEST_DIR, 'simple_dir');
const NONEXISTENT_PARENT_DIR = path.join(BASE_TEST_DIR, 'nonexistent', 'test_dir');
const NESTED_DIR = path.join(BASE_TEST_DIR, 'nested', 'path', 'structure');

// Helper function to clean up test directories
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

// Test function
async function runTests() {
  console.log('=== Directory Creation Tests ===\n');
  
  // Clean up before tests
  await cleanupTestDirectories();
  
  // Create base test directory
  try {
    await fs.mkdir(BASE_TEST_DIR, { recursive: true });
    console.log(`✓ Created base test directory: ${BASE_TEST_DIR}`);
  } catch (error) {
    console.error(`✗ Failed to create base test directory: ${error.message}`);
    return;
  }
  
  // Test 1: Create directory with existing parent
  console.log('\nTest 1: Create directory with existing parent');
  try {
    await createDirectory(SIMPLE_DIR);
    console.log(`✓ Success: Created directory ${SIMPLE_DIR}`);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
  }
  
  // Test 2: Create directory with non-existent parent
  console.log('\nTest 2: Create directory with non-existent parent');
  try {
    await createDirectory(NONEXISTENT_PARENT_DIR);
    console.log(`✓ Success: Created directory ${NONEXISTENT_PARENT_DIR}`);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
  }
  
  // Test 3: Create nested directory structure
  console.log('\nTest 3: Create nested directory structure');
  try {
    await createDirectory(NESTED_DIR);
    console.log(`✓ Success: Created nested directory ${NESTED_DIR}`);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
  }
  
  // Verify directories were created
  console.log('\nVerifying directory creation:');
  let allCreated = true;
  
  for (const dir of [SIMPLE_DIR, NONEXISTENT_PARENT_DIR, NESTED_DIR]) {
    try {
      const stats = await fs.stat(dir);
      if (stats.isDirectory()) {
        console.log(`✓ Directory exists: ${dir}`);
      } else {
        console.log(`✗ Not a directory: ${dir}`);
        allCreated = false;
      }
    } catch (error) {
      console.log(`✗ Directory doesn't exist: ${dir}`);
      allCreated = false;
    }
  }
  
  // Clean up after tests
  await cleanupTestDirectories();
  
  console.log('\n=== Test Results ===');
  if (allCreated) {
    console.log('✅ All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed!');
    process.exit(1);
  }
}

// Run the tests
runTests().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
