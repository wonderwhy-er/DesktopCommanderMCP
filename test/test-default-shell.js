/**
 * Test script for defaultShell configuration functionality
 * 
 * This script tests how defaultShell settings affect command execution:
 * 1. Testing execution with /bin/sh as default shell
 * 2. Testing execution with bash as default shell
 * 3. Testing shell changes are properly applied
 * 4. Testing restoration of original configuration
 */

import { configManager } from '../dist/config-manager.js';
import { startProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import assert from 'assert';
import os from 'os';

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

/**
 * Check if a shell is available on the system
 */
async function isShellAvailable(shellPath) {
  try {
    // For Windows shells, use different detection methods
    if (shellPath === 'cmd' || shellPath === 'cmd.exe') {
      // On Windows, cmd should always be available
      if (os.platform() === 'win32') {
        return true;
      }
      return false;
    }
    
    if (shellPath === 'pwsh' || shellPath === 'powershell') {
      // Check if PowerShell is available
      try {
        const result = await executeCommand(`${shellPath} -Command "Get-Host"`, 2000);
        return result.content && result.content[0] && !result.content[0].text.includes('not found');
      } catch (error) {
        return false;
      }
    }
    
    // For Unix shells, check if the file exists and is executable
    try {
      const result = await executeCommand(`test -x "${shellPath}" && echo "available"`, 2000);
      return result.content && result.content[0] && result.content[0].text.includes('available');
    } catch (error) {
      return false;
    }
  } catch (error) {
    console.log(`Could not check availability of ${shellPath}: ${error.message}`);
    return false;
  }
}

/**
 * Get expected shell output for a given shell path
 */
function getExpectedShellOutput(shellPath) {
  switch (shellPath) {
    case '/bin/sh':
      return ['/bin/sh'];
    case '/bin/bash':
      return ['/bin/bash', 'bash'];
    case 'cmd':
    case 'cmd.exe':
      return ['cmd', 'cmd.exe'];
    case 'pwsh':
      return ['pwsh'];
    case 'powershell':
      return ['powershell'];
    default:
      return [shellPath];
  }
}
/**
 * Execute echo $0 command and extract the shell name from the output
 * For Windows shells, use appropriate commands
 */
async function getShellFromCommand(shellPath = null) {
  try {
    let command = 'echo $0';
    
    // Use different commands for Windows shells
    if (shellPath === 'cmd' || shellPath === 'cmd.exe') {
      command = 'echo %0';
    } else if (shellPath === 'pwsh' || shellPath === 'powershell') {
      command = 'Write-Host $MyInvocation.MyCommand.Name';
    }
    
    const result = await executeCommand(command, 2000);
    
    // Extract shell name from the result
    if (result.content && result.content[0] && result.content[0].text) {
      const output = result.content[0].text;
      // Look for the shell name in the output, handling both PID line and actual output
      const lines = output.split('\n').filter(line => line.trim() !== '');
      
      // Find the line that contains the actual shell output (not the PID line, Command started, or Initial output)
      for (const line of lines) {
        if (!line.includes('PID') && 
            !line.includes('Command started') && 
            !line.includes('Initial output:') &&
            line.trim() !== '') {
          return line.trim();
        }
      }
    }
    
    throw new Error('Could not extract shell name from command output');
  } catch (error) {
    console.error('Error executing shell command:', error);
    throw error;
  }
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
 * Test setting defaultShell to /bin/sh
 */
async function testDefaultShellSh() {
  console.log('\nTest 1: Setting defaultShell to /bin/sh');
  
  // Check if /bin/sh is available
  const isAvailable = await isShellAvailable('/bin/sh');
  if (!isAvailable) {
    console.log('⚠️  Skipping /bin/sh test: shell not available on this system');
    return;
  }
  
  // Set defaultShell to /bin/sh
  await configManager.setValue('defaultShell', '/bin/sh');
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.strictEqual(config.defaultShell, '/bin/sh', 'defaultShell should be set to /bin/sh');
  console.log(`✓ Configuration updated: defaultShell = ${config.defaultShell}`);
  
  // Execute echo $0 to check the shell
  const shellOutput = await getShellFromCommand(config.defaultShell);
  console.log(`✓ Command output: ${shellOutput}`);
  
  // Verify the shell is /bin/sh
  const expectedOutputs = getExpectedShellOutput('/bin/sh');
  const isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Shell should be one of ${expectedOutputs.join(', ')}, got: ${shellOutput}`);
  console.log('✓ Test 1 passed: /bin/sh is correctly set as default shell');
}

/**
 * Test setting defaultShell to bash  
 */
async function testDefaultShellBash() {
  console.log('\nTest 2: Setting defaultShell to /bin/bash');
  
  // Check if /bin/bash is available
  const isAvailable = await isShellAvailable('/bin/bash');
  if (!isAvailable) {
    console.log('⚠️  Skipping /bin/bash test: shell not available on this system');
    return;
  }
  
  // Set defaultShell to /bin/bash (use full path)
  await configManager.setValue('defaultShell', '/bin/bash');
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.strictEqual(config.defaultShell, '/bin/bash', 'defaultShell should be set to /bin/bash');
  console.log(`✓ Configuration updated: defaultShell = ${config.defaultShell}`);
  
  // Execute echo $0 to check the shell
  const shellOutput = await getShellFromCommand(config.defaultShell);
  console.log(`✓ Command output: ${shellOutput}`);
  
  // Verify the shell is /bin/bash (note: bash may show as just "bash" or full path)
  const expectedOutputs = getExpectedShellOutput('/bin/bash');
  const isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Shell should be one of ${expectedOutputs.join(', ')}, got: ${shellOutput}`);
  console.log('✓ Test 2 passed: /bin/bash is correctly set as default shell');
}

/**
 * Test setting defaultShell to cmd (Windows Command Prompt)
 */
async function testDefaultShellCmd() {
  console.log('\nTest 3: Setting defaultShell to cmd');
  
  // Check if cmd is available (Windows only)
  const isAvailable = await isShellAvailable('cmd');
  if (!isAvailable) {
    console.log('⚠️  Skipping cmd test: shell not available on this system (likely not Windows)');
    return;
  }
  
  // Set defaultShell to cmd
  await configManager.setValue('defaultShell', 'cmd');
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.strictEqual(config.defaultShell, 'cmd', 'defaultShell should be set to cmd');
  console.log(`✓ Configuration updated: defaultShell = ${config.defaultShell}`);
  
  // Execute echo %0 to check the shell (Windows command)
  const shellOutput = await getShellFromCommand('cmd');
  console.log(`✓ Command output: ${shellOutput}`);
  
  // Verify the shell is cmd
  const expectedOutputs = getExpectedShellOutput('cmd');
  const isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Shell should be one of ${expectedOutputs.join(', ')}, got: ${shellOutput}`);
  console.log('✓ Test 3 passed: cmd is correctly set as default shell');
}

/**
 * Test setting defaultShell to pwsh (PowerShell Core)
 */
async function testDefaultShellPwsh() {
  console.log('\nTest 4: Setting defaultShell to pwsh');
  
  // Check if pwsh is available
  const isAvailable = await isShellAvailable('pwsh');
  if (!isAvailable) {
    console.log('⚠️  Skipping pwsh test: PowerShell Core not available on this system');
    return;
  }
  
  // Set defaultShell to pwsh
  await configManager.setValue('defaultShell', 'pwsh');
  
  // Verify config was set correctly
  const config = await configManager.getConfig();
  assert.strictEqual(config.defaultShell, 'pwsh', 'defaultShell should be set to pwsh');
  console.log(`✓ Configuration updated: defaultShell = ${config.defaultShell}`);
  
  // Execute PowerShell command to check the shell
  const shellOutput = await getShellFromCommand('pwsh');
  console.log(`✓ Command output: ${shellOutput}`);
  
  // Verify the shell is pwsh
  const expectedOutputs = getExpectedShellOutput('pwsh');
  const isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Shell should be one of ${expectedOutputs.join(', ')}, got: ${shellOutput}`);
  console.log('✓ Test 4 passed: pwsh is correctly set as default shell');
}
/**
 * Test switching between different shells
 */
async function testShellSwitching() {
  console.log('\nTest 5: Testing shell switching');
  
  // Get available shells for switching test
  const availableShells = [];
  if (await isShellAvailable('/bin/sh')) availableShells.push('/bin/sh');
  if (await isShellAvailable('/bin/bash')) availableShells.push('/bin/bash');
  if (await isShellAvailable('cmd')) availableShells.push('cmd');
  if (await isShellAvailable('pwsh')) availableShells.push('pwsh');
  
  if (availableShells.length < 2) {
    console.log('⚠️  Skipping shell switching test: need at least 2 available shells');
    return;
  }
  
  console.log(`✓ Available shells for switching test: ${availableShells.join(', ')}`);
  
  // Test switching between first two available shells
  const shell1 = availableShells[0];
  const shell2 = availableShells[1];
  
  // Switch to first shell
  await configManager.setValue('defaultShell', shell1);
  let shellOutput = await getShellFromCommand(shell1);
  let expectedOutputs = getExpectedShellOutput(shell1);
  let isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Switch to ${shell1} should work, got: ${shellOutput}`);
  console.log(`✓ Successfully switched to ${shell1}: ${shellOutput}`);
  
  // Switch to second shell
  await configManager.setValue('defaultShell', shell2);
  shellOutput = await getShellFromCommand(shell2);
  expectedOutputs = getExpectedShellOutput(shell2);
  isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Switch to ${shell2} should work, got: ${shellOutput}`);
  console.log(`✓ Successfully switched to ${shell2}: ${shellOutput}`);
  
  // Switch back to first shell
  await configManager.setValue('defaultShell', shell1);
  shellOutput = await getShellFromCommand(shell1);
  expectedOutputs = getExpectedShellOutput(shell1);
  isValidOutput = expectedOutputs.includes(shellOutput);
  assert(isValidOutput, `Switch back to ${shell1} should work, got: ${shellOutput}`);
  console.log(`✓ Successfully switched back to ${shell1}: ${shellOutput}`);
  
  console.log('✓ Test 5 passed: shell switching works correctly');
}

/**
 * Test that configuration changes persist
 */
async function testConfigurationPersistence() {
  console.log('\nTest 6: Testing configuration persistence');
  
  // Find an available shell for testing
  let testShell = '/bin/sh';
  if (!(await isShellAvailable('/bin/sh'))) {
    if (await isShellAvailable('/bin/bash')) {
      testShell = '/bin/bash';
    } else if (await isShellAvailable('cmd')) {
      testShell = 'cmd';
    } else if (await isShellAvailable('pwsh')) {
      testShell = 'pwsh';
    } else {
      console.log('⚠️  Skipping persistence test: no available shells found');
      return;
    }
  }
  
  // Set defaultShell to the test shell
  await configManager.setValue('defaultShell', testShell);
  
  // Get config multiple times to ensure it persists
  const config1 = await configManager.getConfig();
  const config2 = await configManager.getConfig();
  
  assert.strictEqual(config1.defaultShell, testShell, 'Configuration should persist on first read');
  assert.strictEqual(config2.defaultShell, testShell, 'Configuration should persist on second read');
  assert.strictEqual(config1.defaultShell, config2.defaultShell, 'Configuration should be consistent across reads');
  
  console.log(`✓ Configuration persists correctly: ${config1.defaultShell}`);
  console.log('✓ Test 6 passed: configuration persistence works correctly');
}

/**
 * Main test function
 */
async function runDefaultShellTests() {
  console.log('=== defaultShell Configuration Tests ===\n');
  console.log(`Platform: ${os.platform()}`);
  
  // Test 1: Setting defaultShell to /bin/sh
  await testDefaultShellSh();
  
  // Test 2: Setting defaultShell to /bin/bash
  await testDefaultShellBash();
  
  // Test 3: Setting defaultShell to cmd (Windows)
  await testDefaultShellCmd();
  
  // Test 4: Setting defaultShell to pwsh (PowerShell Core)
  await testDefaultShellPwsh();
  
  // Test 5: Testing shell switching
  await testShellSwitching();
  
  // Test 6: Testing configuration persistence
  await testConfigurationPersistence();
  
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
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}