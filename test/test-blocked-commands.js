/**
 * Test script for blockedCommands configuration functionality
 * 
 * This script tests how blockedCommands settings affect command execution:
 * 1. Testing execution of non-blocked commands
 * 2. Testing execution of blocked commands
 * 3. Testing updated blockedCommands list
 * 4. Testing empty blockedCommands array
 */

import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { startProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';

// We need a wrapper because startProcess in tools/improved-process-tools.js returns a ServerResult
// but our tests expect to receive the actual command result
async function executeCommand(command, timeout_ms = 2000, shell = null) {
  const args = {
    command: command,
    timeout_ms: timeout_ms
  };
  
  if (shell) {
    args.shell = shell;
  }
  
  return await startProcess(args);
}
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import os from 'os';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test directory
const TEST_DIR = path.join(__dirname, 'test_blocked_commands');

// Define some test commands
const SAFE_COMMANDS = [
  'echo "Hello World"',
  'pwd',
  'date'
];

const POTENTIALLY_HARMFUL_COMMANDS = [
  'rm', 
  'mkfs',       
  'dd'          
];

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
 * Execute a command and return true if it executed successfully, false if blocked
 */
async function tryCommand(command) {
  try {
    const result = await executeCommand(command, null, 2000);
    
    // Check if the result indicates the command was blocked
    if (result.isError && result.content && result.content[0] && 
        result.content[0].text && result.content[0].text.includes('Command not allowed')) {
      return {
        blocked: true,
        error: result.content[0].text
      };
    }
    
    // Command was executed successfully
    return {
      blocked: false,
      output: result.content && result.content[0] ? result.content[0].text : '',
      pid: result.content && result.content[0] && result.content[0].text ? 
           parseInt(result.content[0].text.match(/PID (\d+)/)?.[1] || '-1') : -1
    };
  } catch (error) {
    // Check if the error message indicates blocking
    if (error.message && (
        error.message.includes('Command not allowed') || 
        error.message.includes('blocked by configuration'))) {
      return {
        blocked: true,
        error: error.message
      };
    }
    // Otherwise it's another type of error
    throw error;
  }
}

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  // Clean up before tests
  await cleanupTestDirectories();
  
  // Create test directory
  await fs.mkdir(TEST_DIR, { recursive: true });
  
  // Create a test file in the directory
  await fs.writeFile(path.join(TEST_DIR, 'test-file.txt'), 'Test content');
  
  console.log(`✓ Setup: created test directory: ${TEST_DIR}`);
  
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
 * Test execution of non-blocked commands
 */
async function testNonBlockedCommands() {
  console.log('\nTest 1: Execution of non-blocked commands');
  
  // Set blockedCommands to include specific harmful commands
  const blockedCommands = [
    "rm -rf /", 
    ":(){ :|:& };:", 
    "> /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs",
    "mkfs.ext4",
    "format"
  ];
  
  await configManager.setValue('blockedCommands', blockedCommands);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.deepStrictEqual(config.blockedCommands, blockedCommands, 'blockedCommands should be correctly set');
  
  // Try to execute safe commands
  for (const command of SAFE_COMMANDS) {
    console.log(`Testing command: ${command}`);
    const result = await tryCommand(command);
    assert.strictEqual(result.blocked, false, `Command should not be blocked: ${command}`);
    console.log(`✓ Command executed successfully: ${command}`);
  }
}

/**
 * Test execution of blocked commands 
 */
async function testBlockedCommandsExecution() {
  console.log('\nTest 2: Execution of blocked commands');
  
  // Set blockedCommands to block our test harmful commands
  const blockedCommands = POTENTIALLY_HARMFUL_COMMANDS.slice();
  await configManager.setValue('blockedCommands', blockedCommands);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.deepStrictEqual(config.blockedCommands, blockedCommands, 'blockedCommands should be correctly set');
  
  // We'll test this by directly checking against commandManager.validateCommand
  // since that's what determines if a command is blocked
  for (const command of POTENTIALLY_HARMFUL_COMMANDS) {
    console.log(`Testing blocked command: ${command}`);
    
    // Check validation directly
    const isAllowed = await commandManager.validateCommand(command);
    console.log(`Command ${command} allowed:`, isAllowed);
    
    // The command should NOT be allowed
    assert.strictEqual(isAllowed, false, `Command should be blocked: ${command}`);
    console.log(`✓ Command was correctly blocked: ${command}`);
  }
}

/**
 * Test updating blockedCommands list
 */
async function testUpdatingBlockedCommands() {
  console.log('\nTest 3: Updating blockedCommands list');
  
  // Start with one blocked command
  const testCommand = 'echo';
  await configManager.setValue('blockedCommands', [testCommand]);
  
  // Verify the command is blocked
  const isAllowed1 = await commandManager.validateCommand(testCommand);
  assert.strictEqual(isAllowed1, false, 'Command should be blocked before update');
  console.log(`Command ${testCommand} blocked before update: ${!isAllowed1}`);
  
  // Update blockedCommands to empty array
  await configManager.setValue('blockedCommands', []);
  
  // Verify the command is now allowed
  const isAllowed2 = await commandManager.validateCommand(testCommand);
  assert.strictEqual(isAllowed2, true, 'Command should be allowed after update');
  console.log(`Command ${testCommand} allowed after update: ${isAllowed2}`);
  
  console.log('✓ blockedCommands list was successfully updated');
}

/**
 * Test empty blockedCommands array
 */
async function testEmptyBlockedCommands() {
  console.log('\nTest 4: Empty blockedCommands array');
  
  // Set blockedCommands to empty array
  await configManager.setValue('blockedCommands', []);
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.deepStrictEqual(config.blockedCommands, [], 'blockedCommands should be an empty array');
  
  // Try to execute both safe and potentially harmful commands
  const allCommands = [...SAFE_COMMANDS, ...POTENTIALLY_HARMFUL_COMMANDS];
  
  for (const command of allCommands) {
    console.log(`Testing with empty blockedCommands: ${command}`);
    const isAllowed = await commandManager.validateCommand(command);
    assert.strictEqual(isAllowed, true, `No commands should be blocked with empty blockedCommands: ${command}`);
    console.log(`✓ Command allowed with empty blockedCommands: ${command}`);
  }
}

/**
 * Main test function
 */
async function runBlockedCommandsTests() {
  console.log('=== blockedCommands Configuration Tests ===\n');
  
  // Test 1: Execution of non-blocked commands
  await testNonBlockedCommands();
  
  // Test 2: Execution of blocked commands
  await testBlockedCommandsExecution();
  
  // Test 3: Updating blockedCommands list
  await testUpdatingBlockedCommands();
  
  // Test 4: Empty blockedCommands array
  await testEmptyBlockedCommands();
  
  console.log('\n✅ All blockedCommands tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await runBlockedCommandsTests();
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