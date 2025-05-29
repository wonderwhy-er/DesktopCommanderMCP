# Enhanced Terminal Commands for REPL Environments

This document explains the enhanced functionality for interacting with REPL (Read-Eval-Print Loop) environments using terminal commands.

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

This prevents indefinite waiting for output and makes REPL interactions more reliable.

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

This eliminates the need for manual delays between sending input and reading output.

### 3. Prompt Detection

When `wait_for_prompt` is enabled, the function detects common REPL prompts:

- Node.js: `>` 
- Python: `>>>` or `...`
- And others

This allows it to know when the REPL has finished processing a command.

## Basic Workflow

### 1. Starting a REPL Session

Use the `execute_command` function to start a REPL environment in interactive mode:

```javascript
// Start Python
const pythonResult = await executeCommand({
  command: 'python -i',  // Use -i flag for interactive mode
  timeout_ms: 10000
});

// Extract PID from the result text
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;
```

### 2. Reading the Initial Prompt with Timeout

After starting a REPL session, you can read the initial output with a timeout:

```javascript
// Wait for REPL to initialize with a timeout
const initialOutput = await readOutput({ 
  pid,
  timeout_ms: 2000 
});
console.log("Initial prompt:", initialOutput.content[0].text);
```

### 3. Sending Code to the REPL and Waiting for Response

Use the enhanced `send_input` function to send code to the REPL and wait for the response:

```javascript
// Send a single-line command and wait for the prompt
const result = await sendInput({
  pid: pid,
  input: 'print("Hello, world!")\n',
  wait_for_prompt: true,
  timeout_ms: 3000
});

console.log("Output:", result.content[0].text);
```

### 4. Sending Multi-line Code Blocks

You can also send multi-line code blocks and wait for the complete response:

```javascript
// Send multi-line code block and wait for the prompt
const multilineCode = `
def greet(name):
    return f"Hello, {name}!"

print(greet("World"))
`;

const result = await sendInput({
  pid: pid,
  input: multilineCode + '\n',
  wait_for_prompt: true,
  timeout_ms: 5000
});

console.log("Output:", result.content[0].text);
```

### 5. Terminating the REPL Session

When you're done, use `force_terminate` to end the session:

```javascript
await forceTerminate({ pid });
```

## Examples for Different REPL Environments

### Python

```javascript
// Start Python in interactive mode
const result = await executeCommand({ command: 'python -i' });
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;

// Read initial prompt with timeout
const initialOutput = await readOutput({ 
  pid,
  timeout_ms: 2000
});

// Run code and wait for response
const output = await sendInput({
  pid,
  input: 'print("Hello from Python!")\n',
  wait_for_prompt: true,
  timeout_ms: 3000
});
```

### Node.js

```javascript
// Start Node.js in interactive mode
const result = await executeCommand({ command: 'node -i' });
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;

// Read initial prompt with timeout
const initialOutput = await readOutput({ 
  pid,
  timeout_ms: 2000
});

// Run code and wait for response
const output = await sendInput({
  pid,
  input: 'console.log("Hello from Node.js!")\n',
  wait_for_prompt: true,
  timeout_ms: 3000
});
```

## Tips and Best Practices

1. **Set Appropriate Timeouts**: Different commands may require different timeout values. Complex operations might need longer timeouts.

2. **Use wait_for_prompt for Sequential Commands**: When running multiple commands that depend on each other, use `wait_for_prompt: true` to ensure commands are executed in order.

3. **Add Newlines to Input**: Always add a newline character at the end of your input to trigger execution:

   ```javascript
   await sendInput({ 
     pid, 
     input: 'your_code_here\n',
     wait_for_prompt: true 
   });
   ```

4. **Handling Long-Running Operations**: For commands that take a long time to execute, increase the timeout value:

   ```javascript
   await sendInput({
     pid,
     input: 'import time; time.sleep(10); print("Done")\n',
     wait_for_prompt: true,
     timeout_ms: 15000  // 15 seconds
   });
   ```

5. **Error Handling**: Check if a timeout was reached:

   ```javascript
   const result = await sendInput({
     pid,
     input: 'complex_calculation()\n',
     wait_for_prompt: true,
     timeout_ms: 5000
   });
   
   if (result.content[0].text.includes('timeout reached')) {
     console.log('Operation took too long');
   }
   ```

## Complete Examples

See the files:
- `test/enhanced-repl-example.js` for a complete example showing how to interact with Python and Node.js REPLs.
- `test/test-enhanced-repl.js` for tests of the enhanced functionality.
