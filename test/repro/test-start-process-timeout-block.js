import assert from 'assert';
import { runIfMain } from '../helpers/run-if-main.js';
import { readUntil } from '../helpers/process-output.js';
import { terminalManager } from '../../dist/terminal-manager.js';
import { MAX_PROCESS_WAIT_MS } from '../../dist/config.js';

/**
 * Repro / regression test for issue #310:
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
 * hits none of the early paths, so executeCommand used to be held for the FULL
 * timeoutMs. With a large timeout_ms this was the multi-minute pending tool
 * call users observed.
 *
 * NOTE: this is an async wait, not a literal event-loop block. The issue's
 * "blocks Electron main thread" framing is inaccurate, but the user-visible
 * symptom (tool call pending for the whole timeout) was real.
 *
 * Fix: the initial wait is capped at min(timeout_ms, MAX_PROCESS_WAIT_MS). Tests
 * 1 & 2 pass a small ceiling (executeCommand's internal maxWaitMs parameter)
 * below a large timeout_ms and assert the call returns at the cap, reporting
 * the process as still running.
 */

const CAP_MS = 800;            // wait ceiling under test, short to keep the test fast
const TIMEOUT_MS = 5000;       // caller's timeout_ms, well above the cap
const CAP_MARGIN_MS = 1600;    // tolerance above the cap for scheduling/overhead
const PROC_LIFETIME_MS = 6000; // child lives well past the cap
const OUTPUT_WAIT_MS = 30000;  // how long a command may take to print its first output: readUntil's limit and Test 3's timeout

const since = (t) => Date.now() - t;
const cleanup = (pid) => { try { terminalManager.forceTerminate(pid); } catch {} };

/**
 * Test 1 (core repro): a SILENT long-running process produces no output, so
 * neither the quick-pattern nor the periodic analyzeProcessState path can fire
 * (the periodic check is guarded by `output.trim()`). The only thing that ends
 * the call is the wait fallback => the call is held until the cap, not the
 * full timeoutMs.
 */
async function testSilentProcessWaitsUntilCap() {
  console.log('\n📋 Test 1: silent long-running process is held only until the wait cap...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setTimeout(function(){}, ${PROC_LIFETIME_MS})"`,
    TIMEOUT_MS,
    undefined,
    true, // collectTiming -> populates timingInfo.exitReason
    CAP_MS
  );
  const elapsed = since(t0);
  cleanup(res.pid);

  assert(res.pid > 0, 'should have spawned a process');
  assert.strictEqual(res.isBlocked, true, 'should report isBlocked=true (still running)');
  assert.strictEqual(res.output.trim(), '', 'silent process should produce no output');
  assert.strictEqual(res.timingInfo.exitReason, 'timeout',
    `expected exitReason "timeout", got "${res.timingInfo.exitReason}"`);
  assert.strictEqual(res.waitCappedAtMs, CAP_MS, 'should report that the wait cap ended the wait');
  assert(elapsed >= CAP_MS - 75,
    `should wait ~the cap (>=${CAP_MS}ms), only waited ${elapsed}ms`);
  assert(elapsed <= CAP_MS + CAP_MARGIN_MS,
    `should return at ~the cap (<=${CAP_MS + CAP_MARGIN_MS}ms), not the ${TIMEOUT_MS}ms timeout; waited ${elapsed}ms`);
  console.log(`  ✅ held for ${elapsed}ms via the cap (cap=${CAP_MS}ms, timeout=${TIMEOUT_MS}ms, proc=${PROC_LIFETIME_MS}ms)`);
}

/**
 * Test 2 (reporter's scenario): a CHATTY but prompt-less long-running process
 * (the "Python test script that didn't output prompt-like patterns"). It emits
 * plain progress lines that match no REPL prompt and no completion pattern, so
 * nothing ends the wait early despite the output; it is held until the cap.
 * The progress lines are then read while the process keeps running. On Windows
 * they usually arrive only after the call returned (see readUntil); on macOS
 * and Linux they arrive during the wait, and the exitReason check shows they
 * didn't end it early.
 */
async function testChattyNonPromptProcessWaitsUntilCap() {
  console.log('\n📋 Test 2: chatty (no-prompt) long-running process is held only until the wait cap...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setInterval(function(){console.log('progress')},100);setTimeout(function(){},${PROC_LIFETIME_MS})"`,
    TIMEOUT_MS,
    undefined,
    true,
    CAP_MS
  );
  const elapsed = since(t0);
  await readUntil(res.pid, (text) => text.includes('progress'), OUTPUT_WAIT_MS, 'the progress output arrives');
  const running = terminalManager.getSession(res.pid) !== undefined;
  cleanup(res.pid);

  assert.strictEqual(res.isBlocked, true, 'should report isBlocked=true (still running)');
  assert(running, 'the process should still be running when its progress output is read');
  assert.strictEqual(res.timingInfo.exitReason, 'timeout',
    `non-prompt output must not trigger early exit; got "${res.timingInfo.exitReason}"`);
  assert.strictEqual(res.waitCappedAtMs, CAP_MS, 'should report that the wait cap ended the wait');
  assert(elapsed >= CAP_MS - 75,
    `should wait ~the cap (>=${CAP_MS}ms), only waited ${elapsed}ms`);
  assert(elapsed <= CAP_MS + CAP_MARGIN_MS,
    `should return at ~the cap (<=${CAP_MS + CAP_MARGIN_MS}ms), not the ${TIMEOUT_MS}ms timeout; waited ${elapsed}ms`);
  console.log(`  ✅ held for ${elapsed}ms (exitReason=${res.timingInfo.exitReason}, cap=${CAP_MS}ms)`);
}

/**
 * Test 3 (contrast / regression guard): when the process DOES emit a recognized
 * prompt, executeCommand returns promptly via the quick-pattern path, well
 * before the (large) timeout. This proves the bug is specific to prompt-less
 * processes and guards the early-exit path from regressing. The exitReason
 * shows that the prompt ended the wait, not the timeout. The time isn't
 * checked: the shell alone can take seconds to start on a busy PC.
 */
async function testPromptProcessReturnsEarly() {
  console.log('\n📋 Test 3: prompt-emitting process returns early (not at timeout)...');
  assert(OUTPUT_WAIT_MS < MAX_PROCESS_WAIT_MS, 'the real ceiling must be larger than this timeout');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "process.stdout.write('>>> ');setTimeout(function(){},${PROC_LIFETIME_MS})"`,
    OUTPUT_WAIT_MS,
    undefined,
    true
  );
  const elapsed = since(t0);
  cleanup(res.pid);

  assert.strictEqual(res.isBlocked, true, 'prompt means blocked/waiting for input');
  assert(res.timingInfo.exitReason.startsWith('early_exit'),
    `expected an early_exit reason, got "${res.timingInfo.exitReason}"`);
  console.log(`  ✅ returned early after ${elapsed}ms (exitReason=${res.timingInfo.exitReason})`);
}

async function runAllTests() {
  console.log('🚀 Starting #310 start_process timeout-block tests...');
  try {
    await testSilentProcessWaitsUntilCap();
    await testChattyNonPromptProcessWaitsUntilCap();
    await testPromptProcessReturnsEarly();
    console.log('\n🎉 All #310 timeout-block tests passed!');
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

runIfMain(import.meta.url, runAllTests);
