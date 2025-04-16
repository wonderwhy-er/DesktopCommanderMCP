// Final test of the updated sandbox implementation
import { executeSandboxedCommand } from '../dist/sandbox/index.js';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';

// Helper function to execute commands
function execute(command) {
  return new Promise((resolve) => {
    console.log(`Executing: ${command}`);
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
      }
      if (stderr) {
        console.error(`Stderr: ${stderr}`);
      }
      resolve({ output: stdout || '', error, stderr });
    });
  });
}

async function runTest() {
  const testDir = path.join(os.homedir(), 'final-test');
  const allowedDir = path.join(testDir, 'allowed');
  const restrictedDir = path.join(testDir, 'restricted');
  
  try {
    // Create test directories
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(restrictedDir, { recursive: true });
    console.log(`Created test directories:`);
    console.log(`- Allowed: ${allowedDir}`);
    console.log(`- Restricted: ${restrictedDir}`);
    
    // Test 1: Create a file in the allowed directory
    console.log('\nTest 1: Create file in allowed directory');
    const result1 = await executeSandboxedCommand(
      `echo "This should work" > ${path.join(allowedDir, 'test.txt')}`,
      5000
    );
    console.log(`Exit code: ${result1.exitCode}`);
    console.log(`Output: ${result1.output}`);
    
    // Check if the file was created
    try {
      const content = await fs.readFile(path.join(allowedDir, 'test.txt'), 'utf8');
      console.log(`✅ SUCCESS: File created with content: "${content.trim()}"`);
    } catch (error) {
      console.error(`❌ FAIL: Could not create file: ${error.message}`);
    }
    
    // Test 2: Try to create a file in the restricted directory
    console.log('\nTest 2: Try to create file in restricted directory');
    const result2 = await executeSandboxedCommand(
      `echo "This should fail" > ${path.join(restrictedDir, 'test.txt')}`,
      5000
    );
    console.log(`Exit code: ${result2.exitCode}`);
    console.log(`Output: ${result2.output}`);
    
    // Check if the file was created (shouldn't be)
    try {
      await fs.access(path.join(restrictedDir, 'test.txt'));
      const content = await fs.readFile(path.join(restrictedDir, 'test.txt'), 'utf8');
      console.error(`❌ FAIL: File was created with content: "${content.trim()}"`);
    } catch (error) {
      console.log(`✅ SUCCESS: File was not created in restricted directory`);
    }
    
    // Test 3: Execute a command with stdout
    console.log('\nTest 3: Execute command with stdout');
    const result3 = await executeSandboxedCommand(
      `ls -la ${allowedDir}`,
      5000
    );
    console.log(`Exit code: ${result3.exitCode}`);
    console.log(`Output: ${result3.output}`);
    
    // Test 4: Try to execute 'ls' on restricted directory
    console.log('\nTest 4: Try to list restricted directory');
    const result4 = await executeSandboxedCommand(
      `ls -la ${restrictedDir}`,
      5000
    );
    console.log(`Exit code: ${result4.exitCode}`);
    console.log(`Output: ${result4.output}`);
    
  } catch (error) {
    console.error('Test error:', error);
  } finally {
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      console.log(`\nCleaned up test directory: ${testDir}`);
    } catch (error) {
      console.error(`Error cleaning up: ${error.message}`);
    }
  }
}

console.log('=== Running Final Sandbox Test ===');
runTest()
  .then(() => console.log('=== Test Completed ==='))
  .catch(console.error);
