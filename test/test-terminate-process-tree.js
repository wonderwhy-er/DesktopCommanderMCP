/**
 * Test that terminating a process ends every process it started, checked
 * against the OS: start_process runs the command in a shell, the command's
 * program starts children of its own (like npm starting a dev server), and
 * each of them writes its PID to a file so the test can see whether it still
 * runs after the termination.
 *
 * Covers the kill paths that end a process tree:
 * - force_terminate on a start_process session, for a deeper tree, for
 *   programs that ignore SIGTERM, and for children started while the tree
 *   is being terminated
 * - the node:local timeout, which ends the script and whatever it started
 * - the failure path: when the tree can't be found, the reply says so and
 *   the log says why, and a later force_terminate tries again
 * and pins that making them terminable changed nothing else: on macOS/Linux
 * session processes stay in the server's process group.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import {
  createPidDir, processTreeCommand, readTreePids, readWrittenPids, waitForExit, cleanUpProcesses, processGroupOf
} from './helpers/process-tree.js';

/**
 * start_process a tree of `levels` processes under the shell, force_terminate
 * it, and assert the shell and every level are gone.
 */
async function assertForceTerminateEndsTree(levels, ...flags) {
  const dir = createPidDir();
  let shellPid;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, levels, ...flags), timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the tree: ${started.content[0].text}`);
    const treePids = await readTreePids(dir, levels);

    const terminated = await forceTerminate({ pid: shellPid });
    assert(!terminated.isError, `force_terminate should succeed: ${terminated.content[0].text}`);
    const stillRunning = await waitForExit([shellPid, ...treePids]);
    assert.deepStrictEqual(stillRunning, [],
      `force_terminate should end the shell ${shellPid} and all ${levels} processes under it (${treePids.join(', ')}); still running: ${stillRunning.join(', ')}`);
    assert.strictEqual(terminated.content[0].text, `Successfully initiated termination of session ${shellPid}`);
    return treePids;
  } finally {
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir)], [dir]);
  }
}

async function testForceTerminateEndsDeepTree() {
  console.log('\nTest: force_terminate ends the shell, its child and their descendants');
  const pids = await assertForceTerminateEndsTree(3);
  console.log(`✓ Shell and all 3 levels under it (${pids.join(' -> ')}) are gone`);
}

async function testForceTerminateEndsProcessesIgnoringSigterm() {
  console.log('\nTest: force_terminate ends processes that ignore SIGTERM');
  const pids = await assertForceTerminateEndsTree(2, 'ignore-sigterm');
  console.log(`✓ Processes ignoring SIGTERM (${pids.join(' -> ')}) are gone`);
}

/**
 * The children the tree started on SIGTERM (fixture flag spawn-on-sigterm):
 * `started` as recorded by their parents, `all` adds the PIDs they reported
 * themselves (the program, when the shell starting it did not exec it)
 */
function readLatePids(dir) {
  const read = (pattern) => fs.readdirSync(dir)
    .filter((file) => pattern.test(file))
    .map((file) => Number(fs.readFileSync(path.join(dir, file), 'utf8')));
  const started = read(/^late-\d+\.started\.pid$/);
  return { started, all: [...new Set([...started, ...read(/^late-\d+\.pid$/)])] };
}

/**
 * macOS/Linux: the tree gets SIGTERM and a grace period before SIGKILL. A
 * process that starts a child during that grace (here: every level, on
 * SIGTERM, while ignoring it) must not leave that child running: the tree is
 * walked again before SIGKILL.
 */
async function testForceTerminateEndsChildrenStartedDuringGrace() {
  console.log('\nTest: force_terminate ends children started while the tree was being terminated');
  if (process.platform === 'win32') {
    skip('the SIGTERM grace period is macOS/Linux only; taskkill /F ends the tree at once');
    return;
  }
  const dir = createPidDir();
  let shellPid;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, 2, 'ignore-sigterm', 'spawn-on-sigterm'), timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the tree: ${started.content[0].text}`);
    const treePids = await readTreePids(dir, 2);

    const terminated = await forceTerminate({ pid: shellPid });
    const late = readLatePids(dir);
    const stillRunning = await waitForExit([shellPid, ...treePids, ...late.all]);
    assert.deepStrictEqual(stillRunning, [],
      `force_terminate should end the tree (${treePids.join(', ')}) and the children it started during the grace period (${late.all.join(', ')}); still running: ${stillRunning.join(', ')}`);
    // Otherwise the case above was not exercised
    assert.strictEqual(late.started.length, 2, `Both levels should have started a child on SIGTERM, found: ${late.started.join(', ')}`);
    const latePids = late.all;
    assert.strictEqual(terminated.content[0].text, `Successfully initiated termination of session ${shellPid}`);
    console.log(`✓ Tree (${treePids.join(' -> ')}) and children started during the grace (${latePids.join(', ')}) are gone`);
  } finally {
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir), ...readLatePids(dir).all], [dir]);
  }
}

/**
 * node:local runs each script in a fresh Node process with a timeout. When the
 * timeout ends the script, the processes the script started must end with it:
 * they share its output pipes, so a survivor would also keep the call from
 * ever returning.
 */
async function testNodeLocalTimeoutEndsTree() {
  console.log('\nTest: node:local timeout ends the script and the processes it started');
  const TIMEOUT_MS = 1500;
  const RETURN_LIMIT_MS = TIMEOUT_MS + 8000;
  const session = await startProcess({ command: 'node:local', timeout_ms: 30000 });
  const virtualPid = Number(/PID (-\d+)/.exec(session.content[0].text)?.[1]);
  assert(virtualPid < 0, `node:local should start a virtual session: ${session.content[0].text}`);
  const dir = createPidDir();
  const scriptPidFile = path.join(dir, 'script.pid.txt');

  // The script starts the tree through a shell, like exec('npm run dev')
  const script = `
    import { spawn } from 'child_process';
    import fs from 'fs';
    fs.writeFileSync(${JSON.stringify(scriptPidFile)}, String(process.pid));
    spawn(${JSON.stringify(processTreeCommand(dir, 2))}, { shell: true, stdio: 'inherit', windowsHide: true });
    setInterval(() => {}, 1000);
  `;
  const scriptPid = () => (fs.existsSync(scriptPidFile) ? [Number(fs.readFileSync(scriptPidFile, 'utf8'))] : []);
  try {
    let limit;
    const result = await Promise.race([
      interactWithProcess({ pid: virtualPid, input: script, timeout_ms: TIMEOUT_MS }),
      new Promise((resolve) => { limit = setTimeout(() => resolve(null), RETURN_LIMIT_MS); }),
    ]);
    clearTimeout(limit);
    const treePids = readWrittenPids(dir);
    assert.strictEqual(treePids.length, 2, `The script should have started 2 processes, found PIDs: ${treePids.join(', ')}`);
    const stillRunning = await waitForExit([...scriptPid(), ...treePids]);
    assert.deepStrictEqual(stillRunning, [],
      `The timeout should end the script ${scriptPid()[0]} and the processes it started (${treePids.join(', ')}); still running: ${stillRunning.join(', ')}`);
    assert(result, `interact_with_process should return after its ${TIMEOUT_MS}ms timeout, but had not returned after ${RETURN_LIMIT_MS}ms`);
    assert(result.isError, 'A script ended by the timeout should be reported as an error');
    // The answer a script ended by its timeout always got
    assert(result.content[0].text.startsWith('Execution failed (exit code 1):'),
      `The result should be the old failure answer: ${result.content[0].text}`);
    console.log(`✓ Script ${scriptPid()[0]} and the processes it started (${treePids.join(' -> ')}) are gone`);
  } finally {
    await forceTerminate({ pid: virtualPid });
    cleanUpProcesses([...scriptPid(), ...readWrittenPids(dir)], [dir]);
  }
}

/**
 * When the node:local timeout can't end the script's whole tree, a survivor
 * keeps the script's output pipes open. The call must still answer, with the
 * error force_terminate gives, instead of waiting for pipes that never close.
 */
async function testNodeLocalTimeoutAnswersWhenTreeSurvives() {
  console.log('\nTest: node:local timeout answers when part of the tree survives');
  const TIMEOUT_MS = 1500;
  const RETURN_LIMIT_MS = TIMEOUT_MS + 8000;
  const session = await startProcess({ command: 'node:local', timeout_ms: 30000 });
  const virtualPid = Number(/PID (-\d+)/.exec(session.content[0].text)?.[1]);
  assert(virtualPid < 0, `node:local should start a virtual session: ${session.content[0].text}`);
  const dir = createPidDir();
  const scriptPidFile = path.join(dir, 'script.pid.txt');
  const script = `
    import { spawn } from 'child_process';
    import fs from 'fs';
    fs.writeFileSync(${JSON.stringify(scriptPidFile)}, String(process.pid));
    spawn(${JSON.stringify(processTreeCommand(dir, 2))}, { shell: true, stdio: 'inherit', windowsHide: true });
    setInterval(() => {}, 1000);
  `;
  const scriptPid = () => (fs.existsSync(scriptPidFile) ? [Number(fs.readFileSync(scriptPidFile, 'utf8'))] : []);
  const saved = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const stdoutWrite = process.stdout.write;
  try {
    let limit;
    const call = interactWithProcess({ pid: virtualPid, input: script, timeout_ms: TIMEOUT_MS });
    await readTreePids(dir, 2);
    // Once the tree runs, make the tree-finding tool impossible to start, so the timeout ends only the script
    if (process.platform === 'win32') {
      process.env.SystemRoot = path.join(dir, 'no-windows');
    } else {
      process.env.PATH = path.join(dir, 'no-bin');
    }
    // The failure is logged to stdout (no transport); keep it out of the test output
    process.stdout.write = () => true;
    let result;
    try {
      result = await Promise.race([
        call,
        new Promise((resolve) => { limit = setTimeout(() => resolve(null), RETURN_LIMIT_MS); }),
      ]);
    } finally {
      clearTimeout(limit);
      process.stdout.write = stdoutWrite;
      restoreEnv();
    }
    assert(result, `interact_with_process should answer after its ${TIMEOUT_MS}ms timeout, but had not after ${RETURN_LIMIT_MS}ms`);
    assert(result.isError, 'A tree that survived should be reported as an error');
    assert.strictEqual(result.content[0].text, `Error: Could not terminate every process of session ${virtualPid}; some may still be running`);
    console.log('✓ Answered with the force_terminate error instead of waiting for the survivors');
  } finally {
    process.stdout.write = stdoutWrite;
    restoreEnv();
    await forceTerminate({ pid: virtualPid });
    cleanUpProcesses([...scriptPid(), ...readWrittenPids(dir)], [dir]);
  }
}

/**
 * When the tool that finds the tree can't run (ps on macOS/Linux, taskkill on
 * Windows), force_terminate must not claim success: the reply says processes
 * may still run, the log gets the real reason, and the shell is still killed.
 */
async function testTerminationFailureIsReported() {
  console.log('\nTest: force_terminate reports why it could not end the tree');
  const dir = createPidDir();
  let shellPid;
  const saved = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const stdoutWrite = process.stdout.write;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, 2), timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the tree: ${started.content[0].text}`);
    await readTreePids(dir, 2);

    // Make the tree-finding tool impossible to start, and collect what the server logs (to stdout, without a transport)
    let expectedReason;
    if (process.platform === 'win32') {
      process.env.SystemRoot = path.join(dir, 'no-windows');
      const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
      expectedReason = `${taskkill} /PID ${shellPid} /T /F: spawn ${taskkill} ENOENT`;
    } else {
      process.env.PATH = path.join(dir, 'no-bin');
      expectedReason = 'ps -A -o pid=,ppid=: spawn ps ENOENT';
    }
    const logged = [];
    process.stdout.write = (chunk) => { logged.push(String(chunk)); return true; };
    let terminated;
    try {
      terminated = await forceTerminate({ pid: shellPid });
    } finally {
      process.stdout.write = stdoutWrite;
      restoreEnv();
    }

    assert(terminated.isError, `force_terminate should report the failure: ${terminated.content[0].text}`);
    assert.strictEqual(terminated.content[0].text, `Error: Could not terminate every process of session ${shellPid}; some may still be running`);
    // Each log entry is a JSON-RPC notification carrying the message in params.data
    const messages = logged.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line).params?.data);
    assert.deepStrictEqual(messages, [`Could not end every process of PID ${shellPid}: ${expectedReason}`],
      'The log should give the reason');
    assert.deepStrictEqual(await waitForExit([shellPid]), [], `The shell ${shellPid} itself should still be killed`);
    console.log(`✓ Reported as an error, logged "${expectedReason}", and the shell was killed`);
  } finally {
    process.stdout.write = stdoutWrite;
    restoreEnv();
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir)], [dir]);
  }
}

/**
 * A force_terminate that couldn't end the session's process leaves the session
 * listed, and a later force_terminate must try again instead of answering from
 * the first attempt (it did: the first result was kept for the session).
 */
async function testFailedTerminationIsRetried() {
  console.log('\nTest: a force_terminate that failed is tried again');
  const dir = createPidDir();
  let shellPid;
  const saved = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const stdoutWrite = process.stdout.write;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, 1), timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the tree: ${started.content[0].text}`);
    await readTreePids(dir, 1);

    // The first attempt fails and leaves the shell running: the tree-finding
    // tool can't start, and the shell's own fallback kill does nothing
    const shell = terminalManager.getSession(shellPid).process;
    const kill = shell.kill;
    shell.kill = () => true;
    if (process.platform === 'win32') process.env.SystemRoot = path.join(dir, 'no-windows');
    else process.env.PATH = path.join(dir, 'no-bin');
    // The failure is logged to stdout (no transport); keep it out of the test output
    process.stdout.write = () => true;
    let first;
    try {
      first = await forceTerminate({ pid: shellPid });
    } finally {
      process.stdout.write = stdoutWrite;
      restoreEnv();
      shell.kill = kill;
    }
    assert(first.isError, `The first force_terminate should fail: ${first.content[0].text}`);

    // Everything works again: a second force_terminate must end the tree
    const second = await forceTerminate({ pid: shellPid });
    assert(!second.isError, `A second force_terminate should try again and end the tree, got: ${second.content[0].text}`);
    assert.deepStrictEqual(await waitForExit([shellPid, ...readWrittenPids(dir)]), [], 'The second force_terminate should end the shell and its tree');
    console.log('✓ The second force_terminate tried again and ended the tree');
  } finally {
    process.stdout.write = stdoutWrite;
    restoreEnv();
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir)], [dir]);
  }
}

/**
 * macOS/Linux: session processes run in the server's own process group (and
 * so its session and controlling terminal), as they always have. Ctrl+C in
 * and closing the terminal the server runs in reach them, and sudo/ssh can
 * prompt on that terminal. Moving them to a group of their own (detached /
 * setsid) would make them easier to kill but change all of that.
 */
async function testSessionsStayInServerProcessGroup() {
  console.log('\nTest: session processes stay in the server\'s process group');
  if (process.platform === 'win32') {
    skip('process groups are macOS/Linux only');
    return;
  }
  const dir = createPidDir();
  let shellPid;
  try {
    const started = await startProcess({ command: processTreeCommand(dir, 2), timeout_ms: 500 });
    shellPid = started.structuredContent?.pid;
    assert(shellPid > 0, `start_process should start the tree: ${started.content[0].text}`);
    const pids = [shellPid, ...await readTreePids(dir, 2)];
    const serverGroup = processGroupOf(process.pid);
    const elsewhere = pids.map((pid) => ({ pid, group: processGroupOf(pid) })).filter(({ group }) => group !== serverGroup);
    assert.deepStrictEqual(elsewhere, [],
      `Session processes ${pids.join(', ')} should be in the server's process group ${serverGroup}`);
    console.log(`✓ Shell and processes under it (${pids.join(' -> ')}) are in the server's process group ${serverGroup}`);
  } finally {
    if (shellPid > 0) await forceTerminate({ pid: shellPid });
    cleanUpProcesses([shellPid, ...readWrittenPids(dir)], [dir]);
  }
}

export default async function runTests() {
  const tests = [
    testForceTerminateEndsDeepTree,
    testForceTerminateEndsProcessesIgnoringSigterm,
    testForceTerminateEndsChildrenStartedDuringGrace,
    testNodeLocalTimeoutEndsTree,
    testNodeLocalTimeoutAnswersWhenTreeSurvives,
    testTerminationFailureIsReported,
    testFailedTerminationIsRetried,
    testSessionsStayInServerProcessGroup,
  ];
  // Every case runs even after one fails, so a failure shows which kill paths leak
  const failures = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(test.name);
      console.error(`✗ ${test.name}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], `${failures.length} of ${tests.length} process tree tests failed`);
  console.log('\n✅ Process tree termination tests passed!');
}

runIfMain(import.meta.url, runTests);
