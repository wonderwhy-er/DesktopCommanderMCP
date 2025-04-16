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
  
  // Set allowed directories to include the home directory for testing tilde expansion
  await configManager.setValue('allowedDirectories', [HOME_DIR, __dirname]);
  console.log(`Set allowed directories to: ${HOME_DIR}, ${__dirname}`);
  
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
  console.log(`Testing tilde expansion for: ${HOME_TILDE}`);
  console.log(`Home directory from os.homedir(): ${HOME_DIR}`);
  
  try {
    const expandedPath = await validatePath(HOME_TILDE);
    console.log(`Tilde (~) expanded to: ${expandedPath}`);
    
    // Check if the expanded path is the home directory
    assert.ok(
      expandedPath.toLowerCase() === HOME_DIR.toLowerCase() || 
      expandedPath.toLowerCase().startsWith(HOME_DIR.toLowerCase()),
      'Tilde (~) should expand to the home directory'
    );
    
    console.log('✓ Basic tilde expansion works correctly');
    return expandedPath; // Return expandedPath for use in the outer function
  } catch (error) {
    console.error(`Error during tilde expansion: ${error.message || error}`);
    throw error;
  }
}

/**
 * Test tilde with subdirectory expansion
 */
async function testTildeWithSubdirectory() {
  console.log('\nTest 2: Tilde with subdirectory expansion');
  
  try {
    // Test path validation with tilde and subdirectory
    console.log(`Testing tilde with subdirectory expansion for: ${HOME_DOCS_TILDE}`);
    console.log(`Home documents directory: ${HOME_DOCS_PATH}`);
    
    const expandedPath = await validatePath(HOME_DOCS_TILDE);
    console.log(`~/Documents expanded to: ${expandedPath}`);
    
    // Check if the expanded path is the home documents directory
    assert.ok(
      expandedPath.toLowerCase() === HOME_DOCS_PATH.toLowerCase() || 
      expandedPath.toLowerCase().startsWith(HOME_DOCS_PATH.toLowerCase()),
      '~/Documents should expand to the home documents directory'
    );
    
    console.log('✓ Tilde with subdirectory expansion works correctly');
  } catch (error) {
    console.error(`Error during tilde with subdirectory expansion: ${error.message || error}`);
    throw error;
  }
}

/**
 * Test tilde in allowedDirectories config
 */
async function testTildeInAllowedDirectories() {
  console.log('\nTest 3: Tilde in allowedDirectories config');
  
  try {
    // Set allowedDirectories to tilde
    await configManager.setValue('allowedDirectories', [HOME_TILDE]);
    
    // Verify config was set correctly
    const config = await configManager.getConfig();
    console.log(`Config: ${JSON.stringify(config.allowedDirectories)}`);
    assert.deepStrictEqual(config.allowedDirectories, [HOME_TILDE], 'allowedDirectories should contain tilde');
    
    // Test access to home directory and subdirectory
    try {
      const homeDirAccess = await validatePath(HOME_DIR);
      console.log(`Home directory access: ${homeDirAccess}`);
      
      const homeDocsDirAccess = await validatePath(HOME_DOCS_PATH);
      console.log(`Home documents directory access: ${homeDocsDirAccess}`);
      
      console.log('✓ Tilde in allowedDirectories works correctly');
    } catch (error) {
      console.error(`Error accessing paths: ${error.message || error}`);
      throw error;
    } finally {
      // Reset allowedDirectories to original value
      await configManager.setValue('allowedDirectories', []);
    }
  } catch (error) {
    console.error(`Error in tilde allowedDirectories test: ${error.message || error}`);
    throw error;
  }
}

/**
 * Test file operations with tilde
 */
async function testFileOperationsWithTilde() {
  console.log('\nTest 4: File operations with tilde');
  
  try {
    // Test directory creation with tilde
    console.log(`Attempting to create directory: ${TEST_DIR_TILDE}`);
    await createDirectory(TEST_DIR_TILDE);
    console.log(`Created test directory: ${TEST_DIR_TILDE}`);
    
    // Verify the directory exists
    const dirStats = await fs.stat(TEST_DIR);
    assert.ok(dirStats.isDirectory(), 'Test directory should exist and be a directory');
    
    // Test writing to a file with tilde
    console.log(`Attempting to write to file: ${TEST_FILE_TILDE}`);
    await writeFile(TEST_FILE_TILDE, TEST_CONTENT);
    console.log(`Wrote to test file: ${TEST_FILE_TILDE}`);
    
    // Test reading from a file with tilde
    console.log(`Attempting to read file: ${TEST_FILE_TILDE}`);
    const fileResult = await readFile(TEST_FILE_TILDE);
    let content;
    
    // Handle either string or object response from readFile
    if (typeof fileResult === 'string') {
      content = fileResult;
    } else if (fileResult && typeof fileResult === 'object') {
      content = fileResult.content;
    } else {
      throw new Error('Unexpected return format from readFile');
    }
    
    console.log(`Read from test file content: ${content}`);
    
    // Verify the content
    assert.ok(
      content === TEST_CONTENT || content.includes(TEST_CONTENT),
      'File content should match what was written'
    );
    
    // Test listing a directory with tilde
    console.log(`Attempting to list directory: ${TEST_DIR_TILDE}`);
    const entries = await listDirectory(TEST_DIR_TILDE);
    console.log(`Listed test directory: ${entries}`);
    
    // Verify the entries
    assert.ok(entries.some(entry => entry.includes('test-file.txt')), 'Directory listing should include test file');
    
    console.log('✓ File operations with tilde work correctly');
  } catch (error) {
    console.error(`Error during file operations with tilde: ${error.message || error}`);
    throw error;
  }
}

/**
 * Main test function
 */
async function testHomeDirectory() {
  console.log('=== Home Directory (~) Path Handling Tests ===\n');
  
  try {
    // Test 1: Basic tilde expansion
    const expandedPath = await testTildeExpansion();
    
    // Check if the expanded path is the home directory
    assert.ok(
      expandedPath.toLowerCase() === HOME_DIR.toLowerCase() || 
      expandedPath.toLowerCase().startsWith(HOME_DIR.toLowerCase()),
      'Tilde (~) should expand to the home directory'
    );
    
    // Test 2: Tilde with subdirectory expansion
    await testTildeWithSubdirectory();
    
    // Test 3: Tilde in allowedDirectories config
    await testTildeInAllowedDirectories();
    
    // Test 4: File operations with tilde
    await testFileOperationsWithTilde();
    
    console.log('\n✅ All home directory (~) tests passed!');
  } catch (error) {
    console.error(`Main test function error: ${error.message || error}`);
    throw error;
  }
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testHomeDirectory();
    return true;  // Explicitly return true on success
  } catch (error) {
    console.error('❌ Test failed:', error.message || error);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}