import { terminalManager } from '../terminal-manager.js';
import { ReadOutputArgsSchema } from './schemas.js';

export async function readOutput(args) {
  const parsed = ReadOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_output: ${parsed.error}` }],
      isError: true,
    };
  }

  const { pid, timeout_ms = 5000 } = parsed.data;
  
  // Check if the process exists
  const session = terminalManager.getSession(pid);
  if (!session) {
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }

  // Wait for output with timeout
  let output = "";
  let timeoutReached = false;
  
  try {
    // Create a promise that resolves when new output is available or when timeout is reached
    const outputPromise = new Promise((resolve) => {
      // Check for initial output
      const initialOutput = terminalManager.getNewOutput(pid);
      if (initialOutput && initialOutput.length > 0) {
        resolve(initialOutput);
        return;
      }
      
      // Setup an interval to poll for output
      const interval = setInterval(() => {
        const newOutput = terminalManager.getNewOutput(pid);
        if (newOutput && newOutput.length > 0) {
          clearInterval(interval);
          resolve(newOutput);
        }
      }, 100); // Check every 100ms
      
      // Set a timeout to stop waiting
      setTimeout(() => {
        clearInterval(interval);
        timeoutReached = true;
        resolve(terminalManager.getNewOutput(pid) || "");
      }, timeout_ms);
    });
    
    output = await outputPromise;
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error reading output: ${error}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: output || 'No new output available' + (timeoutReached ? ' (timeout reached)' : '')
    }],
  };
}