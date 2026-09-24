/**
 * interact_with_process removes the echo of the input and the REPL prompts
 * from the output it returns, and nothing else: an answer that repeats the
 * input is the answer. `10` sent to `node -i` answers "10", which the echo
 * removal took for the echo of the input, so the call said "📭 (No output
 * produced)"; the same for any literal ('abc', true, 3.5) in Node or Python.
 *
 * Only the echo of the input actually sent is removed, where the echo is: a
 * process that echoes repeats every input line at the start of that line's
 * output, the first at the start of the output, each later one after the
 * prompt it was read at. Any output line equal to an input line was removed
 * anywhere, so `1` and `2` sent to node -i answered only "2".
 *
 * powershell.exe and cmd.exe do echo the input, and their echo is still
 * removed, each line of it: the outputs below are the captured sessions of
 * fixtures/windows-shell-prompts.js, and the two-line ones are built from the
 * same captured prompts the way the shells print them.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import { cleanProcessOutput } from '../dist/utils/process-detection.js';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { WINDOWS_SHELL_PROMPTS } from './fixtures/windows-shell-prompts.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const captured = (what) => WINDOWS_SHELL_PROMPTS.find(([name]) => name === what)[1];
// The output since "echo hi" was sent at the prompt: from the echo on
const afterEchoHi = (what) => captured(what).slice(captured(what).indexOf('echo hi'));
const PS_PROMPT = captured('powershell.exe -NoLogo, at start');
const CMD_PROMPT = captured('cmd.exe, at start').split('\n').pop();

// [what, output since the input was sent, input, what the call returns]
const CASES = [
  ['node -i answering a literal', '10\n> ', '10', '10'],
  ['node -i answering a string literal', "'abc'\n> ", "'abc'", "'abc'"],
  ['python -i answering a literal', '10\n>>> ', '10', '10'],
  ['node -i answering something else', '2\n> ', '1 + 1', '2'],
  ['node -i answering two literals', '1\n> 2\n> ', '1\n2', '1\n2'],
  ['node -i answering three literals', '1\n> 2\n> 3\n> ', '1\n2\n3', '1\n2\n3'],
  ['node -i answering a literal, then something else', '1\n> 5\n> ', '1\nx = 5', '1\n5'],
  ['powershell.exe echoing the input', afterEchoHi('powershell.exe, after a command\'s output'), 'echo hi', `hi\r\n${PS_PROMPT.trimEnd()}`],
  ['pwsh echoing the input', afterEchoHi('pwsh, after a command\'s output'), 'echo hi', `hi\r\n${PS_PROMPT.trimEnd()}`],
  ['powershell.exe echoing an input without output', `$x = 1\n${PS_PROMPT}`, '$x = 1', PS_PROMPT.trimEnd()],
  ['cmd.exe echoing the input', afterEchoHi('cmd.exe, after a command\'s output'), 'echo hi', `hi\r\n\r\n${CMD_PROMPT}`],
  ['powershell.exe echoing two lines', `echo a\na\r\n${PS_PROMPT}echo b\nb\r\n${PS_PROMPT}`, 'echo a\necho b', `a\r\nb\r\n${PS_PROMPT.trimEnd()}`],
  ['powershell.exe echoing two lines, the first without output', `$x = 1\n${PS_PROMPT}$x\n1\r\n${PS_PROMPT}`, '$x = 1\n$x', `1\r\n${PS_PROMPT.trimEnd()}`],
  ['cmd.exe echoing two lines', `echo a\na\r\n\r\n${CMD_PROMPT}echo b\nb\r\n\r\n${CMD_PROMPT}`, 'echo a\necho b', `a\r\n\r\nb\r\n\r\n${CMD_PROMPT}`],
  // The call answers at the first prompt, before the shell has read (and echoed) the second line
  ['powershell.exe at the prompt after the first of two lines', `echo a\na\r\n${PS_PROMPT}`, 'echo a\necho b', `a\r\n${PS_PROMPT.trimEnd()}`],
  ['cmd.exe at the prompt after the first of two lines', `echo a\na\r\n\r\n${CMD_PROMPT}`, 'echo a\necho b', `a\r\n\r\n${CMD_PROMPT}`],
  ['node -i at the prompt after the first of two lines', '1\n> ', '1\nx = 5', '1'],
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
    // The answer to the first line always; the call may answer at the prompt before the second
    for (const [input, answer, rest] of [['10', '10', ''], ["'abc'", "'abc'", ''], ['1\n2', '1', '\n2']]) {
      const result = await interactWithProcess({ pid, input, timeout_ms: 5000 });
      const text = result.content[0].text;
      check((text.includes(`📤 Output:\n${answer}\n\n`) || (rest && text.includes(`📤 Output:\n${answer}${rest}\n\n`))) && !text.includes('No output produced'),
        `interact_with_process ${JSON.stringify(input)} should return the REPL's answer ${JSON.stringify(answer + rest)}, got: ${JSON.stringify(text)}`);
    }
  } finally {
    await forceTerminate({ pid });
  }
}

async function testPowerShell() {
  console.log('\n--- interact_with_process in a real PowerShell session: two lines ---');
  const hasPwsh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { encoding: 'utf8' }).status === 0;
  const command = process.platform === 'win32' ? 'powershell -NoLogo' : (hasPwsh ? 'pwsh -NoLogo' : null);
  if (!command) {
    skip('interact_with_process in a PowerShell session: pwsh is not installed on this machine');
    return;
  }
  const started = await startProcess({ command, timeout_ms: 10_000 });
  const pid = started.structuredContent?.pid;
  try {
    // It may answer at the prompt after the first line, before the second is read
    const result = await interactWithProcess({ pid, input: 'echo a\necho b', timeout_ms: 20_000 });
    const text = result.content[0].text;
    check(/📤 Output:\na\r?\n(b\r?\n)?PS /.test(text) && !text.includes('echo '),
      `interact_with_process "echo a\\necho b" should return a (and b) without the echoed commands, got: ${JSON.stringify(text)}`);
  } finally {
    if (pid > 0) {
      // "exit" ends the PowerShell session; force_terminate then ends whatever is left
      await interactWithProcess({ pid, input: 'exit', wait_for_prompt: false });
      await forceTerminate({ pid });
    }
  }
}

async function runTests() {
  testCleaning();
  await testNodeRepl();
  await testPowerShell();
  console.log(failures.length === 0
    ? '\n✅ output cleaning tests passed'
    : `\n❌ ${failures.length} output cleaning checks failed`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
