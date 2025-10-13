#!/usr/bin/env node

/**
 * Test to verify that read_process_output doesn't break future calls
 * by removing TerminalManager's listeners with removeAllListeners
 *
 * Expected behavior:
 * 1. Start Node.js REPL
 * 2. Send command with interact_with_process
 * 3. Call read_process_output - should work
 * 4. Send another command with interact_with_process
 * 5. Call read_process_output again - should STILL work (this would fail with removeAllListeners bug)
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  console.log('🧪 Testing listener cleanup bug...\n');

  // Start the MCP server
  const serverPath = path.join(__dirname, 'dist', 'index.js');
  const server = spawn('node', [serverPath, '--no-onboarding'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let responseBuffer = '';
  let requestId = 1;

  server.stdout.on('data', (data) => {
    responseBuffer += data.toString();
  });

  server.stderr.on('data', (data) => {
    console.error('Server stderr:', data.toString());
  });

  function sendRequest(method, params) {
    const request = {
      jsonrpc: '2.0',
      id: requestId++,
      method,
      params
    };
    server.stdin.write(JSON.stringify(request) + '\n');
  }

  function waitForResponse(expectedId, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const lines = responseBuffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line);
            if (response.id === expectedId) {
              clearInterval(checkInterval);
              responseBuffer = responseBuffer.replace(line, '');
              resolve(response);
              return;
            }
          } catch (e) {
            // Not valid JSON yet, keep waiting
          }
        }

        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for response ${expectedId}`));
        }
      }, 50);
    });
  }

  async function callTool(name, args) {
    const id = requestId;
    sendRequest('tools/call', { name, arguments: args });
    const response = await waitForResponse(id);
    if (response.error) {
      throw new Error(`Tool error: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  try {
    // Initialize
    sendRequest('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await waitForResponse(requestId - 1);

    console.log('✅ Server initialized\n');

    // Step 1: Start Node.js REPL
    console.log('📝 Step 1: Starting Node.js REPL...');
    const startResult = await callTool('start_process', {
      command: 'node -i',
      timeout_ms: 5000
    });
    const pidMatch = startResult.content[0].text.match(/PID (\d+)/);
    const pid = parseInt(pidMatch[1]);
    console.log(`✅ Started process with PID: ${pid}\n`);

    // Step 2: Send first command
    console.log('📝 Step 2: Sending first command (1 + 1)...');
    const interact1 = await callTool('interact_with_process', {
      pid,
      input: '1 + 1',
      timeout_ms: 3000
    });
    console.log('✅ First interact succeeded');
    console.log(`   Output snippet: ${interact1.content[0].text.substring(0, 50)}...\n`);

    // Step 3: First read_process_output (this might break listeners with removeAllListeners)
    console.log('📝 Step 3: First read_process_output...');
    const read1 = await callTool('read_process_output', {
      pid,
      timeout_ms: 1000
    });
    console.log('✅ First read_process_output succeeded');
    console.log(`   Output: ${read1.content[0].text.substring(0, 50)}...\n`);

    // Step 4: Send second command WITHOUT waiting (so output stays in buffer)
    console.log('📝 Step 4: Sending second command (2 + 2) WITHOUT waiting...');
    const interact2 = await callTool('interact_with_process', {
      pid,
      input: '2 + 2',
      timeout_ms: 3000,
      wait_for_prompt: false  // Don't wait, let read_process_output get it
    });
    console.log('✅ Second interact sent (not waiting for output)\n');

    // Wait a bit for output to arrive
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 5: Second read_process_output (THIS WILL FAIL if listeners were removed)
    console.log('📝 Step 5: Second read_process_output (critical test)...');
    const read2 = await callTool('read_process_output', {
      pid,
      timeout_ms: 2000
    });

    const outputText = read2.content[0].text;
    const hasOutput = !outputText.includes('No new output') &&
                      !outputText.includes('Timeout reached');

    if (!hasOutput) {
      console.error('❌ BUG DETECTED: Second read_process_output returned no output!');
      console.error('   This means TerminalManager listeners were removed by removeAllListeners');
      console.error(`   Full output: ${outputText}`);
      process.exit(1);
    }

    // Validate output contains expected result from "2 + 2"
    if (!outputText.includes('4')) {
      console.error('❌ BUG DETECTED: Second read_process_output has corrupt output!');
      console.error(`   Expected result "4" from "2 + 2" but got: ${outputText}`);
      process.exit(1);
    }

    // Validate output contains REPL prompt (proves detection is working)
    if (!outputText.includes('>')) {
      console.error('❌ BUG DETECTED: Second read_process_output missing REPL prompt!');
      console.error(`   Expected ">" prompt but got: ${outputText}`);
      process.exit(1);
    }

    console.log('✅ Second read_process_output succeeded!');
    console.log(`   ✓ Contains expected result: "4"`);
    console.log(`   ✓ Contains REPL prompt: ">"`);
    console.log(`   Full output: ${outputText.substring(0, 100)}...\n`);

    // Cleanup
    await callTool('force_terminate', { pid });
    console.log('✅ Process terminated\n');

    console.log('🎉 All tests passed! Listener cleanup is working correctly.');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    server.kill();
  }
}

runTest();
