import assert from 'assert';
import { terminalManager } from '../../dist/terminal-manager.js';
import { interactWithProcess } from '../../dist/tools/improved-process-tools.js';
import { configManager } from '../../dist/config-manager.js';

/**
 * FAILING repro for the "No result received after 4 minutes" crash.
 *
 * Symptom (customer): a `Send Input to Process` / start_process call hangs and
 * Claude Desktop reports "No result received from the Claude Desktop app after
 * waiting 4 minutes. The local MCP server ... may be unresponsive."
 *
 * Verified root cause (src/terminal-manager.ts executeCommand + improved-
 * process-tools.ts interactWithProcess): the blocking wait is bounded ONLY by
 * the caller-supplied timeout_ms. There is no ceiling below the MCP client's
 * hard ~4-minute (240000ms) per-call limit. So a long-running, prompt-less
 * command (e.g. an OpenRouter multi-model sweep) with a large timeout_ms keeps
 * the tool call pending until the client gives up at 4 minutes.
 *
 * These tests encode the DESIRED contract, so they FAIL against current code
 * and should PASS once a fix lands:
 *
 *   The single-call blocking wait of start_process and interact_with_process
 *   MUST be capped at min(timeout_ms, maxProcessWaitMs), where maxProcessWaitMs
 *   is a config value defaulting BELOW the client ceiling (suggested 180000).
 *   When the cap is hit, the tool returns an "is still running, use
 *   read_process_output" handoff (isBlocked=true) instead of continuing to
 *   block for the full timeout_ms.
 *
 * The fast tests below set maxProcessWaitMs to a tiny value so they run in ms.
 * Set DC_REPRO_REALTIME=1 to additionally run a fix-agnostic ~200s proof that
 * uses the real client ceiling.
 */

// The MCP client (Claude Desktop) kills a single tool call at ~4 minutes.
const CLIENT_CEILING_MS = 240000;
// Config key the fix should read to bound the single-call wait.
const CAP_KEY = 'maxProcessWaitMs';

// Fast-test values: tiny cap so a fixed tool returns in ms.
const TEST_CAP_MS = 400;          // stand-in for the production maxProcessWaitMs
const LARGE_TIMEOUT_MS = 4000;    // stand-in for "user/agent set a big timeout"
const CHILD_LIFETIME_MS = 8000;   // child outlives both cap and timeout
const CAP_MARGIN_MS = 1600;       // tolerance above the cap for scheduling/overhead

const since = (t) => Date.now() - t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = (pid) => { try { if (pid > 0) terminalManager.forceTerminate(pid); } catch {} };

let ORIGINAL_CAP;
async function setCap(v) { await configManager.setValue(CAP_KEY, v); }
async function snapshotCap() { ORIGINAL_CAP = await configManager.getValue(CAP_KEY); }
async function restoreCap() { await configManager.setValue(CAP_KEY, ORIGINAL_CAP); }

// A silent, long-running, non-exiting process: matches none of the early-exit
// paths (no prompt, no output, no exit) so only the wait cap can end the call.
const SILENT_CHILD = `node -e "setTimeout(function(){}, ${CHILD_LIFETIME_MS})"`;

/**
 * Test 1 (FAILS now): start_process must cap its initial wait.
 * A silent long process with a large timeout_ms should return at ~the cap,
 * not block for the whole timeout_ms. Current code blocks for timeout_ms.
 */
async function testStartProcessCapsWait() {
  console.log('\n📋 Test 1: start_process caps initial wait below timeout_ms...');
  await setCap(TEST_CAP_MS);
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(SILENT_CHILD, LARGE_TIMEOUT_MS, undefined, true);
  const elapsed = since(t0);
  cleanup(res.pid);

  assert(res.pid > 0, 'should have spawned a process');
  assert.strictEqual(res.isBlocked, true, 'should report still-running (isBlocked=true)');
  assert(
    elapsed <= TEST_CAP_MS + CAP_MARGIN_MS,
    `start_process should return at ~the cap (<=${TEST_CAP_MS + CAP_MARGIN_MS}ms), ` +
    `but blocked for ${elapsed}ms with timeout_ms=${LARGE_TIMEOUT_MS} and cap=${TEST_CAP_MS}. ` +
    `Uncapped, a real ${CLIENT_CEILING_MS}ms+ timeout would blow past the client limit.`
  );
  console.log(`  ✅ returned in ${elapsed}ms (cap=${TEST_CAP_MS}ms)`);
}

const BUSY_MS = 5000; // child stays silent (no prompt/output) longer than LARGE_TIMEOUT_MS
const BUSY_INPUT = `var __end=Date.now()+${BUSY_MS}; while(Date.now()<__end){}`;

/**
 * Test 2 (FAILS now): interact_with_process must cap its wait too.
 * This is the actual crash path ("Send Input to Process"). We start a REPL,
 * then send input that runs a long, silent computation. With wait_for_prompt
 * (default), no prompt appears until it finishes, so the poll loop currently
 * runs the full timeout_ms. It should instead return at ~the cap.
 */
async function testInteractCapsWait() {
  console.log('\n📋 Test 2: interact_with_process caps its wait below timeout_ms...');
  // Start a REPL (returns fast via prompt detection, well under any cap).
  const start = await terminalManager.executeCommand('node -i', 3000, undefined, false);
  const pid = start.pid;
  assert(pid > 0, 'should have started a REPL session');

  await setCap(TEST_CAP_MS);
  const t0 = Date.now();
  await interactWithProcess({ pid, input: BUSY_INPUT, timeout_ms: LARGE_TIMEOUT_MS });
  const elapsed = since(t0);
  cleanup(pid);

  assert(
    elapsed <= TEST_CAP_MS + CAP_MARGIN_MS,
    `interact_with_process should return at ~the cap (<=${TEST_CAP_MS + CAP_MARGIN_MS}ms), ` +
    `but blocked for ${elapsed}ms with timeout_ms=${LARGE_TIMEOUT_MS} and cap=${TEST_CAP_MS}. ` +
    `This is exactly the path that produces the 4-minute "no result" crash.`
  );
  console.log(`  ✅ returned in ${elapsed}ms (cap=${TEST_CAP_MS}ms)`);
}

/**
 * Test 3 (guard, passes now AND after the fix): the cap must not slow the
 * normal fast path. With a generous cap, a prompt-emitting process still
 * returns early via prompt detection, nowhere near the cap or the timeout.
 * This stops a "fix" that just blanket-shortens every wait.
 */
async function testPromptStillReturnsEarly() {
  console.log('\n📋 Test 3 (guard): prompt-emitting process still returns early...');
  await setCap(60000); // generous cap, larger than the timeout below
  const bigTimeout = 5000;
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "process.stdout.write('>>> ');setTimeout(function(){}, ${CHILD_LIFETIME_MS})"`,
    bigTimeout,
    undefined,
    true
  );
  const elapsed = since(t0);
  cleanup(res.pid);

  assert.strictEqual(res.isBlocked, true, 'prompt means waiting for input');
  assert(elapsed < 1000, `should return quickly via prompt, took ${elapsed}ms`);
  assert(
    res.timingInfo.exitReason.startsWith('early_exit'),
    `expected an early_exit reason, got "${res.timingInfo.exitReason}"`
  );
  console.log(`  ✅ returned early in ${elapsed}ms (${res.timingInfo.exitReason})`);
}

/**
 * Test 4 (fix-agnostic, slow, opt-in via DC_REPRO_REALTIME=1): uses the real
 * client ceiling. A silent process with a 5-minute timeout_ms must not keep
 * the call pending past a client-safe ceiling (200s, under the 240s cap).
 * Does not depend on any particular fix knob. ~200s to run.
 */
async function testRealTimeClientCeiling() {
  console.log('\n📋 Test 4 (real-time): single call must stay under the client ceiling...');
  await restoreCap(); // use production default, not the tiny test cap
  const SAFE_CEILING_MS = 200000;
  const HUGE_TIMEOUT_MS = 300000;

  const t0 = Date.now();
  const pending = terminalManager.executeCommand(SILENT_CHILD, HUGE_TIMEOUT_MS, undefined, false);
  await sleep(800);
  const sessions = terminalManager.listActiveSessions();
  const pid = sessions.length ? sessions[sessions.length - 1].pid : -1;
  // Safety net so the test can never hang forever; also resolves `pending`.
  const killer = setTimeout(() => cleanup(pid), SAFE_CEILING_MS);
  await pending;
  clearTimeout(killer);
  const elapsed = since(t0);
  cleanup(pid);

  assert(
    elapsed < SAFE_CEILING_MS,
    `call stayed pending ${elapsed}ms — past the ${SAFE_CEILING_MS}ms safe ceiling ` +
    `(client kills at ${CLIENT_CEILING_MS}ms). timeout_ms was ${HUGE_TIMEOUT_MS}.`
  );
  console.log(`  ✅ returned in ${elapsed}ms (under ${SAFE_CEILING_MS}ms)`);
}

async function runAllTests() {
  console.log('🚀 Starting process-wait client-ceiling repro tests...');
  await snapshotCap();
  let ok = true;
  try {
    await testStartProcessCapsWait();   // FAILS until fix
    await testInteractCapsWait();       // FAILS until fix
    await testPromptStillReturnsEarly();// guard, passes
    if (process.env.DC_REPRO_REALTIME === '1') {
      await testRealTimeClientCeiling(); // FAILS until fix (~200s)
    } else {
      console.log('\n⏭️  Test 4 (real-time, ~200s) skipped. Set DC_REPRO_REALTIME=1 to run it.');
    }
    console.log('\n🎉 All process-wait cap tests passed!');
  } catch (error) {
    ok = false;
    console.error('\n❌ Test failed:', error.message);
  } finally {
    await restoreCap();
  }
  return ok;
}

runAllTests()
  .then((success) => process.exit(success ? 0 : 1))
  .catch((error) => { console.error('Test error:', error); process.exit(1); });
