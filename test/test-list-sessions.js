/**
 * Test session management through the MCP tools: list_sessions shows every
 * running process started with start_process, and force_terminate removes
 * exactly the one it is given.
 *
 * "Removes" is checked against the OS, not only against list_sessions:
 * start_process runs the command in a shell, and force_terminate must end the
 * program the command started, and the child that program starts through a
 * shell (as npm starts a dev server), along with the shell. Each of them
 * writes its own PID to a file, so the test can see whether it still runs.
 *
 * Replaces the session-management case of the retired REPL-manager tests.
 */

import assert from 'assert';
import { startProcess, listSessions, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';
import {
  createPidDir, processTreeCommand, readTreePids, readWrittenPids, isRunning, waitForExit, cleanUpProcesses
} from './helpers/process-tree.js';

// Each session runs a program that starts one child of its own
const TREE_LEVELS = 2;

const listedPids = async () => {
  const result = await listSessions();
  return result.structuredContent.sessions.map((session) => session.pid);
};

/**
 * force_terminate `shellPid`, then assert the session is gone from
 * list_sessions and the shell and the processes under it are gone from the OS
 */
async function assertTerminated(shellPid, treePids) {
  const terminated = await forceTerminate({ pid: shellPid });
  assert(!terminated.isError, `force_terminate should succeed: ${terminated.content[0].text}`);
  // force_terminate returns once the shell has exited, so no wait is needed here
  const listedAfter = await listedPids();
  // The OS may take a moment to finish tearing down processes it was told to kill
  const stillRunning = await waitForExit([shellPid, ...treePids]);
  assert.deepStrictEqual(stillRunning, [],
    `force_terminate should end the shell ${shellPid} and the processes it started (${treePids.join(', ')}); still running: ${stillRunning.join(', ')}`);
  assert(!listedAfter.includes(shellPid), `Terminated process ${shellPid} should disappear from list_sessions`);
  assert.strictEqual(terminated.content[0].text, `Successfully initiated termination of session ${shellPid}`);
}

async function testListAndTerminateSessions() {
  console.log('\nTest: list_sessions and force_terminate');

  const dirs = [createPidDir(), createPidDir()];
  const shellPids = [];
  try {
    const first = await startProcess({ command: processTreeCommand(dirs[0], TREE_LEVELS), timeout_ms: 500 });
    const second = await startProcess({ command: processTreeCommand(dirs[1], TREE_LEVELS), timeout_ms: 500 });
    const pid1 = first.structuredContent?.pid;
    const pid2 = second.structuredContent?.pid;
    shellPids.push(pid1, pid2);
    assert(pid1 && pid2 && pid1 !== pid2, `Should start two separate processes, got ${pid1} and ${pid2}`);
    const tree1 = await readTreePids(dirs[0], TREE_LEVELS);
    const tree2 = await readTreePids(dirs[1], TREE_LEVELS);

    const sessions = (await listSessions()).structuredContent.sessions;
    for (const pid of [pid1, pid2]) {
      const session = sessions.find((s) => s.pid === pid);
      assert(session, `list_sessions should show running process ${pid}`);
      assert.strictEqual(session.type, 'process');
      assert(session.runtimeMs >= 0, 'Each session should report its runtime');
    }
    console.log(`✓ list_sessions shows both processes (${pid1}, ${pid2})`);

    await assertTerminated(pid1, tree1);
    assert((await listedPids()).includes(pid2), `The other process ${pid2} should still be listed`);
    const otherSession = [pid2, ...tree2];
    assert.deepStrictEqual(otherSession.filter((pid) => !isRunning(pid)), [],
      `The other session's shell and processes (${otherSession.join(', ')}) should all still run`);
    console.log(`✓ force_terminate ended only ${pid1}: its shell and the processes it started (${tree1.join(' -> ')}) are gone`);

    await assertTerminated(pid2, tree2);
    console.log(`✓ No test sessions left running (shell ${pid2} and ${tree2.join(' -> ')} are gone too)`);
  } finally {
    for (const pid of shellPids.filter(Boolean)) {
      await forceTerminate({ pid });
    }
    cleanUpProcesses([...shellPids.filter(Boolean), ...dirs.flatMap(readWrittenPids)], dirs);
  }
}

export default async function runTests() {
  await testListAndTerminateSessions();
  console.log('\n✅ Session management tests passed!');
}

runIfMain(import.meta.url, runTests);
