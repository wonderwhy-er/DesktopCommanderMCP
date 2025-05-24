import {
  executeCommand,
  readOutput,
  forceTerminate
} from '../dist/tools/execute.js';
import { sendInput } from '../dist/tools/send-input.js';

async function simplePythonTest() {
  try {
    console.log("Starting Python with a simple command...");
    
    // Run Python with a print command directly
    const result = await executeCommand({
      command: 'python -c "print(\'Hello from Python\')"',
      timeout_ms: 5000
    });
    
    console.log("Result:", JSON.stringify(result, null, 2));
    
    // Now let's try interactive mode
    console.log("\nStarting Python in interactive mode...");
    const interactiveResult = await executeCommand({
      command: 'python -i',
      timeout_ms: 5000
    });
    
    console.log("Interactive result:", JSON.stringify(interactiveResult, null, 2));
    
    // Extract PID from the result text
    const pidMatch = interactiveResult.content[0].text.match(/Command started with PID (\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1]) : null;
    
    if (!pid) {
      console.error("Failed to get PID from Python process");
      return;
    }
    
    console.log(`Started Python session with PID: ${pid}`);
    
    // Initial read to get the Python prompt
    console.log("Reading initial output...");
    const initialOutput = await readOutput({ pid });
    console.log("Initial output:", JSON.stringify(initialOutput, null, 2));
    
    // Send a simple Python command with explicit newline
    console.log("Sending command...");
    const inputResult = await sendInput({
      pid,
      input: 'print("Hello from interactive Python")\n'
    });
    console.log("Input result:", JSON.stringify(inputResult, null, 2));
    
    // Wait a moment for Python to process
    console.log("Waiting for processing...");
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Read the output
    console.log("Reading output...");
    const output = await readOutput({ pid });
    console.log("Output:", JSON.stringify(output, null, 2));
    
    // Terminate the session
    console.log("Terminating session...");
    const terminateResult = await forceTerminate({ pid });
    console.log("Terminate result:", JSON.stringify(terminateResult, null, 2));
    
    console.log("Test completed");
  } catch (error) {
    console.error("Error in test:", error);
  }
}

simplePythonTest();
