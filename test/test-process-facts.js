/**
 * The process tools' structuredContent is for Desktop Commander's own code and
 * tests (src/utils/internal-facts.ts drops it before a client sees it). Every
 * successful answer must carry the facts that apply to it, as the other paths
 * do: a node:local session's start, each script it runs, and input sent
 * without waiting for the response. They returned none, so a caller reading
 * structuredContent.pid got undefined.
 */
import assert from 'assert';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

/** Starts a node:local session; returns its start answer and the PID the answer names */
async function startNodeLocal() {
  const started = await startProcess({ command: 'node:local', timeout_ms: 5000 });
  const pid = Number(started.content[0].text.match(/PID (-?\d+)/)?.[1]);
  assert(Number.isInteger(pid), `start_process of node:local should start a session, got: ${started.content[0].text}`);
  return { started, pid };
}

async function testNodeLocalStart() {
  console.log('\nTest 1: a node:local session\'s start');
  const { started, pid } = await startNodeLocal();
  try {
    assert.deepStrictEqual(started.structuredContent, { pid, status: 'waiting_for_input' },
      `start_process of node:local should give its PID (${pid}) and that it waits for code`);
    console.log('✓ Test 1 passed');
  } finally {
    await forceTerminate({ pid });
  }
}

async function testNodeLocalScript() {
  console.log('\nTest 2: a script a node:local session runs');
  const { pid } = await startNodeLocal();
  try {
    const ran = await interactWithProcess({ pid, input: 'console.log("one"); console.log("two");' });
    assert(!ran.isError, `the script should run, got: ${ran.content[0].text}`);
    assert.deepStrictEqual(ran.structuredContent, { pid, status: 'waiting_for_input', truncated: false, shownLines: 2, totalLines: 2 },
      'a node:local script should give the session\'s PID, that it waits for the next script, and its output lines');
    console.log('✓ Test 2 passed');
  } finally {
    await forceTerminate({ pid });
  }
}

async function testInputWithoutWaiting() {
  console.log('\nTest 3: input sent without waiting for the response');
  const started = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  assert(pid > 0, `start_process should give the PID, got: ${started.content[0].text}`);
  try {
    const sent = await interactWithProcess({ pid, input: '1 + 1', wait_for_prompt: false });
    assert(!sent.isError, `the input should be sent, got: ${sent.content[0].text}`);
    assert.deepStrictEqual(sent.structuredContent, { pid, status: 'running', truncated: false, shownLines: 0, totalLines: 0 },
      'input sent without waiting should give the PID, that the process runs, and that no output was read');
    console.log('✓ Test 3 passed');
  } finally {
    await forceTerminate({ pid });
  }
}

export default async function runTests() {
  let failed = 0;
  for (const test of [testNodeLocalStart, testNodeLocalScript, testInputWithoutWaiting]) {
    try {
      await test();
    } catch (error) {
      failed++;
      console.error('❌ Test failed:', error.message);
    }
  }
  return failed === 0;
}

runIfMain(import.meta.url, runTests);
