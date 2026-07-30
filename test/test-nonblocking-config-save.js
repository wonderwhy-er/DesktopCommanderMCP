import assert from 'assert';
import { readFileSync } from 'fs';
import { configManager } from '../dist/config-manager.js';
import { CONFIG_FILE } from '../dist/config.js';

/**
 * Regression test for the parallel-load tool-call hang.
 *
 * Root cause: the CallTool handler awaited usageTracker.trackSuccess() before
 * returning any tool result; that chained through configManager.setValue ->
 * fs.writeFile on EVERY call. Under a saturated libuv threadpool (many parallel
 * reads stalled on a slow/cloud filesystem) the awaited write could not get a
 * thread, so even pure-memory tools (list_processes) hung until the client's
 * ~4-minute cap. Each call also fired an independent write of the same file,
 * risking a corrupted config.json.
 *
 * Fix: stats persist via configManager.setValueNonBlocking() — in-memory update
 * is synchronous, the disk write is coalesced and serialized on a single write
 * chain, and the caller never waits on it.
 *
 * This test is fast and cross-platform (no FIFO/python); the FIFO-based proof
 * that the response no longer blocks under a starved pool lives in test/repro/.
 */

const KEY = '__nonblockingSaveRegressionTest';
let passed = 0;

async function run() {
  await configManager.getConfig(); // warm init so disk read is cached

  // 1) A burst of non-blocking saves must resolve effectively immediately —
  //    they must not each wait on a disk write.
  const BURST = 100;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: BURST }, (_, i) => configManager.setValueNonBlocking(KEY, i))
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200, `burst of ${BURST} non-blocking saves took ${elapsed}ms (expected < 200ms)`);
  passed++; console.log(`✓ ${BURST} non-blocking saves resolved in ${elapsed}ms`);

  // 2) The in-memory value is visible immediately (synchronously updated).
  assert.strictEqual(await configManager.getValue(KEY), BURST - 1);
  passed++; console.log('✓ in-memory value reflects the latest write immediately');

  // 3) After the background flush window, config.json is valid JSON (no torn
  //    write from overlapping saves) and holds the final coalesced value.
  await new Promise((r) => setTimeout(r, 300));
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); },
    'config.json must remain valid JSON after concurrent writes');
  assert.strictEqual(parsed[KEY], BURST - 1, 'final value must be persisted to disk');
  passed++; console.log('✓ config.json is valid and holds the coalesced final value');

  // cleanup: remove the test key (undefined is dropped by JSON.stringify)
  await configManager.setValue(KEY, undefined);
}

run()
  .then(() => { console.log(`\nPASS (${passed}/3)`); process.exit(0); })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
