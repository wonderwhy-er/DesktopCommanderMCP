/**
 * list_sessions' "Blocked" says whether the session is waiting for input, as
 * its description says: true for a REPL at its prompt, false for a process
 * that is busy and asks for nothing. A process still running when
 * start_process stopped waiting (a sleep, a server, a build) was shown as
 * "Blocked: true" for the rest of its life.
 */
import assert from 'assert';
import { startProcess, listSessions, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

async function listed(pid) {
  const result = await listSessions();
  const session = result.structuredContent.sessions.find((s) => s.pid === pid);
  const line = result.content[0].text.split('\n').find((l) => l.startsWith(`PID: ${pid},`));
  assert(session && line, `list_sessions should show process ${pid}: ${result.content[0].text}`);
  return { isBlocked: session.isBlocked, line };
}

async function testRunningProcessNotBlocked() {
  console.log('\nTest: a running process that asks for nothing is not blocked');
  const started = await startProcess({ command: 'node -e "setTimeout(() => {}, 60000)"', timeout_ms: 500 });
  const pid = started.structuredContent?.pid;
  assert(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    assert.strictEqual(started.structuredContent.status, 'running', started.content[0].text);
    const { isBlocked, line } = await listed(pid);
    assert(isBlocked === false && line.includes('Blocked: false'),
      `a process sleeping without a prompt is not waiting for input, list_sessions says: ${line}`);
    console.log(`✓ ${line}`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testReplAtPromptBlocked() {
  console.log('\nTest: a REPL at its prompt is blocked');
  const started = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  assert(pid > 0, `start_process should start the Node.js REPL, got: ${started.content[0].text}`);
  try {
    assert.strictEqual(started.structuredContent.status, 'waiting_for_input', started.content[0].text);
    const { isBlocked, line } = await listed(pid);
    assert(isBlocked === true && line.includes('Blocked: true'), `a REPL at its prompt is waiting for input, list_sessions says: ${line}`);
    console.log(`✓ ${line}`);
  } finally {
    await forceTerminate({ pid });
  }
}

export default async function runTests() {
  const tests = [testRunningProcessNotBlocked, testReplAtPromptBlocked];
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
  assert.deepStrictEqual(failures, [], `${failures.length} of ${tests.length} list_sessions Blocked tests failed`);
  console.log('\n✅ list_sessions Blocked tests passed');
}

runIfMain(import.meta.url, runTests);
