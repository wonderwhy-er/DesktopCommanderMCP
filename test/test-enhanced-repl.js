import assert from 'assert';
import { startProcess, readProcessOutput, forceTerminate, interactWithProcess } from '../dist/tools/improved-process-tools.js';
import { getSystemInfo } from '../dist/utils/system-info.js';
import { skip } from './helpers/run-if-main.js';
import { exitProcess } from '../dist/utils/exit-process.js';


/**
 * Test enhanced REPL functionality
 */
async function testEnhancedREPL() {
  console.log('Testing enhanced REPL functionality...');

  // Use the Python the server itself detected
  const { pythonInfo } = getSystemInfo();
  if (!pythonInfo.available) {
    skip('Enhanced REPL test: Python 3 is not installed');
    return true;
  }
  const pythonCommand = pythonInfo.command;
  console.log(`Using python command: ${pythonCommand}`);

  // Start Python in interactive mode (shell left to start_process's platform default)
  console.log('Starting Python REPL...');
  const result = await startProcess({
    command: `${pythonCommand} -i`,
    timeout_ms: 10000,
    verbose_timing: true
  });

  console.log('Result from start_process:', result);

  const pid = result.structuredContent?.pid;

  if (!pid) {
    console.error("Failed to get PID from Python process");
    return false;
  }

  try {
    console.log(`Started Python session with PID: ${pid}`);

    // A running shell does not prove that Python is ready to accept input.
    console.log('Testing read_process_output with timeout...');
    const readinessDeadline = Date.now() + 2000;
    let initialText = result.content.map(part => part.text ?? '').join('\n');
    const hasPythonPrompt = () => /(?:^|\n)>>>[ \t]*(?:\r?\n|$)/m.test(initialText);
    do {
      const initialOutput = await readProcessOutput({
        pid,
        timeout_ms: Math.max(0, readinessDeadline - Date.now()),
        verbose_timing: true
      });
      initialText += '\n' + initialOutput.content.map(part => part.text ?? '').join('\n');
      if (hasPythonPrompt()) break;
    } while (Date.now() < readinessDeadline);
    console.log('Initial Python prompt:', initialText);
    assert(hasPythonPrompt(),
      `Python REPL did not become ready during the initial 2000ms read phase: ${initialText}`);

    // Test interact_with_process with wait_for_prompt
    console.log('Testing interact_with_process with wait_for_prompt...');
    const inputResult = await interactWithProcess({
      pid,
      input: 'print("Hello from Python with wait!")',
      wait_for_prompt: true,
      timeout_ms: 5000,
      verbose_timing: true
    });
    console.log('Python output with wait_for_prompt:', inputResult.content[0].text);

    // Check that the output contains the expected text
    assert(inputResult.content[0].text.includes('Hello from Python with wait!'),
      'Output should contain the printed message');

    // Test interact_with_process without wait_for_prompt
    console.log('Testing interact_with_process without wait_for_prompt...');
    await interactWithProcess({
      pid,
      input: 'print("Hello from Python without wait!")',
      wait_for_prompt: false
    });

    // Wait a moment for Python to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Read the output
    const output = await readProcessOutput({ pid });
    console.log('Python output without wait_for_prompt:', output.content[0].text);

    // Check that the output contains the expected text
    assert(output.content[0].text.includes('Hello from Python without wait!'),
      'Output should contain the printed message');

    // Test multi-line code with wait_for_prompt
    console.log('Testing multi-line code with wait_for_prompt...');
    const multilineCode = `def greet(name):
    return f"Hello, {name}!"

for i in range(3):
    print(greet(f"Guest {i+1}"))`;

    // Send the multi-line code
    const multilineInputResult = await interactWithProcess({
      pid,
      input: multilineCode,
      wait_for_prompt: true,
      timeout_ms: 5000
    });

    // Send an empty line to complete and execute the block
    const multilineResult = await interactWithProcess({
      pid,
      input: '',
      wait_for_prompt: true,
      timeout_ms: 5000
    });
    // Either interaction can return the output it consumes.
    const multilineOutput = [...multilineInputResult.content, ...multilineResult.content]
      .map(part => part.text ?? '').join('\n');
    console.log('Python multi-line output with wait_for_prompt:', multilineOutput);

    // Check that the output contains all three greetings
    assert(multilineOutput.includes('Hello, Guest 1!'),
      'Output should contain greeting for Guest 1');
    assert(multilineOutput.includes('Hello, Guest 2!'),
      'Output should contain greeting for Guest 2');
    assert(multilineOutput.includes('Hello, Guest 3!'),
      'Output should contain greeting for Guest 3');
    return true;
  } finally {
    console.log("Terminating session...");
    await forceTerminate({ pid });
    console.log('Python session terminated');
  }
}

// Run the test
testEnhancedREPL()
  .then(success => {
    console.log(`Enhanced REPL test ${success ? 'PASSED' : 'FAILED'}`);
    exitProcess(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test error:', error);
    exitProcess(1);
  });
