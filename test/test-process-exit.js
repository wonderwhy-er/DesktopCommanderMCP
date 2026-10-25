/**
 * How the process tools report a process's output and its end:
 * - output written after the process exits stays readable
 * - read_process_output keeps its read position after the exit, and returns
 *   an unfinished last line again only when that line changed
 * - every exit is reported as finished, and a running process is never
 *   reported finished because of its output text
 * - a wait ends when the process exits
 * - a line ending in ">" is a prompt only at the very end of the output
 * - a process ended by a signal is reported with that signal, not
 *   "exit code null"
 * - a process error while the process runs on (a failed kill) keeps its
 *   session: it stays listed, readable and terminable, and its exit is recorded
 *
 * The tools run in-process, so their structuredContent (kept internal, never
 * sent to a client) is read directly. The processes are the modes of
 * fixtures/process-exit.js.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate, listSessions } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'process-exit.js');
// A wait that should end when the process exits, and the time it may take to
// notice: the process exits ~0.3s into the wait, so ×15 margin either way.
const LONG_WAIT_MS = 15_000;
const EXIT_NOTICED_WITHIN_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (result) => result.content[0].text;
const exited = (pid) => terminalManager.getSession(pid) === undefined;

/** The shell command running the fixture in `mode`, quoted for PowerShell, cmd and POSIX shells */
const fixture = (mode, ...args) => ['node', `"${FIXTURE}"`, mode, ...args.map((arg) => `"${arg}"`)].join(' ');

const triggerDirs = [];
/** A file path a fixture waits for; pull() creates it */
function newTrigger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-process-exit-'));
  triggerDirs.push(dir);
  return path.join(dir, 'go');
}
const pull = (trigger) => fs.writeFileSync(trigger, '');

async function waitUntil(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting until ${what}`);
    await sleep(50);
  }
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

async function start(command, timeoutMs) {
  const result = await startProcess({ command, timeout_ms: timeoutMs });
  const pid = result.structuredContent?.pid;
  check(pid > 0, `start_process should start "${command}", got: ${text(result)}`);
  return { pid, reply: text(result), status: result.structuredContent.status };
}

async function testOutputAfterExitIsReadable() {
  const trigger = newTrigger();
  const { pid } = await start(fixture('late-writer', trigger), 10_000);
  await waitUntil(() => exited(pid), 10_000, 'the process exits');
  pull(trigger);  // only now does the process it left behind write
  let seen = '';
  let last = '';
  for (const deadline = Date.now() + 5_000; !seen.includes('written after the exit') && Date.now() < deadline;) {
    last = text(await readProcessOutput({ pid, timeout_ms: 200 }));
    seen += last;
    await sleep(100);
  }
  check(seen.includes('written after the exit'),
    `output written after the process exited should be readable within 5s, the last read returned: ${JSON.stringify(last)}`);
}

async function testSecondReadMovesForward() {
  const trigger = newTrigger();
  const { pid } = await start(fixture('two-lines', trigger), 1_000);
  const read1 = text(await readProcessOutput({ pid, timeout_ms: 1_000 }));
  check(read1.includes('line one'), `the first read should return "line one", got: ${JSON.stringify(read1)}`);
  pull(trigger);
  await waitUntil(() => exited(pid), 10_000, 'the process exits after printing "line two"');
  const read2 = text(await readProcessOutput({ pid, timeout_ms: 1_000 }));
  check(read2.includes('line two'), `the read after the exit should return "line two", got: ${JSON.stringify(read2)}`);
  check(!read2.includes('line one'),
    `the read after the exit should not repeat "line one", which the first read returned, got: ${JSON.stringify(read2)}`);
}

async function testOpenLineReturnedOnlyWhenChanged() {
  const trigger = newTrigger();
  const { pid } = await start(fixture('open-line', trigger), 1_000);
  try {
    const read1 = text(await readProcessOutput({ pid, timeout_ms: 1_000 }));
    check(read1.includes('ready>'), `the first read should return the unfinished line "ready>", got: ${JSON.stringify(read1)}`);
    const read2StartedAt = Date.now();
    const read2 = text(await readProcessOutput({ pid, timeout_ms: 1_000 }));
    const read2Ms = Date.now() - read2StartedAt;
    check(!read2.includes('ready>'), `an unfinished line that didn't change should not be returned again, got: ${JSON.stringify(read2)}`);
    check(read2Ms >= 500, `with nothing new, the read should wait for output (timeout 1000ms), returned after ${read2Ms}ms`);
    pull(trigger);
    const read3 = text(await readProcessOutput({ pid, timeout_ms: 5_000 }));
    check(read3.includes('ready> more'),
      `text appended to the unfinished line should be returned, got: ${JSON.stringify(read3)}`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testEveryExitIsFinished() {
  for (const command of [`node -e "process.exit(3)"`, `node -e "console.log('hi')"`]) {
    const { pid, reply, status } = await start(command, 10_000);
    check(reply.includes(`Process ${pid} has finished execution`),
      `start_process should report "${command}" as finished once it exited, got: ${reply}`);
    check(status === 'finished', `status should be finished for "${command}", got ${status}`);
    check(!/exit code/i.test(reply), `start_process should not add the exit code (new information), got: ${reply}`);
  }
}

async function testErrorTextIsNotAnExit() {
  const { pid, reply, status } = await start(fixture('error-then-run'), 1_500);
  try {
    check(reply.includes('Error: still working'), `the process should have printed before the wait ended, got: ${reply}`);
    check(!reply.includes('has finished execution'),
      `start_process should not call a running process finished because it printed "Error:", got: ${reply}`);
    check(reply.includes('Process is running'), `start_process should report the process as running, got: ${reply}`);
    check(status === 'running', `status should be running, got ${status}`);
    check(text(await listSessions()).includes(`PID: ${pid},`), 'list_sessions should list the process, which is still running');

    const interaction = await interactWithProcess({ pid, input: 'again', timeout_ms: 1_500 });
    const answer = text(interaction);
    check(answer.includes('Error: retrying again'), `the process should have answered, got: ${answer}`);
    check(!answer.includes('has finished execution'),
      `interact_with_process should not call a running process finished because it printed "Error:", got: ${answer}`);
    check(interaction.structuredContent.status !== 'finished', `status should not be finished, got: ${interaction.structuredContent.status}`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testInteractEndsWhenTheProcessExits() {
  const repl = await start(fixture('quit-on-input'), 10_000);
  check(repl.status === 'waiting_for_input', `the REPL's prompt should be detected, got: ${repl.reply}`);
  const startedAt = Date.now();
  const quit = text(await interactWithProcess({ pid: repl.pid, input: 'quit', timeout_ms: LONG_WAIT_MS }));
  const ms = Date.now() - startedAt;
  check(ms < EXIT_NOTICED_WITHIN_MS, `interact_with_process should return once the process exits, took ${ms}ms (timeout ${LONG_WAIT_MS}ms)`);
  check(!quit.includes('Response may be incomplete'),
    `interact_with_process should not wait out its timeout for a process that exited, got: ${quit}`);
  check(quit.includes('has finished execution'), `interact_with_process should report the exit, got: ${quit}`);
}

async function testReadEndsWhenTheProcessExits() {
  const trigger = newTrigger();
  const { pid } = await start(fixture('exit-on-trigger', trigger), 1_000);
  const read1 = text(await readProcessOutput({ pid, timeout_ms: 1_000 }));
  check(read1.includes('ready'), `the first read should return "ready", got: ${JSON.stringify(read1)}`);
  setTimeout(() => pull(trigger), 300);
  const startedAt = Date.now();
  const read2 = text(await readProcessOutput({ pid, timeout_ms: LONG_WAIT_MS }));
  const ms = Date.now() - startedAt;
  check(ms < EXIT_NOTICED_WITHIN_MS, `read_process_output should return once the process exits, took ${ms}ms (timeout ${LONG_WAIT_MS}ms)`);
  check(read2.includes('Process completed with exit code 0'), `read_process_output should report the exit, got: ${JSON.stringify(read2)}`);
}

async function testLineEndingInGreaterThanIsNotAPrompt() {
  const { pid, reply, status } = await start(fixture('markup'), 10_000);
  check(reply.includes('done'),
    `start_process should not stop waiting at the line "<p>" as if it were a prompt, got: ${reply}`);
  check(status === 'finished', `status should be finished, got ${status}`);
  check(!terminalManager.listActiveSessions().some((session) => session.pid === pid), 'the process should have exited');
}

async function testSignalIsReported() {
  const { pid } = await start(fixture('stays-alive'), 1_000);
  await forceTerminate({ pid });
  await waitUntil(() => exited(pid), 10_000, 'force_terminate ends the process');
  // How it ended, as Node reported it: a signal (child.kill, or any signal on
  // POSIX), or an exit code (on Windows, ending the tree with taskkill /F
  // gives code 1 and no signal). A tail read doesn't move the read position.
  const { exitCode, signal } = terminalManager.readOutputPaginated(pid, -1, 1);
  console.log(`force_terminate ended it with ${signal ? `signal ${signal}` : `exit code ${exitCode}`}`);
  const read = text(await readProcessOutput({ pid, timeout_ms: 1_000 }));
  check(!read.includes('exit code null'), `a killed process should not be reported as "exit code null", got: ${JSON.stringify(read)}`);
  if (signal) {
    check(new RegExp(`✅ Process completed with signal ${signal} \\(runtime: \\d+\\.\\d\\ds\\)`).test(read),
      `a process ended by ${signal} should be reported with that signal, got: ${JSON.stringify(read)}`);
  } else {
    check(new RegExp(`✅ Process completed with exit code ${exitCode} \\(runtime: \\d+\\.\\d\\ds\\)`).test(read),
      `a process that ended with exit code ${exitCode} should be reported with that code, got: ${JSON.stringify(read)}`);
  }
  if (process.platform !== 'win32') {
    check(signal, `on ${process.platform}, force_terminate should end the process with a signal, got exit code ${exitCode}`);
  }

  // (exit code 0: powershell.exe -Command turns a native command's non-zero code into 1)
  const exited0 = await start(`node -e "console.log('hi')"`, 10_000);
  const read0 = text(await readProcessOutput({ pid: exited0.pid, timeout_ms: 1_000 }));
  check(/✅ Process completed with exit code 0 \(runtime: \d+\.\d\ds\)/.test(read0),
    `an exit code should still read as before, got: ${JSON.stringify(read0)}`);
}

async function testProcessErrorKeepsTheSession() {
  const { pid } = await start(fixture('stays-alive'), 1_000);
  // What Node emits when a kill fails or a message can't be sent: the process runs on
  terminalManager.getSession(pid)?.process.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }));

  const listed = text(await listSessions());
  check(listed.includes(`PID: ${pid},`),
    `after a process error, the process that runs on should still be listed by list_sessions, got: ${JSON.stringify(listed)}`);
  const read = text(await readProcessOutput({ pid, timeout_ms: 200 }));
  check(!read.includes('No session found'), `read_process_output should still read it, got: ${JSON.stringify(read)}`);
  const terminated = text(await forceTerminate({ pid }));
  check(terminated.includes('Successfully initiated termination'), `force_terminate should still end it, got: ${JSON.stringify(terminated)}`);
  await waitUntil(() => exited(pid), 10_000, 'force_terminate ends the process');
  const final = text(await readProcessOutput({ pid, timeout_ms: 200 }));
  check(final.includes('Process completed with'), `its exit should be recorded, got: ${JSON.stringify(final)}`);
}

const CASES = [
  ['output written after the exit is readable', testOutputAfterExitIsReadable],
  ['a read after the exit moves forward', testSecondReadMovesForward],
  ['an unfinished line is returned again only when it changed', testOpenLineReturnedOnlyWhenChanged],
  ['every exit is reported as finished', testEveryExitIsFinished],
  ['"Error:" in the output of a running process is not an exit', testErrorTextIsNotAnExit],
  ['interact_with_process returns when the process exits', testInteractEndsWhenTheProcessExits],
  ['read_process_output returns when the process exits', testReadEndsWhenTheProcessExits],
  ['a line ending in ">" is not a prompt', testLineEndingInGreaterThanIsNotAPrompt],
  ['a killed process is reported with its signal', testSignalIsReported],
  ['a process error while the process runs keeps its session', testProcessErrorKeepsTheSession],
];

async function runTests() {
  const failures = [];
  for (const [name, run] of CASES) {
    console.log(`\n--- ${name} ---`);
    try {
      await run();
      console.log('ok');
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${error.message}`);
    }
  }
  for (const dir of triggerDirs) {
    // Best-effort: a trigger dir left in the temp folder is harmless
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures.length === 0
    ? '\n✅ process exit tests passed'
    : `\n❌ ${failures.length} of ${CASES.length} failed: ${failures.join('; ')}`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
