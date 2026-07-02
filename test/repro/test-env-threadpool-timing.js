// Does setting process.env.UV_THREADPOOL_SIZE from inside the process (before
// the first threadpool op) actually change the effective pool size? If yes, a
// bootstrap module that sets it as the very first import is a valid fix.
process.env.UV_THREADPOOL_SIZE = '8';   // set BEFORE any fs/threadpool use
import { execSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const fifo = path.join(os.tmpdir(), `dc-envtest-${Date.now()}`);
execSync(`mkfifo ${fifo}`);           // child_process, not threadpool
log(`set UV_THREADPOOL_SIZE=8 in-process; firing 4 FIFO blockers`);

for (let i = 0; i < 4; i++) fs.readFile(fifo).catch(() => {});
setTimeout(async () => {
  const t = Date.now();
  const guard = setTimeout(() => { log(`BLOCKED >3000ms -> env set too late, pool still 4`); execSync(`rm -f ${fifo}`); process.exit(0); }, 3000);
  await fs.writeFile(path.join(os.tmpdir(), 'dc-envtest-probe'), 'x');
  clearTimeout(guard);
  log(`write completed in ${Date.now() - t}ms -> in-process env set WORKS (pool=8)`);
  execSync(`rm -f ${fifo}`); process.exit(0);
}, 150);
