// The server, started the way its `bin` entry starts it (node dist/index.js),
// must run with libuv's thread pool at 16 threads (src/bootstrap.ts), or at
// the size the user set in UV_THREADPOOL_SIZE.
//
// Seen on Windows with Node 22: the server ran with libuv's default 4 threads,
// so 4 reads of a cloud or network path that doesn't answer held every thread,
// and every other file operation waited behind them. libuv before 1.52 reads
// UV_THREADPOOL_SIZE only from the environment the process started with, and
// the bootstrap set it inside the process.
//
// Each case starts the server with test/helpers/pool-probe.js as a preload.
// Once the server has answered initialize, the probe holds 8 threads with reads
// of a pipe nobody writes to, and checks whether a trivial fs operation still
// answers:
// - default: it must ("free"), with 16 threads there are 8 left
// - UV_THREADPOOL_SIZE=4 from the user: it must not ("full"), so the user's
//   value is kept
// A probe that can't tell (a read failed instead of waiting) answers "unsure",
// and the case fails.
//
// Run: node test/repro/run-repro.js test-server-threadpool.js
// Exit code: 0 when both cases hold; 1 otherwise.
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { closeClient } from '../helpers/close-client.js';
import { serverTransport } from '../helpers/mcp-server.js';
import { createTempDir, createTestEnv } from '../helpers/test-env.js';
import { waitUntil } from '../helpers/wait.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const PROBE = new URL('../helpers/pool-probe.js', import.meta.url).href;
const STALLED_READS = 8;
const ANSWER = /dc-test: pool probe: (free|full|unsure)/;

/** Starts the server with `userSize` as UV_THREADPOOL_SIZE (none if undefined) and returns the probe's answer */
async function probeServer(userSize) {
  const testEnv = createTestEnv();
  const dir = createTempDir('dc-pool-probe-');
  const trigger = path.join(dir, 'probe-now');
  const { UV_THREADPOOL_SIZE, ...env } = testEnv.env;
  const transport = serverTransport({
    env: {
      ...env,
      ...(userSize ? { UV_THREADPOOL_SIZE: userSize } : {}),
      DC_TEST_POOL_PROBE: trigger,
      DC_TEST_POOL_STALLED: String(STALLED_READS),
    },
    nodeArgs: ['--import', PROBE],
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'dc-pool-probe', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 30_000 });
    fs.writeFileSync(trigger, '');
    await waitUntil(() => ANSWER.test(stderr), 15_000, 'the probe answers on the server\'s stderr');
    return ANSWER.exec(stderr)[1];
  } finally {
    await closeClient(client);
    fs.rmSync(dir, { recursive: true, force: true });
    testEnv.cleanup();
  }
}

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
let failed = false;

const byDefault = await probeServer(undefined);
log(`default: the pool is ${byDefault} with ${STALLED_READS} stalled reads`);
if (byDefault !== 'free') {
  log(`-> the server does NOT have its 16 threads`);
  failed = true;
}

const userFour = await probeServer('4');
log(`UV_THREADPOOL_SIZE=4: the pool is ${userFour} with ${STALLED_READS} stalled reads`);
if (userFour !== 'full') {
  log(`-> the user's UV_THREADPOOL_SIZE was NOT kept`);
  failed = true;
}

if (!failed) log('the server has its 16 threads, and keeps the user\'s size');
exitProcess(failed ? 1 : 0);
