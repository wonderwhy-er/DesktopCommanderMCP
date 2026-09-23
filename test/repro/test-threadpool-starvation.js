// Repro: libuv threadpool exhaustion makes a trivial fs op hang.
// Models the real bug: stalled cloud-path fs.reads occupy all UV threads,
// and the per-tool-call config fs.writeFile (usageTracker.saveStats) queues
// behind them -> even a "light" tool (list_processes) can't respond.
//
// Run: UV_THREADPOOL_SIZE=4 node test/repro/run-repro.js test-threadpool-starvation.js
// Exit code: 0 when starvation is demonstrated; 1 if the trivial write was not
// starved, which means the hazard this repro documents no longer holds here.
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { exitProcess } from '../../dist/utils/exit-process.js';
import { createStalledReadTarget } from '../helpers/stalled-read.js';

const POOL = Number(process.env.UV_THREADPOOL_SIZE || 4);
const BLOCKERS = Number(process.env.BLOCKERS || POOL);
const probe = path.join(os.tmpdir(), `dc-probe-${Date.now()}.json`);

function log(m) { console.log(`[${Date.now() - T0}ms] ${m}`); }
const T0 = Date.now();

const stalled = await createStalledReadTarget('dc-fifo');
log(`pool=${POOL}, blockers=${BLOCKERS}, stalled target=${stalled.path}`);

// Occupy BLOCKERS threads with reads that never resolve (nobody writes to the
// target) -- exactly like a cloud read that never returns.
for (let i = 0; i < BLOCKERS; i++) {
  fs.readFile(stalled.path).then(() => log(`stalled read ${i} resolved (unexpected)`))
                          .catch((e) => log(`stalled read ${i} errored: ${e.code}`));
}

// After threads are grabbed, time a trivial write == the per-call config write.
setTimeout(async () => {
  log(`firing trivial write (proxy for list_processes' config save)...`);
  const t = Date.now();
  let blocked = false;
  const guard = setTimeout(() => {
    blocked = true;
    log(`STILL BLOCKED after 5000ms -> STARVATION REPRODUCED. Exiting.`);
    stalled.close();
    exitProcess(0);
  }, 5000);
  try {
    await fs.writeFile(probe, '{}');
    if (blocked) return; // the guard closed the pipe, which is what let the write finish
    clearTimeout(guard);
    log(`trivial write completed in ${Date.now() - t}ms (NOT starved) -> hazard not reproduced`);
    await fs.rm(probe, { force: true });
    stalled.close();
    exitProcess(1);
  } catch (e) {
    if (blocked) return;
    clearTimeout(guard);
    log(`trivial write errored: ${e.message}`);
    stalled.close();
    exitProcess(1);
  }
}, 200);
