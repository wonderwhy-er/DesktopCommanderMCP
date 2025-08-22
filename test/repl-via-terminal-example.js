/**
 * This example demonstrates how to use terminal commands to interact with a REPL environment
 * without needing specialized REPL tools.
 */

import {
  executeCommand,
  readOutput,
  forceTerminate
} from '../dist/tools/execute.js';
import { sendInput } from '../dist/tools/send-input.js';

// Example of starting and interacting with a Python REPL session
async function pythonREPLExample() {
  console.log('Starting a Python REPL session...');
  
  // Start Python interpreter in interactive mode
  const result = await executeCommand({
    command: 'python -i',
    timeout_ms: 10000
  });
  
  // Extract PID from the result text
  const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1]) : null;
  
  if (!pid) {
    console.error("Failed to get PID from Python process");
    return;
  }
  
  console.log(`Started Python session with PID: ${pid}`);
  
  // Initial read to get the Python prompt
  console.log("Reading initial output...");
  const initialOutput = await readOutput({ pid });
  console.log("Initial Python prompt:", initialOutput.content[0].text);
  
  // Send a simple Python command
  console.log("Sending simple command...");
  await sendInput({
    pid,
    input: 'print("Hello from Python!")\n'
  });
  
  // Wait a moment for Python to process
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Read the output
  const output = await readOutput({ pid });
  console.log('Python output:', output.content[0].text);
  
  // Send a multi-line code block
  console.log("Sending multi-line code...");
  const multilineCode = `
def greet(name):
    return f"Hello, {name}!"

for i in range(3):
    print(greet(f"Guest {i+1}"))
`;
  
  await sendInput({
    pid,
    input: multilineCode + '\n'
  });
  
  // Wait a moment for Python to process
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Read the output
  const multilineOutput = await readOutput({ pid });
  console.log('Python multi-line output:', multilineOutput.content[0].text);
  
  // Terminate the session
  await forceTerminate({ pid });
  console.log('Python session terminated');
}

// Example of starting and interacting with a Node.js REPL session
async function nodeREPLExample() {
  console.log('Starting a Node.js REPL session...');
  
  // Start Node.js interpreter in interactive mode
  const result = await executeCommand({
    command: 'node -i',
    timeout_ms: 10000
  });
  
  // Extract PID from the result text
  const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1]) : null;
  
  if (!pid) {
    console.error("Failed to get PID from Node.js process");
    return;
  }
  
  console.log(`Started Node.js session with PID: ${pid}`);
  
  // Initial read to get the Node.js prompt
  console.log("Reading initial output...");
  const initialOutput = await readOutput({ pid });
  console.log("Initial Node.js prompt:", initialOutput.content[0].text);
  
  // Send a simple JavaScript command
  console.log("Sending simple command...");
  await sendInput({
    pid,
    input: 'console.log("Hello from Node.js!")\n'
  });
  
  // Wait a moment for Node.js to process
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Read the output
  const output = await readOutput({ pid });
  console.log('Node.js output:', output.content[0].text);
  
  // Send a multi-line code block
  console.log("Sending multi-line code...");
  const multilineCode = `
function greet(name) {
  return \`Hello, \${name}!\`;
}

for (let i = 0; i < 3; i++) {
  console.log(greet(\`Guest \${i+1}\`));
}
`;
  
  await sendInput({
    pid,
    input: multilineCode + '\n'
  });
  
  // Wait a moment for Node.js to process
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Read the output
  const multilineOutput = await readOutput({ pid });
  console.log('Node.js multi-line output:', multilineOutput.content[0].text);
  
  // Terminate the session
  await forceTerminate({ pid });
  console.log('Node.js session terminated');
}

// Run the examples
async function runExamples() {
  try {
    await pythonREPLExample();
    console.log('\n----------------------------\n');
    await nodeREPLExample();
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

runExamples();
