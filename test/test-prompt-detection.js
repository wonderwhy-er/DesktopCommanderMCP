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
 * ("user@Mac project % ") at its end, and the prompts real Windows shells print
 * (fixtures/windows-shell-prompts.js: powershell.exe, pwsh, cmd.exe, captured from
 * real sessions; only the working directory in them was replaced with a neutral
 * one). Then interact_with_process in a real PowerShell session returns at its
 * prompt.
 *
 * Node 24's continuation prompt, "| " (fixtures/node-repl-prompts.js, captured
 * from node -i on Windows and macOS), is a prompt too, the way #196 counts a
 * generic one: in a last line made of prompts ("> | "). A session left at it
 * wasn't detected as waiting, so interact_with_process waited out its timeout.
 * A markdown table's lines ("| a | b |") are not prompts.
 */
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { analyzeProcessState } from '../dist/utils/process-detection.js';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { PYTEST_COLLECTING, PYTEST_PROGRESS_LINE } from './fixtures/pytest-196.js';
import { WINDOWS_SHELL_PROMPTS } from './fixtures/windows-shell-prompts.js';
import { NODE_24_SESSIONS } from './fixtures/node-repl-prompts.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

// node -i's captured output: its session at the continuation prompt after "function f() {", and the lines of the
// markdown table it printed (each as the last line, before its newline)
const NODE_24_CONTINUATION = NODE_24_SESSIONS.map(([os, banner, exchanges]) =>
  [`node -i (${os}) at its continuation prompt`, banner + exchanges[0][1]]);
const TABLE_LINES = NODE_24_SESSIONS[0][2][4][1].split('\n').slice(0, 3);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pytest-196.js');
// PowerShell answers "echo hi" within a second or two; missing its prompt runs to the timeout
const INTERACT_TIMEOUT_MS = 20_000;
const PROMPT_WITHIN_MS = 5_000;

// Output that ends in ordinary text, not a prompt
const NOT_PROMPTS = [
  ['pytest -v while it collects (#196)', PYTEST_COLLECTING],
  ['a pytest progress line before its newline (padding, then "[100%]")', PYTEST_PROGRESS_LINE],
  ...TABLE_LINES.map((line) => [`a markdown table's line before its newline (${line})`, line]),
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
  ...NODE_24_CONTINUATION,
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
  ...WINDOWS_SHELL_PROMPTS,
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

async function testInteractWithPowerShell() {
  console.log('\n--- interact_with_process: a real PowerShell session ---');
  const hasPwsh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { encoding: 'utf8' }).status === 0;
  const command = process.platform === 'win32' ? 'powershell -NoLogo' : (hasPwsh ? 'pwsh -NoLogo' : null);
  if (!command) {
    skip('interact_with_process in a PowerShell session: pwsh is not installed on this machine');
    return;
  }
  const started = await startProcess({ command, timeout_ms: 10_000 });
  const pid = started.structuredContent?.pid;
  try {
    check(started.structuredContent?.status === 'waiting_for_input',
      `start_process should report PowerShell waiting at its prompt, got ${started.structuredContent?.status}: ${started.content[0].text.slice(-160)}`);
    const startedAt = Date.now();
    const answer = await interactWithProcess({ pid, input: 'echo hi', timeout_ms: INTERACT_TIMEOUT_MS });
    const ms = Date.now() - startedAt;
    const text = answer.content[0].text;
    check(ms < PROMPT_WITHIN_MS,
      `interact_with_process should return at PowerShell's prompt, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms): ${text.slice(-160)}`);
    check(answer.structuredContent?.status === 'waiting_for_input', `status should be waiting_for_input, got ${answer.structuredContent?.status}`);
    check(text.includes('hi'), `PowerShell's answer should be returned, got: ${text.slice(-160)}`);
  } finally {
    if (pid > 0) {
      // "exit" ends the PowerShell session; force_terminate then ends whatever is left
      await interactWithProcess({ pid, input: 'exit', wait_for_prompt: false });
      await forceTerminate({ pid });
    }
  }
}

async function testInteractAtNodeContinuation() {
  console.log('\n--- interact_with_process: node -i at its continuation prompt ---');
  const started = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  try {
    // [input, what the answer shows]: a statement typed a line at a time, then its result
    for (const [input, output] of [['function f() {', null], ['  return 1;', null], ['}', 'undefined'], ['f()', '1']]) {
      const startedAt = Date.now();
      const answer = await interactWithProcess({ pid, input, timeout_ms: INTERACT_TIMEOUT_MS });
      const ms = Date.now() - startedAt;
      const text = answer.content[0].text;
      check(ms < PROMPT_WITHIN_MS && answer.structuredContent?.status === 'waiting_for_input',
        `interact_with_process ${JSON.stringify(input)} should return at node's prompt, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms), status ${answer.structuredContent?.status}: ${JSON.stringify(text)}`);
      check(output === null ? text.includes('📭 (No output produced)') : text.includes(`📤 Output:\n${output}\n`),
        `interact_with_process ${JSON.stringify(input)} should answer ${output === null ? 'with no output' : JSON.stringify(output)}, got: ${JSON.stringify(text)}`);
    }
  } finally {
    if (pid > 0) await forceTerminate({ pid });
  }
}

async function runTests() {
  testDetection();
  await testStartProcess();
  await testInteractAtNodeContinuation();
  await testInteractWithPowerShell();
  console.log(failures.length === 0
    ? '\n✅ prompt detection tests passed'
    : `\n❌ ${failures.length} prompt detection checks failed`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
