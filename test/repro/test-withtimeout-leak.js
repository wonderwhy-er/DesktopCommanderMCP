// Repro: withTimeout() rejects on schedule but does NOT cancel the underlying
// fs op, so the libuv thread stays held. This is why a 30s read "timeout" does
// not free capacity for 30s worth of relief -- the thread is occupied for the
// REAL (cloud) duration, which can be minutes.
//
// Run: UV_THREADPOOL_SIZE=1 node test/test-withtimeout-leak.js
import { execSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { withTimeout } from '../../dist/utils/withTimeout.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const fifo = path.join(os.tmpdir(), `dc-leak-fifo-${Date.now()}`);
execSync(`mkfifo ${fifo}`);
log(`pool=${process.env.UV_THREADPOOL_SIZE || 'default(4)'} (using 1 thread)`);

// One read stuck on the FIFO, wrapped exactly like DC wraps file reads.
const timed = withTimeout(fs.readFile(fifo), 1000, 'Read file operation', null)
  .then((v) => log(`withTimeout resolved: ${v}`))
  .catch((e) => log(`withTimeout REJECTED (as designed): ${String(e).slice(0, 40)}...`));

// After the timeout "fires", try another fs op. If the thread were freed, this
// would run immediately. It does not -- the un-cancelled read still owns it.
await timed;
log(`timeout fired; now trying a fresh fs.writeFile on the single thread...`);
const t = Date.now();
const guard = setTimeout(() => {
  log(`next fs op STILL BLOCKED ${Date.now() - t}ms after timeout -> THREAD LEAKED`);
  log(`(withTimeout freed the JS promise, not the OS thread)`);
  execSync(`rm -f ${fifo}`);
  process.exit(0);
}, 4000);
await fs.writeFile(path.join(os.tmpdir(), 'dc-leak-probe'), 'x');
clearTimeout(guard);
log(`next fs op completed in ${Date.now() - t}ms (thread was freed)`);
execSync(`rm -f ${fifo}`);
process.exit(0);
