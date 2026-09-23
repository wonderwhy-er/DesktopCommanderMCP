// Verify the SHIPPED bootstrap (dist/bootstrap.js) raises the pool before any
// fs work, so 4 concurrently-stalled reads no longer starve a 5th fs op.
// No UV_THREADPOOL_SIZE override here -> relies entirely on bootstrap's default.
//
// Run: node test/repro/run-repro.js test-bootstrap-threadpool.js
// Exit code: 1 if the 5th fs op is starved (the bootstrap fix does not work).
import '../../dist/bootstrap.js';           // first import, exactly like index.ts
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createStalledReadTarget } from '../helpers/stalled-read.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const stalled = await createStalledReadTarget('dc-boot');
log(`UV_THREADPOOL_SIZE after bootstrap = ${process.env.UV_THREADPOOL_SIZE}`);

for (let i = 0; i < 4; i++) fs.readFile(stalled.path).catch(() => {});
setTimeout(async () => {
  const t = Date.now();
  const guard = setTimeout(() => { log(`BLOCKED >3000ms -> bootstrap did NOT help`); stalled.close(); process.exit(1); }, 3000);
  await fs.writeFile(path.join(os.tmpdir(), 'dc-boot-probe'), 'x');
  clearTimeout(guard);
  log(`trivial write completed in ${Date.now() - t}ms -> bootstrap headroom WORKS`);
  stalled.close(); process.exit(0);
}, 150);
