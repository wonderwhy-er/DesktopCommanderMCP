import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { runWithAbortableTimeout } from '../dist/utils/withTimeout.js';
import { READ_OPERATION_TIMEOUT_MS } from '../dist/tools/filesystem.js';
import { readFile } from '../dist/tools/filesystem.js';

/**
 * Regression tests for the abortable, 3-minute read timeout.
 *
 * Follow-up to the parallel-load hang fix: withTimeout() rejected on a timer
 * but left the underlying fs op running, holding its libuv thread until the OS
 * call returned. runWithAbortableTimeout() passes an AbortSignal into the op
 * and aborts it on timeout. The read timeout is a flat 3 minutes, chosen to sit
 * below the MCP client's ~4-minute hard cap so we abort + return a useful error
 * before the client reports an opaque timeout.
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

  // 3) The read timeout is 3 minutes — safely below the client's ~4-min cap.
  {
    assert.strictEqual(READ_OPERATION_TIMEOUT_MS, 3 * 60 * 1000, 'read timeout must be 3 minutes');
    assert.ok(READ_OPERATION_TIMEOUT_MS < 4 * 60 * 1000, 'must stay below the ~4-min client cap');
    ok('read timeout is 3 minutes, below the client hard cap');
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
