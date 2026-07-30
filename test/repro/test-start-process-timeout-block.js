import assert from 'assert';
import { terminalManager } from '../../dist/terminal-manager.js';

/**
 * Repro / characterization test for issue #310:
 *   "start_process blocks ... causing Claude Desktop crashes"
 *
 * Root cause (src/terminal-manager.ts executeCommand): the call resolves early
 * ONLY via one of:
 *   - a quick prompt pattern (>>> > $ #) on a stdout chunk
 *   - analyzeProcessState() detecting a REPL prompt (guarded by output)
 *   - process exit
 *   - the timeoutMs fallback
 *
 * A long-running process that produces no prompt-like output and does not exit
 * hits none of the early paths, so executeCommand is held for the FULL
 * timeoutMs. With a large timeout_ms this is the multi-minute pending tool call
 * users observe.
 *
 * NOTE: this is an async wait, not a literal event-loop block. The issue's
 * "blocks Electron main thread" framing is inaccurate, but the user-visible
 * symptom (tool call pending for the whole timeout) is real and is what this
 * test reproduces. If a cap-the-initial-wait fix lands, Tests 1 & 2 should be
 * updated to assert the capped duration instead.
 */

const TIMEOUT_MS = 800;        // short, keeps the test fast
const PROC_LIFETIME_MS = 6000; // child lives well past the timeout

const since = (t) => Date.now() - t;
const cleanup = (pid) => { try { terminalManager.forceTerminate(pid); } catch {} };

/**
 * Test 1 (core repro): a SILENT long-running process produces no output, so
 * neither the quick-pattern nor the periodic analyzeProcessState path can fire
 * (the periodic check is guarded by `output.trim()`). The only thing that ends
 * the call is the timeout fallback => the call is held for the full timeoutMs.
 */
async function testSilentProcessWaitsFullTimeout() {
  console.log('\n📋 Test 1: silent long-running process is held for the full timeout...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setTimeout(function(){}, ${PROC_LIFETIME_MS})"`,
    TIMEOUT_MS,
    undefined,
    true // collectTiming -> populates timingInfo.exitReason
  );
  const elapsed = since(t0);
  cleanup(res.pid);

  assert(res.pid > 0, 'should have spawned a process');
  assert.strictEqual(res.isBlocked, true, 'should report isBlocked=true');
  assert.strictEqual(res.output.trim(), '', 'silent process should produce no output');
  assert.strictEqual(res.timingInfo.exitReason, 'timeout',
    `expected exitReason "timeout", got "${res.timingInfo.exitReason}"`);
  assert(elapsed >= TIMEOUT_MS - 75,
    `should wait ~the full timeout (>=${TIMEOUT_MS}ms), only waited ${elapsed}ms`);
  assert(elapsed < PROC_LIFETIME_MS - 500,
    `should return via timeout, not process exit (elapsed ${elapsed}ms)`);
  console.log(`  ✅ held for ${elapsed}ms via timeout (timeout=${TIMEOUT_MS}ms, proc=${PROC_LIFETIME_MS}ms)`);
}

/**
 * Test 2 (reporter's scenario): a CHATTY but prompt-less long-running process
 * (the "Python test script that didn't output prompt-like patterns"). It emits
 * plain progress lines that match no REPL prompt and no completion pattern, so
 * it is also held for the full timeout despite producing output.
 */
async function testChattyNonPromptProcessWaitsFullTimeout() {
  console.log('\n📋 Test 2: chatty (no-prompt) long-running process is held for the full timeout...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setInterval(function(){console.log('progress')},100);setTimeout(function(){},${PROC_LIFETIME_MS})"`,
    TIMEOUT_MS,
    undefined,
    true
  );
  const elapsed = since(t0);
  cleanup(res.pid);

  assert.strictEqual(res.isBlocked, true, 'should report isBlocked=true');
  assert(res.output.includes('progress'), 'should have captured progress output');
  assert.strictEqual(res.timingInfo.exitReason, 'timeout',
    `non-prompt output must not trigger early exit; got "${res.timingInfo.exitReason}"`);
  assert(elapsed >= TIMEOUT_MS - 75,
    `should wait ~the full timeout (>=${TIMEOUT_MS}ms), only waited ${elapsed}ms`);
  assert(elapsed < PROC_LIFETIME_MS - 500,
    `should return via timeout, not process exit (elapsed ${elapsed}ms)`);
  console.log(`  ✅ held for ${elapsed}ms despite output (exitReason=${res.timingInfo.exitReason})`);
}

/**
 * Test 3 (contrast / regression guard): when the process DOES emit a recognized
 * prompt, executeCommand returns promptly via the quick-pattern path, well
 * before the (large) timeout. This proves the bug is specific to prompt-less
 * processes and guards the early-exit path from regressing.
 */
async function testPromptProcessReturnsEarly() {
  console.log('\n📋 Test 3: prompt-emitting process returns early (not at timeout)...');
  const bigTimeout = 5000;
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "process.stdout.write('>>> ');setTimeout(function(){},${PROC_LIFETIME_MS})"`,
    bigTimeout,
    undefined,
    true
  );
  const elapsed = since(t0);
  cleanup(res.pid);

  assert.strictEqual(res.isBlocked, true, 'prompt means blocked/waiting for input');
  assert(elapsed < 1000, `should return quickly via prompt, took ${elapsed}ms`);
  assert(res.timingInfo.exitReason.startsWith('early_exit'),
    `expected an early_exit reason, got "${res.timingInfo.exitReason}"`);
  console.log(`  ✅ returned early after ${elapsed}ms (exitReason=${res.timingInfo.exitReason})`);
}

async function runAllTests() {
  console.log('🚀 Starting #310 start_process timeout-block tests...');
  try {
    await testSilentProcessWaitsFullTimeout();
    await testChattyNonPromptProcessWaitsFullTimeout();
    await testPromptProcessReturnsEarly();
    console.log('\n🎉 All #310 timeout-block tests passed!');
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

runAllTests()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => { console.error('Test error:', error); process.exit(1); });
