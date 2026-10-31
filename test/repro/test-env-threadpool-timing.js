// Does setting process.env.UV_THREADPOOL_SIZE from inside the process (before
// the first threadpool op) actually change the effective pool size? If yes, a
// bootstrap module that sets it as the very first import is a valid fix.
//
// Run: node test/repro/run-repro.js test-env-threadpool-timing.js
// Exit code: 1 if the in-process setting does not take effect (the bootstrap
// approach would not work on this platform).
process.env.UV_THREADPOOL_SIZE = '8';   // set BEFORE any fs/threadpool use
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { exitProcess } from '../../dist/utils/exit-process.js';
import { createStalledReadTarget } from '../helpers/stalled-read.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const stalled = await createStalledReadTarget('dc-envtest');  // no threadpool use
log(`set UV_THREADPOOL_SIZE=8 in-process; firing 4 stalled-read blockers`);

for (let i = 0; i < 4; i++) fs.readFile(stalled.path).catch(() => {});
setTimeout(async () => {
  const t = Date.now();
  let blocked = false;
  const guard = setTimeout(() => { blocked = true; log(`BLOCKED >3000ms -> env set too late, pool still 4`); stalled.close(); exitProcess(1); }, 3000);
  await fs.writeFile(path.join(os.tmpdir(), 'dc-envtest-probe'), 'x');
  if (blocked) return; // the guard closed the pipe, which is what let the write finish
  clearTimeout(guard);
  log(`write completed in ${Date.now() - t}ms -> in-process env set WORKS (pool=8)`);
  stalled.close(); exitProcess(0);
}, 150);
