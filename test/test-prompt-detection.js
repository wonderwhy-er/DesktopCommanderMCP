/**
 * #196: while pytest -v collected its tests, its output ended in "collecting ... "
 * and start_process answered "🔄 Process N is waiting for input (detected:
 * "...")". A prompt was found anywhere in the last line of output, and generic
 * prompts such as "... " (Python's continuation prompt), "> " or "       "
 * (Julia's continuation) are ordinary text inside a longer line.
 *
 * Checks the issue's own output (fixtures/pytest-196.js; only the reporter's path
 * replaced with a neutral one) against the detection,
 * then through start_process; and that real prompts are still detected: a REPL's
 * prompt as the whole last line, the prompts a REPL wrote one after another to
 * stderr (">>> ... "), a named prompt ("done>>> ") or a shell prompt
 * ("user@Mac project % ") at its end.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeProcessState } from '../dist/utils/process-detection.js';
import { startProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { PYTEST_COLLECTING, PYTEST_PROGRESS_LINE } from './fixtures/pytest-196.js';
import { runIfMain } from './helpers/run-if-main.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pytest-196.js');

// Output that ends in ordinary text, not a prompt
const NOT_PROMPTS = [
  ['pytest -v while it collects (#196)', PYTEST_COLLECTING],
  ['a pytest progress line before its newline (padding, then "[100%]")', PYTEST_PROGRESS_LINE],
];

// Output that ends in a prompt
const PROMPTS = [
  ['python', 'x = 1\n>>> '],
  ['python continuation', 'def f():\n... '],
  ['python, after output without a newline', 'done>>> '],
  // A REPL that writes its prompts to stderr and doesn't echo input leaves them on one line there
  ['python -i prompts on stderr', '>>> >>> ... '],
  ['a shell\'s prompts on stderr', '$ $ '],
  ['node', '1\n> '],
  ['R continuation', '+ '],
  ['shell', '$ '],
  ['bash default', 'bash-5.2$ '],
  ['bash -i prompts on stderr', 'bash-5.2$ bash-5.2$ '],
  ['bash with user@host', 'user@host:~/project$ '],
  ['root shell', 'root@box:/# '],
  ['zsh default on macOS', 'user@Mac project % '],
  ['mysql', 'mysql> '],
  ['julia', 'julia> '],
  ['psql', 'postgres=# '],
];

const failures = [];
function check(ok, message) {
  if (!ok) {
    failures.push(message);
    console.log(`❌ ${message}`);
  }
}

function testDetection() {
  console.log('\n--- detection: the issue\'s output is not a prompt ---');
  for (const [name, output] of NOT_PROMPTS) {
    const state = analyzeProcessState(output);
    check(!state.isWaitingForInput,
      `${name}: output ending in ${JSON.stringify(output.slice(-40))} was taken for a prompt (detected: ${JSON.stringify(state.detectedPrompt)})`);
  }
  console.log('\n--- detection: real prompts are still detected ---');
  for (const [name, output] of PROMPTS) {
    check(analyzeProcessState(output).isWaitingForInput, `${name}: the prompt ${JSON.stringify(output.split('\n').pop())} was not detected`);
  }
}

async function testStartProcess() {
  console.log('\n--- start_process: pytest collecting (#196) ---');
  const result = await startProcess({ command: `node "${FIXTURE}"`, timeout_ms: 1500 });
  const pid = result.structuredContent?.pid;
  const text = result.content[0].text;
  try {
    check(text.includes('collecting ... '), `the output should have arrived before the wait ended, got: ${text.slice(-200)}`);
    check(!text.includes('waiting for input'),
      `start_process should not report pytest as waiting for input while it collects, got: ${text.slice(-160)}`);
    check(result.structuredContent?.status === 'running', `status should be running, got ${result.structuredContent?.status}`);
    check(text.includes('⏳ Process is running'), `start_process should report the process as running, got: ${text.slice(-160)}`);
  } finally {
    if (pid > 0) await forceTerminate({ pid });
  }
}

async function runTests() {
  testDetection();
  await testStartProcess();
  console.log(failures.length === 0
    ? '\n✅ prompt detection tests passed'
    : `\n❌ ${failures.length} prompt detection checks failed`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
