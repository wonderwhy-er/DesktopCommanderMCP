# Using Terminal Commands for REPL Environments

This document explains how to use the standard terminal commands to interact with REPL (Read-Eval-Print Loop) environments like Python, Node.js, Ruby, PHP, and others.

## Overview

Instead of having specialized REPL tools, the ClaudeServerCommander uses the standard terminal commands to interact with any interactive environment. This approach is:

- **Simple**: No need for language-specific configurations
- **Flexible**: Works with any REPL environment without special handling
- **Consistent**: Uses the same interface for all interactive sessions

## Basic Workflow

### 1. Starting a REPL Session

Use the `execute_command` function to start a REPL environment in interactive mode:

```javascript
// Start Python
const pythonResult = await executeCommand({
  command: 'python -i',  // Use -i flag for interactive mode
  timeout_ms: 10000
});

// Start Node.js
const nodeResult = await executeCommand({
  command: 'node -i',  // Use -i flag for interactive mode
  timeout_ms: 10000
});

// Extract PID from the result text
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;
```

### 2. Reading the Initial Prompt

After starting a REPL session, you should read the initial output to capture the prompt:

```javascript
// Wait for REPL to initialize
const initialOutput = await readOutput({ pid });
console.log("Initial prompt:", initialOutput.content[0].text);
```

### 3. Sending Code to the REPL

Use the `send_input` function to send code to the REPL, making sure to include a newline at the end:

```javascript
// Send a single-line command
await sendInput({
  pid: pid,
  input: 'print("Hello, world!")\n'  // Python example
});

// Send multi-line code block
const multilineCode = `
def greet(name):
    return f"Hello, {name}!"

print(greet("World"))
`;

await sendInput({
  pid: pid,
  input: multilineCode + '\n'  // Add newline at the end
});
```

### 4. Reading Output from the REPL

Use the `read_output` function to get the results:

```javascript
// Wait a moment for the REPL to process
await new Promise(resolve => setTimeout(resolve, 500));

// Read the output
const output = await readOutput({ pid });
console.log("Output:", output.content[0].text);
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

// Read initial prompt
const initialOutput = await readOutput({ pid });

// Run code
await sendInput({ pid, input: 'print("Hello from Python!")\n' });

// Wait and read output
await new Promise(resolve => setTimeout(resolve, 500));
const output = await readOutput({ pid });
```

### Node.js

```javascript
// Start Node.js in interactive mode
const result = await executeCommand({ command: 'node -i' });
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;

// Read initial prompt
const initialOutput = await readOutput({ pid });

// Run code
await sendInput({ pid, input: 'console.log("Hello from Node.js!")\n' });

// Wait and read output
await new Promise(resolve => setTimeout(resolve, 500));
const output = await readOutput({ pid });
```

### Ruby

```javascript
// Start Ruby in interactive mode
const result = await executeCommand({ command: 'irb' });
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;

// Read initial prompt
const initialOutput = await readOutput({ pid });

// Run code
await sendInput({ pid, input: 'puts "Hello from Ruby!"\n' });

// Wait and read output
await new Promise(resolve => setTimeout(resolve, 500));
const output = await readOutput({ pid });
```

### PHP

```javascript
// Start PHP in interactive mode
const result = await executeCommand({ command: 'php -a' });
const pidMatch = result.content[0].text.match(/Command started with PID (\d+)/);
const pid = pidMatch ? parseInt(pidMatch[1]) : null;

// Read initial prompt
const initialOutput = await readOutput({ pid });

// Run code
await sendInput({ pid, input: 'echo "Hello from PHP!";\n' });

// Wait and read output
await new Promise(resolve => setTimeout(resolve, 500));
const output = await readOutput({ pid });
```

## Tips and Best Practices

1. **Always Use Interactive Mode**: Many interpreters have a specific flag for interactive mode:
   - Python: `-i` flag
   - Node.js: `-i` flag
   - PHP: `-a` flag

2. **Add Newlines to Input**: Always add a newline character at the end of your input to trigger execution:

   ```javascript
   await sendInput({ pid, input: 'your_code_here\n' });
   ```

3. **Add Delays Between Operations**: Most REPLs need time to process input. Adding a small delay between sending input and reading output helps ensure you get the complete response:

   ```javascript
   await sendInput({ pid, input: complexCode + '\n' });
   await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
   const output = await readOutput({ pid });
   ```

4. **Multi-line Code Handling**: Most REPLs can handle multi-line code blocks sent at once, but be sure to add a newline at the end:

   ```javascript
   await sendInput({
     pid,
     input: multilineCodeBlock + '\n'
   });
   ```

5. **Error Handling**: Check the output for error messages:

   ```javascript
   const output = await readOutput({ pid });
   const text = output.content[0].text;
   if (text.includes('Error') || text.includes('Exception')) {
     console.error('REPL returned an error:', text);
   }
   ```

## Complete Example

See the file `test/repl-via-terminal-example.js` for a complete example showing how to interact with Python and Node.js REPLs using terminal commands.

