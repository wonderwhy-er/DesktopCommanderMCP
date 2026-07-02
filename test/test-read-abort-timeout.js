import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { runWithAbortableTimeout } from '../dist/utils/withTimeout.js';
import { computeReadTimeoutMs } from '../dist/tools/filesystem.js';
import { readFile } from '../dist/tools/filesystem.js';

/**
 * Regression tests for the abortable, size-aware read timeout.
 *
 * Follow-up to the parallel-load hang fix: withTimeout() rejected on a timer
 * but left the underlying fs op running, holding its libuv thread until the OS
 * call returned. runWithAbortableTimeout() passes an AbortSignal into the op
 * and aborts it on timeout, and read timeouts are now size-aware instead of a
 * fixed 30s (which conflated "stalled" with "large file on slow media").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

async function run() {
  // 1) A fast operation resolves normally and is NOT aborted.
  {
    let sawSignal;
    const val = await runWithAbortableTimeout(async (signal) => {
      sawSignal = signal;
      return 'done';
    }, 1000, 'fast op');
    assert.strictEqual(val, 'done');
    assert.strictEqual(sawSignal.aborted, false);
    ok('fast operation resolves and signal is not aborted');
  }

  // 2) A slow operation times out with code ETIMEDOUT AND its signal is aborted
  //    (this is the "cleanup" — the op is told to stop, not just abandoned).
  {
    let sawSignal;
    let err;
    try {
      await runWithAbortableTimeout((signal) => {
        sawSignal = signal;
        // Never settles on its own — only the timeout's abort should end the
        // race (mirrors a real fs read, which rejects asynchronously after
        // abort, so the ETIMEDOUT rejection wins).
        return new Promise(() => {});
      }, 100, 'slow op');
      assert.fail('expected timeout rejection');
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err.code, 'ETIMEDOUT', `expected ETIMEDOUT, got ${err.code}`);
    assert.strictEqual(sawSignal.aborted, true, 'operation signal must be aborted on timeout');
    ok('slow operation rejects ETIMEDOUT and aborts the operation signal');
  }

  // 3) Size-aware timeout: floor for small, scales with size, capped at max.
  {
    const floor = computeReadTimeoutMs(0);
    const small = computeReadTimeoutMs(1024);
    const oneGB = computeReadTimeoutMs(1024 * 1024 * 1024);
    const huge = computeReadTimeoutMs(1024 * 1024 * 1024 * 1024); // 1TB

    assert.strictEqual(floor, 30_000, `floor should be 30s, got ${floor}`);
    assert.ok(small <= 30_100, 'tiny file stays at ~floor');
    assert.ok(oneGB > 200_000 && oneGB < 300_000, `1GB should be ~4-5min, got ${oneGB}ms`);
    assert.strictEqual(huge, 10 * 60_000, `huge file must clamp to 10min cap, got ${huge}`);
    assert.ok(oneGB > floor, 'a large file gets more time than a small one');
    ok('size-aware timeout: floor for small, scales for large, clamps at cap');
  }

  // 4) Integration: a normal read still works end-to-end (signal threading did
  //    not break the happy path). Reads this test file itself.
  {
    const self = path.join(__dirname, 'test-read-abort-timeout.js');
    const res = await readFile(self, { offset: 0, length: 5 });
    const text = typeof res.content === 'string' ? res.content : res.content.toString('utf8');
    assert.ok(text.includes('runWithAbortableTimeout'), 'normal read returns file content');
    ok('normal read_file still works with the signal threaded through');
  }
}

run()
  .then(() => { console.log(`\nPASS (${passed}/4)`); process.exit(0); })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
