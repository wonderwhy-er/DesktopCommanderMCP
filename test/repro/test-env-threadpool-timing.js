// Does setting process.env.UV_THREADPOOL_SIZE from inside the process (before
// the first threadpool op) change the pool's size? src/bootstrap.ts sets it
// there wherever processEnvReachesThreadpool() (src/utils/threadpool-size.ts)
// says libuv sees it. Elsewhere, on Windows with a libuv before 1.52 (Node 22),
// libuv reads the variable only from the environment the process started with,
// so the bootstrap starts the server again with it. This checks that answer
// against libuv itself: an in-process 8 must give 8 threads where the answer is
// yes, and leave libuv's default 4 where it is no.
//
// Run: node test/repro/run-repro.js test-env-threadpool-timing.js
// (without UV_THREADPOOL_SIZE set: on Windows with Node 22 that value would count)
// Exit code: 1 if the in-process setting doesn't behave as processEnvReachesThreadpool() says.
const setAtStart = process.env.UV_THREADPOOL_SIZE;
process.env.UV_THREADPOOL_SIZE = '8';   // set BEFORE any fs/threadpool use
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { exitProcess } from '../../dist/utils/exit-process.js';
import { processEnvReachesThreadpool } from '../../dist/utils/threadpool-size.js';
import { createStalledReadTarget } from '../helpers/stalled-read.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
if (setAtStart) {
  log(`UV_THREADPOOL_SIZE=${setAtStart} was set when Node started, and on Windows with Node 22 that value counts: run this without it`);
  exitProcess(1);
} else {
  const reaches = processEnvReachesThreadpool();
  log(`libuv ${process.versions.uv} on ${process.platform}: processEnvReachesThreadpool() = ${reaches}`);
  const stalled = await createStalledReadTarget('dc-envtest');  // no threadpool use
  log(`set UV_THREADPOOL_SIZE=8 in-process; firing 4 stalled-read blockers`);

  for (let i = 0; i < 4; i++) fs.readFile(stalled.path).catch(() => {});
  setTimeout(async () => {
    const t = Date.now();
    let blocked = false;
    const guard = setTimeout(() => {
      blocked = true;
      log(reaches ? `BLOCKED >3000ms -> env set too late, pool still 4` : `BLOCKED >3000ms -> as expected, libuv kept its default 4 (the bootstrap starts the server again with the variable)`);
      stalled.close();
      exitProcess(reaches ? 1 : 0);
    }, 3000);
    await fs.writeFile(path.join(os.tmpdir(), 'dc-envtest-probe'), 'x');
    if (blocked) return; // the guard closed the pipe, which is what let the write finish
    clearTimeout(guard);
    log(reaches ? `write completed in ${Date.now() - t}ms -> in-process env set WORKS (pool=8)` : `write completed in ${Date.now() - t}ms -> in-process env set WORKS, but processEnvReachesThreadpool() says it doesn't`);
    stalled.close();
    exitProcess(reaches ? 0 : 1);
  }, 150);
}
