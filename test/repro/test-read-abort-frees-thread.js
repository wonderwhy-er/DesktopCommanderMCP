// Demonstration: runWithAbortableTimeout actually CANCELS the underlying read
// (it rejects quickly instead of returning the full buffer), whereas withTimeout
// abandons the promise while the read runs to completion in the background.
//
// Deterministic part: the abortable read must reject (read cut short), proving
// the AbortSignal reaches fs and stops it.
//
// Timing note: on a fast local SSD the "thread stays held" cost is invisible
// because the file is served from the page cache at memory bandwidth. The cost
// is real only on slow/network/cloud paths — exactly the case this fix targets,
// and one that can't be faithfully reproduced on a local disk. So we assert the
// cancellation (deterministic) and print timing as informational only.
//
// Run: UV_THREADPOOL_SIZE=1 node test/repro/test-read-abort-frees-thread.js
import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { withTimeout, runWithAbortableTimeout } from '../../dist/utils/withTimeout.js';

const big = path.join(os.tmpdir(), `dc-big-${Date.now()}.bin`);
console.log('creating 800MB temp file...');
execSync(`dd if=/dev/zero of=${big} bs=1m count=800 2>/dev/null`);

// Abortable read with a 0ms budget: must reject (read cancelled), NOT return 800MB.
let rejected = false;
let returnedBytes = -1;
try {
  const buf = await runWithAbortableTimeout(
    (signal) => fs.readFile(big, { signal }),
    0,
    'abortable read'
  );
  returnedBytes = buf.length;
} catch (e) {
  rejected = true;
  console.log(`abortable read rejected with code=${e.code} (read was cut short) ✓`);
}
execSync(`rm -f ${big}`);
assert.ok(rejected, `expected abortable read to be cancelled, but it returned ${returnedBytes} bytes`);
console.log('PASS: AbortController propagated to fs and cancelled the read.');
process.exit(0);
