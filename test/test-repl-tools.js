/**
 * Test file for REPL tools in Desktop Commander
 * This tests the new REPL session management and interactive code execution
 */

import { replManager } from '../dist/repl-manager.js';
import { configManager } from '../dist/config-manager.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test output directory
const OUTPUT_DIR = path.join(__dirname, 'test_output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'repl_test_output.txt');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

/**
 * Sleep function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Setup function to prepare for tests
 */
async function setup() {
  console.log(`${colors.blue}Setting up REPL Tools test...${colors.reset}`);
  
  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  
  // Create output directory if it doesn't exist
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  } catch (error) {
    console.warn(`${colors.yellow}Warning: Could not create output directory: ${error.message}${colors.reset}`);
  }
  
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  console.log(`${colors.blue}Cleaning up after tests...${colors.reset}`);
  
  // Reset configuration to original
  await configManager.updateConfig(originalConfig);
  
  console.log(`${colors.green}✓ Teardown: config restored${colors.reset}`);
}

/**
 * Test Python REPL session
 */
async function testPythonREPL() {
  console.log(`${colors.cyan}Running Python REPL test...${colors.reset}`);
  
  try {
    // Create a Python REPL session
    const pid = await replManager.createSession('python', 5000);
    console.log(`${colors.green}✓ Created Python REPL session with PID ${pid}${colors.reset}`);
    
    // Execute a simple Python command
    console.log(`${colors.blue}Executing simple Python command...${colors.reset}`);
    const result1 = await replManager.executeCode(pid, 'print("Hello from Python!")');
    console.log(`${colors.blue}Result: ${JSON.stringify(result1)}${colors.reset}`);
    
    // Wait a bit to allow the REPL to process
    await sleep(1000);
    
    // Execute a multi-line Python code block
    console.log(`${colors.blue}Executing multi-line Python code block...${colors.reset}`);
    const pythonCode = `
def greet(name):
    return f"Hello, {name}!"

for i in range(3):
    print(greet(f"User {i}"))
`;
    
    const result2 = await replManager.executeCode(pid, pythonCode, { 
      multiline: true,
      timeout: 5000
    });
    console.log(`${colors.blue}Result: ${JSON.stringify(result2)}${colors.reset}`);
    
    // Terminate the session
    console.log(`${colors.blue}Terminating Python REPL session...${colors.reset}`);
    const terminated = await replManager.terminateSession(pid);
    console.log(`${colors.green}✓ Python session terminated: ${terminated}${colors.reset}`);
    
    // Check results
    const pythonSuccess = result1.success && result2.success;
    if (!pythonSuccess) {
      console.log(`${colors.red}× Python REPL test failed${colors.reset}`);
    } else {
      console.log(`${colors.green}✓ Python REPL test passed${colors.reset}`);
    }
    
    return pythonSuccess;
  } catch (error) {
    console.error(`${colors.red}× Python REPL test error: ${error.message}${colors.reset}`);
    return false;
  }
}

/**
 * Test Node.js REPL session
 */
async function testNodeREPL() {
  console.log(`${colors.cyan}Running Node.js REPL test...${colors.reset}`);
  
  try {
    // Create a Node.js REPL session
    const pid = await replManager.createSession('node', 5000);
    console.log(`${colors.green}✓ Created Node.js REPL session with PID ${pid}${colors.reset}`);
    
    // Execute a simple Node.js command
    console.log(`${colors.blue}Executing simple Node.js command...${colors.reset}`);
    const result1 = await replManager.executeCode(pid, 'console.log("Hello from Node.js!")', {
      timeout: 5000,
      waitForPrompt: true
    });
    console.log(`${colors.blue}Result: ${JSON.stringify(result1)}${colors.reset}`);
    
    // Wait a bit to allow the REPL to process
    await sleep(1000);
    
    // Execute a multi-line Node.js code block
    console.log(`${colors.blue}Executing multi-line Node.js code block...${colors.reset}`);
    const nodeCode = `
function greet(name) {
  return \`Hello, \${name}!\`;
}

for (let i = 0; i < 3; i++) {
  console.log(greet(\`User \${i}\`));
}
`;
    
    const result2 = await replManager.executeCode(pid, nodeCode, { 
      multiline: true,
      timeout: 10000,
      waitForPrompt: true
    });
    console.log(`${colors.blue}Result: ${JSON.stringify(result2)}${colors.reset}`);
    
    // Terminate the session
    console.log(`${colors.blue}Terminating Node.js REPL session...${colors.reset}`);
    const terminated = await replManager.terminateSession(pid);
    console.log(`${colors.green}✓ Node.js session terminated: ${terminated}${colors.reset}`);
    
    // Check results
    const nodeSuccess = result1.success && result2.success;
    if (!nodeSuccess) {
      console.log(`${colors.red}× Node.js REPL test failed${colors.reset}`);
    } else {
      console.log(`${colors.green}✓ Node.js REPL test passed${colors.reset}`);
    }
    
    return nodeSuccess;
  } catch (error) {
    console.error(`${colors.red}× Node.js REPL test error: ${error.message}${colors.reset}`);
    return false;
  }
}

/**
 * Test session management functionality
 */
async function testSessionManagement() {
  console.log(`${colors.cyan}Running session management test...${colors.reset}`);
  
  try {
    // Create multiple sessions
    const pid1 = await replManager.createSession('python', 5000);
    const pid2 = await replManager.createSession('node', 5000);
    console.log(`${colors.green}✓ Created multiple REPL sessions${colors.reset}`);
    
    // List active sessions
    const sessions = replManager.listSessions();
    console.log(`${colors.blue}Active sessions: ${JSON.stringify(sessions)}${colors.reset}`);
    
    // Get session info
    const info1 = replManager.getSessionInfo(pid1);
    const info2 = replManager.getSessionInfo(pid2);
    
    console.log(`${colors.blue}Session ${pid1} info: ${JSON.stringify(info1)}${colors.reset}`);
    console.log(`${colors.blue}Session ${pid2} info: ${JSON.stringify(info2)}${colors.reset}`);
    
    // Terminate sessions
    await replManager.terminateSession(pid1);
    await replManager.terminateSession(pid2);
    console.log(`${colors.green}✓ Terminated all test sessions${colors.reset}`);
    
    // Check if sessions were properly created and info retrieved
    const managementSuccess = 
      sessions.length >= 2 && 
      info1 !== null && 
      info2 !== null && 
      info1.language === 'python' && 
      info2.language === 'node';
    
    if (!managementSuccess) {
      console.log(`${colors.red}× Session management test failed${colors.reset}`);
    } else {
      console.log(`${colors.green}✓ Session management test passed${colors.reset}`);
    }
    
    return managementSuccess;
  } catch (error) {
    console.error(`${colors.red}× Session management test error: ${error.message}${colors.reset}`);
    return false;
  }
}

/**
 * Run all REPL tools tests
 */
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    
    const pythonResult = await testPythonREPL();
    const nodeResult = await testNodeREPL();
    const managementResult = await testSessionManagement();
    
    // Overall test result
    const allPassed = pythonResult && nodeResult && managementResult;
    
    console.log(`\n${colors.cyan}===== REPL Tools Test Summary =====\n${colors.reset}`);
    console.log(`Python REPL test: ${pythonResult ? colors.green + 'PASSED' : colors.red + 'FAILED'}${colors.reset}`);
    console.log(`Node.js REPL test: ${nodeResult ? colors.green + 'PASSED' : colors.red + 'FAILED'}${colors.reset}`);
    console.log(`Session management test: ${managementResult ? colors.green + 'PASSED' : colors.red + 'FAILED'}${colors.reset}`);
    console.log(`\nOverall result: ${allPassed ? colors.green + 'ALL TESTS PASSED! 🎉' : colors.red + 'SOME TESTS FAILED!'}${colors.reset}`);
    
    return allPassed;
  } catch (error) {
    console.error(`${colors.red}✗ Test execution error: ${error.message}${colors.reset}`);
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
    console.error(`${colors.red}✗ Unhandled error: ${error}${colors.reset}`);
    process.exit(1);
  }).then(success => {
    process.exit(success ? 0 : 1);
  });
}
