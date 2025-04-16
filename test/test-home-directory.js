/**
 * Test script for home directory (~) path handling
 * 
 * This script tests the tilde expansion and path validation with:
 * 1. Testing tilde (~) expansion in paths
 * 2. Testing tilde with subdirectory (~/Documents) expansion
 * 3. Testing tilde expansion in the allowedDirectories configuration
 * 4. Testing file operations with tilde notation
 */

import { configManager } from '../dist/config-manager.js';
import { 
  validatePath, 
  listDirectory, 
  readFile, 
  writeFile, 
  createDirectory 
} from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import os from 'os';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test paths
const HOME_DIR = os.homedir();
const HOME_TILDE = '~';
const HOME_DOCS_PATH = path.join(HOME_DIR, 'Documents');
const HOME_DOCS_TILDE = '~/Documents';
const TEST_DIR = path.join(HOME_DIR, '.claude-test-tilde');
const TEST_DIR_TILDE = '~/.claude-test-tilde';
const TEST_FILE = path.join(TEST_DIR, 'test-file.txt');
const TEST_FILE_TILDE = '~/.claude-test-tilde/test-file.txt';
const TEST_CONTENT = 'This is a test file for tilde expansion';

/**
 * Helper function to clean up test directories
 */
async function cleanupTestDirectories() {
  try {
    console.log('Cleaning up test directories...');
    await fs.rm(TEST_DIR, { recursive: true, force: true });
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
 * Test simple tilde expansion
 */
async function testTildeExpansion() {
  console.log('\nTest 1: Basic tilde expansion');
  
  // Test path validation with tilde
  const expandedPath = await validatePath(HOME_TILDE);
  console.log(`Tilde (~) expanded to: ${expandedPath}`);
  
  // Check if the expanded path is the home directory
  assert.ok(
    expandedPath.toLowerCase() === HOME_DIR.toLowerCase() || 
    expandedPath.toLowerCase().startsWith(HOME_DIR.toLowerCase()),
    'Tilde (~) should expand to the home directory'
  );
  
  console.log('✓ Basic tilde expansion works correctly');
}

/**
 * Test tilde with subdirectory expansion
 */
async function testTildeWithSubdirectory() {
  console.log('\nTest 2: Tilde with subdirectory expansion');
  
  // Test path validation with tilde and subdirectory
  const expandedPath = await validatePath(HOME_DOCS_TILDE);
  console.log(`~/Documents expanded to: ${expandedPath}`);
  
  // Check if the expanded path is the home documents directory
  assert.ok(
    expandedPath.toLowerCase() === HOME_DOCS_PATH.toLowerCase() || 
    expandedPath.toLowerCase().startsWith(HOME_DOCS_PATH.toLowerCase()),
    '~/Documents should expand to the home documents directory'
  );
  
  console.log('✓ Tilde with subdirectory expansion works correctly');
}

/**
 * Test tilde in allowedDirectories config
 */
async function testTildeInAllowedDirectories() {
  console.log('\nTest 3: Tilde in allowedDirectories config');
  
  // Set allowedDirectories to tilde
  await configManager.setValue('allowedDirectories', [HOME_TILDE]);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  console.log(`Config: ${JSON.stringify(config.allowedDirectories)}`);
  assert.deepStrictEqual(config.allowedDirectories, [HOME_TILDE], 'allowedDirectories should contain tilde');
  
  // Test access to home directory and subdirectory
  const homeDirAccess = await validatePath(HOME_DIR);
  const homeDocsDirAccess = await validatePath(HOME_DOCS_PATH);
  
  // Check if the paths are accessible
  assert.ok(!homeDirAccess.startsWith('__ERROR__'), 'Home directory should be accessible');
  assert.ok(!homeDocsDirAccess.startsWith('__ERROR__'), 'Home documents directory should be accessible');
  
  // Reset allowedDirectories to original value
  await configManager.setValue('allowedDirectories', []);
  
  console.log('✓ Tilde in allowedDirectories works correctly');
}

/**
 * Test file operations with tilde
 */
async function testFileOperationsWithTilde() {
  console.log('\nTest 4: File operations with tilde');
  
  // Test directory creation with tilde
  await createDirectory(TEST_DIR_TILDE);
  console.log(`Created test directory: ${TEST_DIR_TILDE}`);
  
  // Verify the directory exists
  const dirStats = await fs.stat(TEST_DIR);
  assert.ok(dirStats.isDirectory(), 'Test directory should exist and be a directory');
  
  // Test writing to a file with tilde
  await writeFile(TEST_FILE_TILDE, TEST_CONTENT);
  console.log(`Wrote to test file: ${TEST_FILE_TILDE}`);
  
  // Test reading from a file with tilde
  const content = await readFile(TEST_FILE_TILDE);
  console.log(`Read from test file: ${content}`);
  
  // Verify the content
  assert.strictEqual(content, TEST_CONTENT, 'File content should match what was written');
  
  // Test listing a directory with tilde
  const entries = await listDirectory(TEST_DIR_TILDE);
  console.log(`Listed test directory: ${entries}`);
  
  // Verify the entries
  assert.ok(entries.some(entry => entry.includes('test-file.txt')), 'Directory listing should include test file');
  
  console.log('✓ File operations with tilde work correctly');
}

/**
 * Main test function
 */
async function testHomeDirectory() {
  console.log('=== Home Directory (~) Path Handling Tests ===\n');
  
  // Test 1: Basic tilde expansion
  await testTildeExpansion();
  
  // Test 2: Tilde with subdirectory expansion
  await testTildeWithSubdirectory();
  
  // Test 3: Tilde in allowedDirectories config
  await testTildeInAllowedDirectories();
  
  // Test 4: File operations with tilde
  await testFileOperationsWithTilde();
  
  console.log('\n✅ All home directory (~) tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testHomeDirectory();
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