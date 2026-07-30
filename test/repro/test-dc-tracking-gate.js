// DC-level repro: the real per-tool-call gate.
// server.ts CallTool handler awaits usageTracker.trackSuccess(name) before
// returning ANY tool's result. trackSuccess -> saveStats -> configManager
// .setValue -> saveConfig -> fs.writeFile (libuv threadpool).
// If stalled cloud-path reads hold all threadpool threads, this awaited write
// never resolves -> even list_processes (pure memory) never returns.
//
// Run: UV_THREADPOOL_SIZE=4 BLOCKERS=4 node test/test-dc-tracking-gate.js
import { execSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { configManager } from '../../dist/config-manager.js';
import { usageTracker } from '../../dist/utils/usageTracker.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const BLOCKERS = Number(process.env.BLOCKERS || process.env.UV_THREADPOOL_SIZE || 4);
const fifo = path.join(os.tmpdir(), `dc-gate-fifo-${Date.now()}`);
execSync(`mkfifo ${fifo}`);

// Warm the config so init()'s own disk read is already done and cached.
await configManager.getConfig();
log(`config warmed; pool=${process.env.UV_THREADPOOL_SIZE || 4}, blockers=${BLOCKERS}`);

// Simulate DC read_file/edit_block calls stuck on a stalled cloud mount:
// each holds a threadpool thread until the (never-arriving) read returns.
for (let i = 0; i < BLOCKERS; i++) {
  fs.readFile(fifo).catch((e) => log(`fifo read ${i} errored: ${e.code}`));
}

// Now the exact thing the dispatcher awaits for EVERY successful tool call,
// including list_processes:
setTimeout(async () => {
  log(`calling usageTracker.trackSuccess('list_processes') ...`);
  const t = Date.now();
  const guard = setTimeout(() => {
    log(`trackSuccess STILL BLOCKED after 5000ms -> list_processes would hang here. GATE REPRODUCED.`);
    execSync(`rm -f ${fifo}`);
    process.exit(0);
  }, 5000);
  await usageTracker.trackSuccess('list_processes');
  clearTimeout(guard);
  log(`trackSuccess completed in ${Date.now() - t}ms (NOT gated)`);
  execSync(`rm -f ${fifo}`);
  process.exit(0);
}, 200);
