// Repro: withTimeout() rejects on schedule but does NOT cancel the underlying
// fs op, so the libuv thread stays held. This is why a 30s read "timeout" does
// not free capacity for 30s worth of relief -- the thread is occupied for the
// REAL (cloud) duration, which can be minutes.
//
// Run: node test/repro/run-repro.js test-withtimeout-leak.js
// Exit code: 0 when the leak is demonstrated; 1 if the thread was freed, which
// means withTimeout's behavior changed and this repro (and its callers' reliance
// on the bootstrap's extra threads) needs revisiting.
// Always one thread, set before any threadpool use: an inherited larger pool
// would leave free threads and hide the leak
process.env.UV_THREADPOOL_SIZE = '1';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { withTimeout } from '../../dist/utils/withTimeout.js';
import { exitProcess } from '../../dist/utils/exit-process.js';
import { createStalledReadTarget } from '../helpers/stalled-read.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const stalled = await createStalledReadTarget('dc-leak');
log(`pool=${process.env.UV_THREADPOOL_SIZE || 'default(4)'} (using 1 thread)`);

// One read stuck on the stalled target, wrapped exactly like DC wraps file reads.
const timed = withTimeout(fs.readFile(stalled.path), 1000, 'Read file operation', null)
  .then((v) => log(`withTimeout resolved: ${v}`))
  .catch((e) => log(`withTimeout REJECTED (as designed): ${String(e).slice(0, 40)}...`));

// After the timeout "fires", try another fs op. If the thread were freed, this
// would run immediately. It does not -- the un-cancelled read still owns it.
await timed;
log(`timeout fired; now trying a fresh fs.writeFile on the single thread...`);
const t = Date.now();
let leaked = false;
const guard = setTimeout(() => {
  leaked = true;
  log(`next fs op STILL BLOCKED ${Date.now() - t}ms after timeout -> THREAD LEAKED`);
  log(`(withTimeout freed the JS promise, not the OS thread)`);
  stalled.close();
  exitProcess(0);
}, 4000);
await fs.writeFile(path.join(os.tmpdir(), 'dc-leak-probe'), 'x');
// Once the guard gave its verdict, the write finished only because it closed the pipe
if (!leaked) {
  clearTimeout(guard);
  log(`next fs op completed in ${Date.now() - t}ms (thread was freed) -> leak NOT reproduced`);
  stalled.close();
  exitProcess(1);
}
