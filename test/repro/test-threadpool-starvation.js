// Repro: libuv threadpool exhaustion makes a trivial fs op hang.
// Models the real bug: stalled cloud-path fs.reads occupy all UV threads,
// and the per-tool-call config fs.writeFile (usageTracker.saveStats) queues
// behind them -> even a "light" tool (list_processes) can't respond.
//
// Run: UV_THREADPOOL_SIZE=4 node test/test-threadpool-starvation.js
import { execSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const POOL = Number(process.env.UV_THREADPOOL_SIZE || 4);
const BLOCKERS = Number(process.env.BLOCKERS || POOL);
const fifo = path.join(os.tmpdir(), `dc-fifo-${Date.now()}`);
const probe = path.join(os.tmpdir(), `dc-probe-${Date.now()}.json`);

function log(m) { console.log(`[${Date.now() - T0}ms] ${m}`); }
const T0 = Date.now();

try { execSync(`mkfifo ${fifo}`); } catch (e) { console.error('mkfifo failed', e.message); process.exit(1); }
log(`pool=${POOL}, blockers=${BLOCKERS}, fifo=${fifo}`);

// Occupy BLOCKERS threads with reads that never resolve (nobody writes to the
// FIFO) -- exactly like a cloud read that never returns.
for (let i = 0; i < BLOCKERS; i++) {
  fs.readFile(fifo).then(() => log(`fifo read ${i} resolved (unexpected)`))
                   .catch((e) => log(`fifo read ${i} errored: ${e.code}`));
}

// After threads are grabbed, time a trivial write == the per-call config write.
setTimeout(async () => {
  log(`firing trivial write (proxy for list_processes' config save)...`);
  const t = Date.now();
  const guard = setTimeout(() => {
    log(`STILL BLOCKED after 5000ms -> STARVATION REPRODUCED. Exiting.`);
    try { execSync(`rm -f ${fifo} ${probe}`); } catch {}
    process.exit(0);
  }, 5000);
  try {
    await fs.writeFile(probe, '{}');
    clearTimeout(guard);
    log(`trivial write completed in ${Date.now() - t}ms (NOT starved)`);
    execSync(`rm -f ${fifo} ${probe}`);
    process.exit(0);
  } catch (e) {
    clearTimeout(guard);
    log(`trivial write errored: ${e.message}`);
    process.exit(1);
  }
}, 200);
