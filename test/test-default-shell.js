/**
 * Test script for defaultShell configuration functionality
 *
 * Shells under test come from the server's own detection (dist/utils/shell.js),
 * so the same test covers Windows, macOS and Linux without per-platform lists:
 * 1. The detected default shell is installed and listed as available
 * 2. Every available shell, set as defaultShell, is used to run commands
 * 3. Switching between shells is applied immediately
 * 4. defaultShell changes persist across config reads
 */

import { configManager } from '../dist/config-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { detectAvailableShells, getDefaultShell, isShellAvailable } from '../dist/utils/shell.js';
import assert from 'assert';
import os from 'os';
import { runIfMain, skip } from './helpers/run-if-main.js';

// `echo <word>` behaves the same in cmd, PowerShell, pwsh and POSIX shells
const MARKER = 'dc-default-shell-ok';

/**
 * Set defaultShell, run a command without an explicit shell, and verify that
 * start_process used the configured shell and the command ran in it.
 */
async function assertCommandRunsIn(shell) {
  await configManager.setValue('defaultShell', shell);
  const config = await configManager.getConfig();
  assert.strictEqual(config.defaultShell, shell, `defaultShell should be set to ${shell}`);

  const result = await startProcess({ command: `echo ${MARKER}`, timeout_ms: 10000 });
  const text = result.content?.[0]?.text ?? '';
  assert.strictEqual(result.structuredContent?.shell, shell, `start_process should use ${shell}`);
  assert(text.includes(MARKER), `Command should run in ${shell} and print ${MARKER}, got: ${text}`);
}

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  console.log('Setting up test environment...');

  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  console.log(`✓ Setup: saved original configuration`);
  console.log(`  - Original defaultShell: ${originalConfig.defaultShell || 'not set'}`);

  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  // Reset configuration to original
  await configManager.updateConfig(originalConfig);
  console.log('✓ Teardown: original configuration restored');
  console.log(`  - Restored defaultShell: ${originalConfig.defaultShell || 'not set'}`);
}

/**
 * Test that the detected default shell is installed and offered
 */
function testDefaultShellDetection(availableShells) {
  console.log('\nTest 1: Detecting the default shell');

  const defaultShell = getDefaultShell();
  assert(isShellAvailable(defaultShell), `Default shell ${defaultShell} should be installed`);
  assert.strictEqual(availableShells[0], defaultShell, 'Default shell should be listed first among available shells');

  console.log(`✓ Test 1 passed: default shell is ${defaultShell}`);
}

/**
 * Test running a command through every available shell
 */
async function testEachAvailableShell(availableShells) {
  console.log('\nTest 2: Running a command through each available shell');

  for (const shell of availableShells) {
    await assertCommandRunsIn(shell);
    console.log(`✓ ${shell} runs commands as defaultShell`);
  }

  console.log('✓ Test 2 passed: every available shell runs commands');
}

/**
 * Test switching between different shells
 */
async function testShellSwitching(availableShells) {
  console.log('\nTest 3: Testing shell switching');

  if (availableShells.length < 2) {
    skip('Test 3 (shell switching): needs at least 2 available shells');
    return;
  }

  const [shell1, shell2] = availableShells;
  for (const shell of [shell1, shell2, shell1]) {
    await assertCommandRunsIn(shell);
    console.log(`✓ Switched to ${shell}`);
  }

  console.log('✓ Test 3 passed: shell switching works correctly');
}

/**
 * Test that configuration changes persist
 */
async function testConfigurationPersistence(availableShells) {
  console.log('\nTest 4: Testing configuration persistence');

  const testShell = availableShells[availableShells.length - 1];
  await configManager.setValue('defaultShell', testShell);

  // Get config multiple times to ensure it persists
  const config1 = await configManager.getConfig();
  const config2 = await configManager.getConfig();

  assert.strictEqual(config1.defaultShell, testShell, 'Configuration should persist on first read');
  assert.strictEqual(config2.defaultShell, testShell, 'Configuration should persist on second read');

  console.log(`✓ Configuration persists correctly: ${config1.defaultShell}`);
  console.log('✓ Test 4 passed: configuration persistence works correctly');
}

/**
 * Main test function
 */
async function runDefaultShellTests() {
  console.log('=== defaultShell Configuration Tests ===\n');
  console.log(`Platform: ${os.platform()}`);

  const availableShells = detectAvailableShells();
  console.log(`Available shells: ${availableShells.join(', ')}`);
  assert(availableShells.length > 0, 'At least one shell should be detected');

  testDefaultShellDetection(availableShells);
  await testEachAvailableShell(availableShells);
  await testShellSwitching(availableShells);
  await testConfigurationPersistence(availableShells);

  console.log('\n✅ All defaultShell tests completed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await runDefaultShellTests();
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Full error:', error);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
  return true;
}

// If this file is run directly (not imported), execute the test
runIfMain(import.meta.url, runTests);
