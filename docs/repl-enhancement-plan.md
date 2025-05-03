w# REPL Enhancement Plan

This document outlines the plan to enhance the terminal tools in ClaudeServerCommander to better support REPL (Read-Eval-Print Loop) environments. It continues the refactoring work we've already done to simplify the REPL implementation by using terminal commands.

## Background

We've successfully refactored the specialized REPL manager and tools to use the more general terminal commands (`execute_command`, `send_input`, `read_output`, and `force_terminate`). This approach is simpler, more flexible, and works for any interactive terminal environment without requiring specialized configurations.

However, there are some enhancements we can make to improve the user experience when working with REPLs:

1. Add timeout support to `read_output` and `send_input`
2. Enhance `send_input` to wait for REPL responses
3. Improve output collection and prompt detection

## Files to Modify

### 1. src/tools/schemas.ts

Update the schemas to support the new parameters:

```typescript
export const ReadOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().optional(),
});

export const SendInputArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().optional(),
  wait_for_prompt: z.boolean().optional(),
});
```

### 2. src/tools/execute.js

Enhance the `readOutput` function to handle timeouts and wait for complete output:

```typescript
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
```

### 3. src/tools/send-input.js

Enhance the `sendInput` function to wait for REPL responses:

```typescript
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
            const hasPrompt = promptPatterns.some(pattern => pattern.test(newOutput.trim().split('\n').pop() || ''));
            
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
```

### 4. src/terminal-manager.ts

Add a method to get a session by PID:

```typescript
/**
 * Get a session by PID
 * @param pid Process ID
 * @returns The session or undefined if not found
 */
getSession(pid: number): TerminalSession | undefined {
  return this.sessions.get(pid);
}
```

## Tests to Create

### 1. test/test-enhanced-repl.js

Create a new test file to verify the enhanced functionality:

```javascript
import assert from 'assert';
import { executeCommand, readOutput, sendInput, forceTerminate } from '../dist/tools/execute.js';
import { sendInput as sendInputDirectly } from '../dist/tools/send-input.js';

/**
 * Test enhanced REPL functionality
 */
async function testEnhancedREPL() {
  console.log('Testing enhanced REPL functionality...');
  
  // Start Python in interactive mode
  console.log('Starting Python REPL...');
  const result = await executeCommand({
    command: 'python -i',
    timeout_ms: 10000
  });
  
  // Extract PID from the result text
  const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1]) : null;
  
  if (!pid) {
    console.error("Failed to get PID from Python process");
    return false;
  }
  
  console.log(`Started Python session with PID: ${pid}`);
  
  // Test read_output with timeout
  console.log('Testing read_output with timeout...');
  const initialOutput = await readOutput({ 
    pid, 
    timeout_ms: 2000 
  });
  console.log('Initial Python prompt:', initialOutput.content[0].text);
  
  // Test send_input with wait_for_prompt
  console.log('Testing send_input with wait_for_prompt...');
  const inputResult = await sendInputDirectly({
    pid,
    input: 'print("Hello from Python with wait!")\n',
    wait_for_prompt: true,
    timeout_ms: 5000
  });
  console.log('Python output with wait_for_prompt:', inputResult.content[0].text);
  
  // Test send_input without wait_for_prompt
  console.log('Testing send_input without wait_for_prompt...');
  await sendInputDirectly({
    pid,
    input: 'print("Hello from Python without wait!")\n',
    wait_for_prompt: false
  });
  
  // Wait a moment for Python to process
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Read the output
  const output = await readOutput({ pid });
  console.log('Python output without wait_for_prompt:', output.content[0].text);
  
  // Test multi-line code with wait_for_prompt
  console.log('Testing multi-line code with wait_for_prompt...');
  const multilineCode = `
def greet(name):
    return f"Hello, {name}!"

for i in range(3):
    print(greet(f"Guest {i+1}"))
`;
  
  const multilineResult = await sendInputDirectly({
    pid,
    input: multilineCode + '\n',
    wait_for_prompt: true,
    timeout_ms: 5000
  });
  console.log('Python multi-line output with wait_for_prompt:', multilineResult.content[0].text);
  
  // Terminate the session
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
```

## Example Code

Update the `repl-via-terminal-example.js` file to use the enhanced functionality:

```javascript
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
  const initialOutput = await readOutput({ 
    pid,
    timeout_ms: 2000 
  });
  console.log("Initial Python prompt:", initialOutput.content[0].text);
  
  // Send a simple Python command with wait_for_prompt
  console.log("Sending simple command...");
  const simpleResult = await sendInput({
    pid,
    input: 'print("Hello from Python!")\n',
    wait_for_prompt: true,
    timeout_ms: 3000
  });
  console.log('Python output with wait_for_prompt:', simpleResult.content[0].text);
  
  // Send a multi-line code block with wait_for_prompt
  console.log("Sending multi-line code...");
  const multilineCode = `
def greet(name):
    return f"Hello, {name}!"

for i in range(3):
    print(greet(f"Guest {i+1}"))
`;
  
  const multilineResult = await sendInput({
    pid,
    input: multilineCode + '\n',
    wait_for_prompt: true,
    timeout_ms: 5000
  });
  console.log('Python multi-line output with wait_for_prompt:', multilineResult.content[0].text);
  
  // Terminate the session
  await forceTerminate({ pid });
  console.log('Python session terminated');
}

// Run the example
pythonREPLExample()
  .catch(error => {
    console.error('Error running example:', error);
  });
```

## Documentation Updates

Update the `repl-with-terminal.md` file to document the enhanced functionality:

```markdown
# Enhanced Terminal Commands for REPL Environments

## New Features

### 1. Timeout Support

Both `read_output` and `send_input` now support a `timeout_ms` parameter:

```javascript
// Read output with a 5 second timeout
const output = await readOutput({ 
  pid: pid,
  timeout_ms: 5000
});
```

### 2. Wait for REPL Response

The `send_input` function now supports a `wait_for_prompt` parameter that waits for the REPL to finish processing and show a prompt:

```javascript
// Send input and wait for the REPL prompt
const result = await sendInput({
  pid: pid,
  input: 'print("Hello, world!")\n',
  wait_for_prompt: true,
  timeout_ms: 5000
});

// The result includes the output from the command
console.log(result.content[0].text);
```

### 3. Prompt Detection

When `wait_for_prompt` is enabled, the function detects common REPL prompts:
- Node.js: `>` 
- Python: `>>>` or `...`
- And others

This allows it to know when the REPL has finished processing a command.
```

## Implementation Steps

1. First, update the schemas to add the new parameters
2. Add the `getSession` method to the terminal manager
3. Enhance `readOutput` to support timeouts and waiting for output
4. Enhance `sendInput` to support waiting for REPL prompts
5. Create tests to verify the enhanced functionality
6. Update the example code and documentation

## Testing Strategy

1. Test with different REPL environments (Python, Node.js)
2. Test with single-line and multi-line code
3. Test with different timeout values
4. Test prompt detection for different REPLs
5. Verify that output is correctly captured and returned

## Next Steps After Implementation

1. Finalize code and run all tests
2. Create a pull request with the changes
3. Update the main documentation to reflect the enhanced functionality
4. Consider adding support for other REPL environments and prompt patterns

## Previous Work

These enhancements build on the successful refactoring of the REPL functionality to use terminal commands. We've already:

1. Removed the specialized REPL manager
2. Enhanced the terminal manager to handle interactive sessions
3. Updated tests to verify the refactored approach
4. Created documentation and examples showing how to use terminal commands for REPLs

The current changes will make these terminal commands even more effective for REPL environments by handling timeouts, waiting for responses, and detecting REPL prompts.
