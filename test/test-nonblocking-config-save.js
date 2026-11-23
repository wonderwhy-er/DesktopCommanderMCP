import assert from 'assert';
import { readFileSync } from 'fs';
import { configManager } from '../dist/config-manager.js';
import { CONFIG_FILE } from '../dist/config.js';
import { exitProcess } from '../dist/utils/exit-process.js';

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

  // 1) A burst of non-blocking saves must resolve without waiting on a disk
  //    write. Checked by order rather than by a time limit a loaded machine can
  //    miss: with init warm the burst runs on microtasks alone, and no write can
  //    complete before it resolves, so config.json can't hold any of its values
  //    yet. Saves that wait on their writes leave one there.
  const BURST = 100;
  // Values only this run writes, so one an earlier run left can't pass for them
  const FIRST = Date.now();
  const FINAL = FIRST + BURST - 1;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: BURST }, (_, i) => configManager.setValueNonBlocking(KEY, FIRST + i))
  );
  const elapsed = Date.now() - t0;
  const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))[KEY];
  assert.ok(!(onDisk >= FIRST && onDisk <= FINAL),
    `burst of ${BURST} non-blocking saves resolved only once config.json held ${onDisk}: they waited on disk writes`);
  passed++; console.log(`✓ ${BURST} non-blocking saves resolved in ${elapsed}ms, before any disk write`);

  // 2) The in-memory value is visible immediately (synchronously updated).
  assert.strictEqual(await configManager.getValue(KEY), FINAL);
  passed++; console.log('✓ in-memory value reflects the latest write immediately');

  // 3) Once the background write lands, config.json is valid JSON (no torn
  //    write from overlapping saves) and holds the final coalesced value.
  //    Polled, not one fixed wait: the locked write is slower on a loaded machine.
  const deadline = Date.now() + 30_000;
  let parsed;
  do {
    await new Promise((r) => setTimeout(r, 50));
    assert.doesNotThrow(() => { parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); },
      'config.json must remain valid JSON after concurrent writes');
  } while (parsed[KEY] !== FINAL && Date.now() < deadline);
  assert.strictEqual(parsed[KEY], FINAL, 'final value must be persisted to disk');
  passed++; console.log('✓ config.json is valid and holds the coalesced final value');

  // cleanup: remove the test key (undefined is dropped by JSON.stringify)
  await configManager.setValue(KEY, undefined);
}

run()
  .then(() => { console.log(`\nPASS (${passed}/3)`); exitProcess(0); })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); exitProcess(1); });
