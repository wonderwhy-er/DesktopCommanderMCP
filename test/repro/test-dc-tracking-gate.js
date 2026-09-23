// DC-level repro: the real per-tool-call gate.
// server.ts CallTool handler awaits usageTracker.trackSuccess(name) before
// returning ANY tool's result. trackSuccess used to await a config save
// (fs.writeFile on the libuv threadpool). If stalled cloud-path reads hold all
// threadpool threads, that awaited write never resolves -> even list_processes
// (pure memory) never returns.
//
// Run: UV_THREADPOOL_SIZE=4 BLOCKERS=4 node test/repro/run-repro.js test-dc-tracking-gate.js
// Exit code: 1 if trackSuccess is still gated behind the starved threadpool.
import fs from 'fs/promises';
import { configManager } from '../../dist/config-manager.js';
import { usageTracker } from '../../dist/utils/usageTracker.js';
import { exitProcess } from '../../dist/utils/exit-process.js';
import { createStalledReadTarget } from '../helpers/stalled-read.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const BLOCKERS = Number(process.env.BLOCKERS || process.env.UV_THREADPOOL_SIZE || 4);
const stalled = await createStalledReadTarget('dc-gate');

// Warm the config so init()'s own disk read is already done and cached.
await configManager.getConfig();
log(`config warmed; pool=${process.env.UV_THREADPOOL_SIZE || 4}, blockers=${BLOCKERS}`);

// Simulate DC read_file/edit_block calls stuck on a stalled cloud mount:
// each holds a threadpool thread until the (never-arriving) read returns.
for (let i = 0; i < BLOCKERS; i++) {
  fs.readFile(stalled.path).catch((e) => log(`stalled read ${i} errored: ${e.code}`));
}

// Now the exact thing the dispatcher awaits for EVERY successful tool call,
// including list_processes:
setTimeout(async () => {
  log(`calling usageTracker.trackSuccess('list_processes') ...`);
  const t = Date.now();
  let blocked = false;
  const guard = setTimeout(() => {
    blocked = true;
    log(`trackSuccess STILL BLOCKED after 5000ms -> list_processes would hang here. GATE REPRODUCED.`);
    stalled.close();
    exitProcess(1);
  }, 5000);
  await usageTracker.trackSuccess('list_processes');
  if (blocked) return; // the guard closed the pipe, which is what let the call finish
  clearTimeout(guard);
  log(`trackSuccess completed in ${Date.now() - t}ms (NOT gated)`);
  stalled.close();
  exitProcess(0);
}, 200);
