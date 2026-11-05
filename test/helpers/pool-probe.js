/**
 * A Node preload (--import) for a server under test: it tells whether the
 * server's libuv thread pool still has a free thread while DC_TEST_POOL_STALLED
 * reads of a pipe nobody writes to hold threads, as reads of a cloud or network
 * path that doesn't answer do.
 *
 * It checks once the file named in DC_TEST_POOL_PROBE exists. The test creates
 * that file after the server has answered initialize, so the process that
 * checks is the one serving MCP. It then writes one line on stderr:
 *   dc-test: pool probe: free|full|unsure with <n> stalled reads
 * - free: a trivial fs operation still answered within 3 s
 * - full: it didn't
 * - unsure: a read failed instead of waiting, so it held no thread
 */
import fs from 'fs';
import fsp from 'fs/promises';
import { createStalledReadTarget } from './stalled-read.js';

const TRIGGER = process.env.DC_TEST_POOL_PROBE;
const STALLED_READS = Number(process.env.DC_TEST_POOL_STALLED);
const ANSWER_MS = 3000;
// Between two reads. On Windows a pipe server keeps only 4 instances waiting for
// a connection, so reads that connect at the same moment can fail with EBUSY
const READ_GAP_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe() {
  const stalled = await createStalledReadTarget('dc-pool-probe');
  let failedReads = 0;
  for (let i = 0; i < STALLED_READS; i++) {
    fsp.readFile(stalled.path).catch(() => { failedReads++; });
    await sleep(READ_GAP_MS);
  }
  // Gives the last read time to take its thread
  await sleep(200);
  const answered = await Promise.race([
    fsp.stat(process.execPath).then(() => true),
    sleep(ANSWER_MS).then(() => false),
  ]);
  const answer = failedReads > 0 ? 'unsure' : answered ? 'free' : 'full';
  process.stderr.write(`dc-test: pool probe: ${answer} with ${STALLED_READS} stalled reads (${failedReads} failed)\n`);
  // Ends the stalled reads, so their threads don't keep the server from exiting
  stalled.close();
}

// existsSync runs on the main thread, not in the thread pool
const timer = setInterval(() => {
  if (!fs.existsSync(TRIGGER)) return;
  clearInterval(timer);
  probe();
}, 100);
timer.unref();
