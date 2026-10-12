/**
 * node:local: an interact_with_process call without a timeout_ms of its own
 * runs the script under the session's timeout, the one start_process was
 * given and list_sessions shows ("PID: -1000 (node:local), Timeout: 20000ms").
 * interact_with_process's default for other processes (8000ms) was applied
 * instead, so every script was ended at 8 s whatever the session's timeout,
 * and a shorter session timeout never applied. A call's own timeout_ms still
 * wins over the session's.
 *
 * Either timeout is held to the wait ceiling every process wait has
 * (MAX_PROCESS_WAIT_MS, #447): the call waits for the script and answers only
 * when it ends, so a script allowed to run past the ceiling kept the call
 * waiting after the client had given up on it.
 */
import assert from 'assert';
import { startProcess, interactWithProcess, forceTerminate, listSessions } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

// Longer than interact_with_process's 8000ms default
const LONG_SESSION_TIMEOUT_MS = 20000;
const LONG_SCRIPT_MS = 9500;
// Shorter than the script it ends
const SHORT_TIMEOUT_MS = 1500;
const SHORT_SCRIPT_MS = 6000;
// A script ended by a 1.5 s timeout answers well before its 6 s are up
const ENDED_WITHIN_MS = 4500;
// A small ceiling stands in for MAX_PROCESS_WAIT_MS so the test doesn't wait a minute
const CAP_MS = 1500;

const script = (ms) => `await new Promise((resolve) => setTimeout(resolve, ${ms})); console.log('done');`;

async function startNodeLocal(timeout_ms) {
  const session = await startProcess({ command: 'node:local', timeout_ms });
  const pid = Number(/PID (-\d+)/.exec(session.content[0].text)?.[1]);
  assert(pid < 0, `node:local should start a virtual session: ${session.content[0].text}`);
  return pid;
}

async function timed(call) {
  const startedAt = Date.now();
  const result = await call;
  return { result, text: result.content[0].text, ms: Date.now() - startedAt };
}

async function testLongSessionTimeout() {
  console.log(`\nTest: a ${LONG_SESSION_TIMEOUT_MS}ms session timeout lets a ${LONG_SCRIPT_MS}ms script finish`);
  const pid = await startNodeLocal(LONG_SESSION_TIMEOUT_MS);
  try {
    const listed = (await listSessions()).content[0].text;
    assert(listed.includes(`PID: ${pid} (node:local), Timeout: ${LONG_SESSION_TIMEOUT_MS}ms`), `list_sessions should show the session's timeout: ${listed}`);
    const { result, text, ms } = await timed(interactWithProcess({ pid, input: script(LONG_SCRIPT_MS) }));
    assert(!result.isError && text.trim() === 'done',
      `The script should run to its end under the session's ${LONG_SESSION_TIMEOUT_MS}ms timeout, got after ${ms}ms: ${JSON.stringify(text)}`);
    console.log(`✓ Finished after ${ms}ms`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testShortSessionTimeout() {
  console.log(`\nTest: a ${SHORT_TIMEOUT_MS}ms session timeout ends a ${SHORT_SCRIPT_MS}ms script`);
  const pid = await startNodeLocal(SHORT_TIMEOUT_MS);
  try {
    const { result, text, ms } = await timed(interactWithProcess({ pid, input: script(SHORT_SCRIPT_MS) }));
    assert(result.isError && text.startsWith('Execution failed'),
      `The session's ${SHORT_TIMEOUT_MS}ms timeout should end the script, got after ${ms}ms: ${JSON.stringify(text)}`);
    assert(ms < ENDED_WITHIN_MS, `The session's ${SHORT_TIMEOUT_MS}ms timeout should end the script, but the call took ${ms}ms`);
    console.log(`✓ Ended after ${ms}ms`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testCallTimeoutWins() {
  console.log(`\nTest: a call's own ${SHORT_TIMEOUT_MS}ms timeout_ms wins over the session's ${LONG_SESSION_TIMEOUT_MS}ms`);
  const pid = await startNodeLocal(LONG_SESSION_TIMEOUT_MS);
  try {
    const { result, text, ms } = await timed(interactWithProcess({ pid, input: script(SHORT_SCRIPT_MS), timeout_ms: SHORT_TIMEOUT_MS }));
    assert(result.isError && text.startsWith('Execution failed') && ms < ENDED_WITHIN_MS,
      `The call's ${SHORT_TIMEOUT_MS}ms timeout should end the script, got after ${ms}ms: ${JSON.stringify(text)}`);
    console.log(`✓ Ended after ${ms}ms`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testWaitCeiling() {
  console.log(`\nTest: the ${CAP_MS}ms wait ceiling ends a script under a ${LONG_SESSION_TIMEOUT_MS}ms timeout`);
  const pid = await startNodeLocal(LONG_SESSION_TIMEOUT_MS);
  try {
    // The session's timeout, then the call's own
    for (const own of [{}, { timeout_ms: LONG_SESSION_TIMEOUT_MS }]) {
      const { result, text, ms } = await timed(interactWithProcess({ pid, input: script(SHORT_SCRIPT_MS), ...own }, CAP_MS));
      assert(result.isError && text.startsWith('Execution failed') && ms < ENDED_WITHIN_MS,
        `The ${CAP_MS}ms wait ceiling should end the script (${own.timeout_ms ? "the call's" : "the session's"} timeout: ${LONG_SESSION_TIMEOUT_MS}ms), got after ${ms}ms: ${JSON.stringify(text)}`);
      console.log(`✓ Ended after ${ms}ms (${own.timeout_ms ? "the call's" : "the session's"} timeout)`);
    }
  } finally {
    await forceTerminate({ pid });
  }
}

export default async function runTests() {
  const tests = [testLongSessionTimeout, testShortSessionTimeout, testCallTimeoutWins, testWaitCeiling];
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
  assert.deepStrictEqual(failures, [], `${failures.length} of ${tests.length} node:local timeout tests failed`);
  console.log('\n✅ node:local timeout tests passed');
}

runIfMain(import.meta.url, runTests);
