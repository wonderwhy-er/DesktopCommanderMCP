/**
 * kill_process: which PIDs it refuses, and that it ends the process it says it
 * terminated.
 *
 * - A PID of 0 or below is refused before anything is signaled. It went
 *   straight to process.kill, and the OS reads such a PID as a group: on
 *   Windows 0 is the calling process, so the server itself exited; on
 *   macOS/Linux 0 is the server's process group (the client that started it
 *   too), -N is process group N and -1 every process the user may signal.
 *   node:local sessions have negative PIDs too. The test replaces
 *   process.kill while it runs, so nothing is ever signaled, even on a build
 *   that doesn't refuse.
 * - A process that ignores SIGTERM (macOS/Linux) is still ended: the tool
 *   says it "will forcefully terminate the specified process", but it sent
 *   SIGTERM only and answered "Successfully terminated" while the process ran
 *   on. On Windows process.kill always terminates outright.
 * - A command that start_process runs is ended with every process it started.
 *   The PID start_process answers with is the shell's, and kill_process ended
 *   only that PID. On Windows, and with sh on Linux, the shell runs the
 *   command's program as its child, so the program kept running. zsh and bash
 *   run a single command in the shell's place, so there the program ended,
 *   but a child the program had started kept running. Checked in each shell
 *   start_process can use on this OS.
 * - When kill_process can't end every process of such a command, it answers
 *   as force_terminate does then, instead of "Successfully terminated".
 */
import assert from 'assert';
import { spawn } from 'child_process';
import { killProcess } from '../dist/tools/process.js';
import { startProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { handleKillProcess } from '../dist/handlers/process-handlers.js';
import { isShellAvailable } from '../dist/utils/shell.js';
import { GIT_BASH } from './helpers/powershell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import {
  createPidDir, processTreeCommand, readTreePids, readWrittenPids, waitForExit, withoutTreeTool, cleanUpProcesses
} from './helpers/process-tree.js';

// The message of the refusal: the argument check's own, as for any invalid argument
const REFUSAL = 'Number must be greater than 0';
// How long a terminated process may take to be reported gone
const EXIT_WITHIN_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testRefusesPidsBelowOne() {
  console.log('\nTest: kill_process refuses PID 0 and negative PIDs');
  // 0; every process of the user; a node:local session's PID; this process's own group
  const pids = [0, -1, -1000, -process.pid];
  const signaled = [];
  const failures = [];
  const realKill = process.kill;
  process.kill = (pid) => {
    signaled.push(pid);
    return true;
  };
  try {
    for (const pid of pids) {
      const result = await killProcess({ pid });
      const text = result.content[0].text;
      if (!result.isError || !text.startsWith('Error: Invalid arguments for kill_process: ') || !text.includes(REFUSAL)) {
        failures.push(`kill_process({pid: ${pid}}) should be refused as an invalid argument, got: ${text}`);
      }
      // The MCP handler checks the arguments first, with the same schema
      const handled = await handleKillProcess({ pid }).then(
        (answer) => `answered: ${answer.content[0].text}`,
        (error) => (error.message.includes(REFUSAL) ? null : `threw: ${error.message}`));
      if (handled) failures.push(`the kill_process handler should refuse {pid: ${pid}}, it ${handled}`);
    }
  } finally {
    process.kill = realKill;
  }
  if (signaled.length > 0) failures.push(`nothing should have been signaled, but process.kill was called for ${signaled.join(', ')}`);
  assert.deepStrictEqual(failures, [], failures.join('\n'));
  console.log(`✓ ${pids.join(', ')} refused, nothing signaled`);
}

async function testEndsProcessIgnoringSigterm() {
  console.log('\nTest: kill_process ends a process that ignores SIGTERM');
  // Prints "ready" once its SIGTERM handler is in place
  const child = spawn(process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });
    const result = await killProcess({ pid: child.pid });
    const gone = await Promise.race([exited, sleep(EXIT_WITHIN_MS).then(() => false)]);
    assert(gone, `kill_process answered "${result.content[0].text}", but process ${child.pid} still runs ${EXIT_WITHIN_MS}ms later`);
    assert.strictEqual(result.content[0].text, `Successfully terminated process ${child.pid}`);
    console.log(`✓ Process ${child.pid} is gone, and the answer is the old one`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

/** The shells start_process can run a command in here. Not detectAvailableShells(): that can give WSL's bash.exe, and adds every shell in /etc/shells */
function shellsOnThisOs() {
  if (process.platform === 'win32') return ['powershell', 'pwsh', 'cmd', GIT_BASH];
  return process.platform === 'darwin' ? ['zsh', 'bash'] : ['sh', 'bash'];
}

/**
 * start_process runs, in `shell`, a command whose program starts a child of its
 * own, and both keep running. kill_process with the PID start_process answered
 * with must end the shell and both processes, and answer as it always has.
 */
async function assertKillEndsTree(shell) {
  const dir = createPidDir();
  let shellPid;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, 2), shell, timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the command: ${started.content[0].text}`);
    const treePids = await readTreePids(dir, 2);

    const killed = await killProcess({ pid: shellPid });
    const stillRunning = await waitForExit([shellPid, ...treePids]);
    assert.deepStrictEqual(stillRunning, [],
      `kill_process answered "${killed.content[0].text}", but of the shell ${shellPid} and the command's processes (${treePids.join(', ')}) these still run: ${stillRunning.join(', ')}`);
    assert.strictEqual(killed.content[0].text, `Successfully terminated process ${shellPid}`);
    console.log(`✓ ${shell}: the shell ${shellPid} and the command's processes (${treePids.join(' -> ')}) are gone, and the answer is the old one`);
  } finally {
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir)], [dir]);
  }
}

async function testEndsCommandStartedByStartProcess() {
  console.log('\nTest: kill_process with the PID start_process gave ends the whole tree, in each shell');
  // Every shell is tried even after one fails
  const failures = [];
  for (const shell of shellsOnThisOs()) {
    if (!isShellAvailable(shell)) {
      skip(`kill_process in ${shell}: the shell is not installed`);
      continue;
    }
    try {
      await assertKillEndsTree(shell);
    } catch (error) {
      failures.push(`${shell}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
}

/**
 * When the tool that finds a tree can't run (taskkill on Windows, ps on
 * macOS/Linux), kill_process can't tell whether every process ended: it must
 * answer as force_terminate does then, and still kill the shell.
 */
async function testKillFailureIsReported() {
  console.log('\nTest: kill_process reports a tree it could not end');
  const dir = createPidDir();
  let shellPid;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, 1), timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the command: ${started.content[0].text}`);
    await readTreePids(dir, 1);

    const killed = await withoutTreeTool(dir, () => killProcess({ pid: shellPid }));
    assert(killed.isError, `kill_process should report the failure: ${killed.content[0].text}`);
    assert.strictEqual(killed.content[0].text, `Error: Could not terminate every process of session ${shellPid}; some may still be running`);
    assert.deepStrictEqual(await waitForExit([shellPid]), [], `The shell ${shellPid} itself should still be killed`);
    console.log('✓ Answered as force_terminate answers, and the shell was killed');
  } finally {
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir)], [dir]);
  }
}

export default async function runTests() {
  const tests = [
    testRefusesPidsBelowOne,
    testEndsProcessIgnoringSigterm,
    testEndsCommandStartedByStartProcess,
    testKillFailureIsReported,
  ];
  // Every case runs even after one fails
  const failures = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(test.name);
      console.error(`✗ ${test.name}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], `${failures.length} of ${tests.length} kill_process tests failed`);
  console.log('\n✅ kill_process tests passed');
}

runIfMain(import.meta.url, runTests);
