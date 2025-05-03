import { terminalManager } from '../terminal-manager.js';
import { SendInputArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";

export async function sendInput(args) {
  const parsed = SendInputArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_send_input_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for send_input: ${parsed.error}` }],
      isError: true,
    };
  }

  const { pid, input, timeout_ms = 5000, wait_for_prompt = false } = parsed.data;
  
  try {
    capture('server_send_input', {
      pid: pid,
      inputLength: input.length
    });

    // Try to send input to the process
    const success = terminalManager.sendInputToProcess(pid, input);
    
    if (!success) {
      return {
        content: [{ type: "text", text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.` }],
        isError: true,
      };
    }

    // If we don't need to wait for output, return immediately
    if (!wait_for_prompt) {
      return {
        content: [{
          type: "text",
          text: `Successfully sent input to process ${pid}. Use read_output to get the process response.`
        }],
      };
    }

    // Wait for output with timeout
    let output = "";
    let timeoutReached = false;
    
    try {
      // Create a promise that resolves when new output is available or when timeout is reached
      const outputPromise = new Promise((resolve) => {
        // Setup an interval to poll for output
        const interval = setInterval(() => {
          const newOutput = terminalManager.getNewOutput(pid);
          
          if (newOutput && newOutput.length > 0) {
            output += newOutput;
            
            // Check if output contains a prompt pattern (indicating the REPL is ready for more input)
            const promptPatterns = [/^>\s*$/, /^>>>\s*$/, /^\.{3}\s*$/]; // Common REPL prompts
            const lines = output.split('\n');
            const lastLine = lines[lines.length - 1];
            const hasPrompt = promptPatterns.some(pattern => pattern.test(lastLine.trim()));
            
            if (hasPrompt) {
              clearInterval(interval);
              resolve(output);
            }
          }
        }, 100); // Check every 100ms
        
        // Set a timeout to stop waiting
        setTimeout(() => {
          clearInterval(interval);
          timeoutReached = true;
          
          // Get any final output
          const finalOutput = terminalManager.getNewOutput(pid);
          if (finalOutput) {
            output += finalOutput;
          }
          
          resolve(output);
        }, timeout_ms);
      });
      
      await outputPromise;
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading output after sending input: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Input sent to process ${pid}.\n\nOutput received:\n${output || '(No output)'}${timeoutReached ? ' (timeout reached)' : ''}`
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_send_input_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error sending input: ${errorMessage}` }],
      isError: true,
    };
  }
}