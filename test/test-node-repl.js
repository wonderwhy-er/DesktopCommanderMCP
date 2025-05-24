/**
 * Specialized test for Node.js REPL interaction
 * This test uses a direct approach with the child_process module
 * to better understand and debug Node.js REPL behavior
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Test Node.js REPL interaction directly
 */
async function testNodeREPL() {
  console.log(`${colors.blue}Direct Node.js REPL test...${colors.reset}`);
  
  // Create output directory if it doesn't exist
  const OUTPUT_DIR = path.join(__dirname, 'test_output');
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  } catch (error) {
    console.warn(`${colors.yellow}Warning: Could not create output directory: ${error.message}${colors.reset}`);
  }
  
  // File for debugging output
  const debugFile = path.join(OUTPUT_DIR, 'node_repl_debug.txt');
  let debugLog = '';
  
  // Log both to console and to file
  function log(message) {
    console.log(message);
    debugLog += message + '\n';
  }
  
  // Start Node.js REPL
  log(`${colors.blue}Starting Node.js REPL...${colors.reset}`);
  
  // Use the -i flag to ensure interactive mode
  const node = spawn('node', ['-i']);
  
  // Track all output
  let outputBuffer = '';
  
  // Set up output listeners
  node.stdout.on('data', (data) => {
    const text = data.toString();
    outputBuffer += text;
    log(`${colors.green}[STDOUT] ${text.trim()}${colors.reset}`);
  });
  
  node.stderr.on('data', (data) => {
    const text = data.toString();
    outputBuffer += text;
    log(`${colors.red}[STDERR] ${text.trim()}${colors.reset}`);
  });
  
  // Set up exit handler
  node.on('exit', (code) => {
    log(`${colors.blue}Node.js process exited with code ${code}${colors.reset}`);
    
    // Write debug log to file after exit
    fs.writeFile(debugFile, debugLog).catch(err => {
      console.error(`Failed to write debug log: ${err.message}`);
    });
  });
  
  // Wait for Node.js to initialize
  log(`${colors.blue}Waiting for Node.js startup...${colors.reset}`);
  await sleep(2000);
  
  // Log initial state
  log(`${colors.blue}Initial output buffer: ${outputBuffer}${colors.reset}`);
  
  // Send a simple command
  log(`${colors.blue}Sending simple command...${colors.reset}`);
  node.stdin.write('console.log("Hello from Node.js!");\n');
  
  // Wait for command to execute
  await sleep(2000);
  
  // Log state after first command
  log(`${colors.blue}Output after first command: ${outputBuffer}${colors.reset}`);
  
  // Send a multi-line command directly
  log(`${colors.blue}Sending multi-line command directly...${colors.reset}`);
  
  // Define the multi-line code
  const multilineCode = `
function greet(name) {
  return \`Hello, \${name}!\`;
}

for (let i = 0; i < 3; i++) {
  console.log(greet(\`User \${i}\`));
}
`;
  
  log(`${colors.blue}Sending code:${colors.reset}\n${multilineCode}`);
  
  // Send the multi-line code directly
  node.stdin.write(multilineCode + '\n');
  
  
  // Wait for execution
  await sleep(3000);
  
  // Log final state
  log(`${colors.blue}Final output buffer: ${outputBuffer}${colors.reset}`);
  
  // Check if we got the expected output
  const containsHello = outputBuffer.includes('Hello from Node.js!');
  const containsGreetings = 
    outputBuffer.includes('Hello, User 0!') &&
    outputBuffer.includes('Hello, User 1!') &&
    outputBuffer.includes('Hello, User 2!');
  
  log(`${colors.blue}Found "Hello from Node.js!": ${containsHello}${colors.reset}`);
  log(`${colors.blue}Found greetings: ${containsGreetings}${colors.reset}`);
  
  // Terminate the process
  log(`${colors.blue}Terminating Node.js process...${colors.reset}`);
  node.stdin.end();
  
  // Wait for process to exit
  await sleep(1000);
  
  // Return success status
  return containsHello && containsGreetings;
}

// Run the test
testNodeREPL()
  .then(success => {
    console.log(`\n${colors.blue}Direct Node.js REPL test ${success ? colors.green + 'PASSED' : colors.red + 'FAILED'}${colors.reset}`);
    
    // Print file location for debug log
    console.log(`${colors.blue}Debug log saved to: ${path.join(__dirname, 'test_output', 'node_repl_debug.txt')}${colors.reset}`);
    
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error(`${colors.red}Test error: ${error.message}${colors.reset}`);
    process.exit(1);
  });
