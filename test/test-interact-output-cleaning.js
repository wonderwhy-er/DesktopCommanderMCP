/**
 * interact_with_process removes the echo of the input and the REPL prompts
 * from the output it returns, and nothing else: an answer that repeats the
 * input is the answer. `10` sent to `node -i` answers "10", which the echo
 * removal took for the echo of the input, so the call said "📭 (No output
 * produced)"; the same for any literal ('abc', true, 3.5) in Node or Python.
 *
 * The echo of processes that do echo the input is still removed:
 * powershell.exe and cmd.exe repeat each input line before its output (the
 * prompts are the shape of the captured ones in fixtures/windows-shell-prompts.js).
 */
import assert from 'assert';
import { cleanProcessOutput } from '../dist/utils/process-detection.js';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

// [what, output since the input was sent, input, what the call returns]
const CASES = [
  ['node -i answering a literal', '10\n> ', '10', '10'],
  ['node -i answering a string literal', "'abc'\n> ", "'abc'", "'abc'"],
  ['python -i answering a literal', '10\n>>> ', '10', '10'],
  ['node -i answering something else', '2\n> ', '1 + 1', '2'],
  ['powershell.exe echoing the input', 'echo hi\nhi\r\nPS C:\\Users\\me\\project> ', 'echo hi', 'hi\r\nPS C:\\Users\\me\\project>'],
  ['powershell.exe echoing an input without output', '$x = 1\nPS C:\\Users\\me\\project> ', '$x = 1', 'PS C:\\Users\\me\\project>'],
  ['cmd.exe echoing the input', 'echo hi\nhi\r\n\r\nC:\\Users\\me\\project>', 'echo hi', 'hi\r\n\r\nC:\\Users\\me\\project>'],
];

const failures = [];
function check(ok, message) {
  if (!ok) {
    failures.push(message);
    console.log(`❌ ${message}`);
  }
}

function testCleaning() {
  console.log('\n--- the output returned for an input ---');
  for (const [what, output, input, expected] of CASES) {
    const cleaned = cleanProcessOutput(output, input);
    check(cleaned === expected, `${what}: ${JSON.stringify(input)} should return ${JSON.stringify(expected)}, got ${JSON.stringify(cleaned)}`);
  }
}

async function testNodeRepl() {
  console.log('\n--- interact_with_process in node -i ---');
  const started = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  assert(pid > 0, `start_process should start the Node.js REPL, got: ${started.content[0].text}`);
  try {
    for (const input of ['10', "'abc'"]) {
      const answer = await interactWithProcess({ pid, input, timeout_ms: 5000 });
      const text = answer.content[0].text;
      check(text.includes(`📤 Output:\n${input}\n`) && !text.includes('No output produced'),
        `interact_with_process ${JSON.stringify(input)} should return the REPL's answer ${JSON.stringify(input)}, got: ${JSON.stringify(text)}`);
    }
  } finally {
    await forceTerminate({ pid });
  }
}

async function runTests() {
  testCleaning();
  await testNodeRepl();
  console.log(failures.length === 0
    ? '\n✅ output cleaning tests passed'
    : `\n❌ ${failures.length} output cleaning checks failed`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
