/**
 * kill_process: which PIDs it refuses.
 *
 * - A PID of 0 or below is refused before anything is signaled. It went
 *   straight to process.kill, and the OS reads such a PID as a group: on
 *   Windows 0 is the calling process, so the server itself exited; on
 *   macOS/Linux 0 is the server's process group (the client that started it
 *   too), -N is process group N and -1 every process the user may signal.
 *   node:local sessions have negative PIDs too. The test replaces
 *   process.kill while it runs, so nothing is ever signaled, even on a build
 *   that doesn't refuse.
 */
import assert from 'assert';
import { killProcess } from '../dist/tools/process.js';
import { handleKillProcess } from '../dist/handlers/process-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

// The message of the refusal: the argument check's own, as for any invalid argument
const REFUSAL = 'Number must be greater than 0';

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

export default async function runTests() {
  const tests = [testRefusesPidsBelowOne];
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
