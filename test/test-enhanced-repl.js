import assert from 'assert';
import { startProcess, readProcessOutput, forceTerminate, interactWithProcess } from '../dist/tools/improved-process-tools.js';

/**
 * Test enhanced REPL functionality
 */
async function testEnhancedREPL() {
  console.log('Testing enhanced REPL functionality...');
  
  // Start Python in interactive mode
  console.log('Starting Python REPL...');
  const result = await startProcess({
    command: 'python -i',
    timeout_ms: 10000
  });
  
  console.log('Result from start_process:', result);
  
  // Extract PID from the result text
  const pidMatch = result.content[0].text.match(/Process started with PID (\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1]) : null;
  
  if (!pid) {
    console.error("Failed to get PID from Python process");
    return false;
  }
  
  console.log(`Started Python session with PID: ${pid}`);
  
  // We'll stick to using the existing tools for now to test the basic functionality
  
  // Send a simple Python command
  console.log("Sending simple command...");
  await interactWithProcess({
    pid,
    input: 'print("Hello from Python!")\n'
  });
  
  // Wait a moment for Python to process
  console.log("Waiting for output...");
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Read the output
  console.log("Reading output...");
  const output = await readProcessOutput({ pid });
  console.log('Python output:', output.content[0].text);
  
  // Terminate the session
  console.log("Terminating session...");
  await forceTerminate({ pid });
  console.log('Python session terminated');
  
  return true;
}

// Run the test
testEnhancedREPL()
  .then(success => {
    console.log(`Enhanced REPL test ${success ? 'PASSED' : 'FAILED'}`);
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  });