/**
 * A read of a healthy local file must answer while reads of a path whose
 * lookup doesn't answer are still running.
 *
 * Seen in production (Windows, remote device 0.2.52, 20 Oct 2026): read_file
 * of a file on D: answered "Path validation operation timed out after 10
 * seconds", over and over, while other tools kept working. The same happened
 * on 0.3.0.
 *
 * Expected: a folder whose lookups don't answer must not take every file
 * thread. validatePath() (src/tools/filesystem.ts) looks every path up with
 * fs.realpath, on one of libuv's 16 threads (src/bootstrap.ts), and a lookup
 * keeps its thread until the operating system answers, even after
 * validatePath() stops waiting for it (test/repro/test-withtimeout-leak.js).
 *
 * The path whose lookup doesn't answer:
 *   - Windows: a share on a host in 192.0.2.0/24 (TEST-NET-1, RFC 5737, never
 *     assigned): fs.realpath waits for the network, about 21 s, before it fails
 *   - macOS/Linux: a user can't make a path whose lookup never answers (that
 *     takes a network mount). So the server starts with fs.promises.realpath
 *     changed for one folder: a lookup there first reads a FIFO nobody writes
 *     to, and so holds a thread in open(), as a lookup on a stuck network mount
 *     does, until the test opens the FIFO's other end
 * If the share's lookup answers at once on this machine, the check is
 * skipped, not passed. On every system the server reports each lookup that
 * reaches that path on its stderr, and the healthy read starts once every
 * lookup the server runs there at once has: all 32, or LOOKUPS_PER_FOLDER
 * where the server has that limit.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-read-beside-stalled-path.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { answerText, closeClient } from './helpers/mcp-client.js';
import { serverTransport } from './helpers/mcp-server.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createStalledReadTarget } from './helpers/stalled-read.js';
import { createTestEnv } from './helpers/test-env.js';
import { waitUntil } from './helpers/wait.js';

// More reads of the stalled path than the threadpool has threads (16)
const STALLED_READS = 32;
// How long the stalled reads get to reach the stalled path
const ARRIVAL_DEADLINE_MS = 10_000;
// The healthy read gets this long, past the 10 s path-validation timeout
const READ_DEADLINE_MS = 30_000;
const FILE_TEXT = 'healthy local file';
// The server's stderr gets this, then how many lookups it runs at once in one
// folder, each time a lookup reaches the stalled path
const ARRIVED = 'dc-test: a lookup reached the stalled path; lookups at once per folder:';

/**
 * Node options for the server that make fs.promises.realpath, for every path
 * that starts with `prefix`, report the lookup on stderr (ARRIVED) and, with
 * `fifo`, then read it. Such a lookup holds a threadpool thread in open() until
 * someone opens the FIFO's other end, and then answers as usual.
 */
function stalledLookupArgs(prefix, fifo) {
  const preload = `
    import fsp from 'node:fs/promises';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const realpath = fsp.realpath;
    let atOnce;
    fsp.realpath = async function (p, ...rest) {
      if (path.resolve(String(p)).startsWith(${JSON.stringify(prefix)})) {
        // The server has loaded this module by the time it looks a path up, so this only reads it
        atOnce ??= import(new URL('tools/filesystem.js', pathToFileURL(process.argv[1])).href)
          .then((filesystem) => filesystem.LOOKUPS_PER_FOLDER ?? Infinity);
        process.stderr.write(${JSON.stringify(ARRIVED)} + ' ' + (await atOnce) + '\\n');
        ${fifo ? `await fsp.readFile(${JSON.stringify(fifo)});` : ''}
      }
      return realpath.call(this, p, ...rest);
    };`;
  return ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
}

/**
 * A path whose lookup holds a threadpool thread, with the server options that
 * make it so; null when this machine answers it at once
 */
async function createStalledPath(home) {
  if (process.platform !== 'win32') {
    const fifo = await createStalledReadTarget('dc-stalled-lookup');
    const folder = path.join(home, 'stalled-mount');
    return { path: path.join(folder, 'task.md'), serverArgs: stalledLookupArgs(folder + path.sep, fifo.path), release: fifo.close };
  }
  // Windows remembers for a while that a host didn't answer and then fails at
  // once, so each run takes a fresh host from the range
  for (let attempt = 0; attempt < 3; attempt++) {
    const share = `\\\\192.0.2.${1 + Math.floor(Math.random() * 254)}\\dc-test\\task.md`;
    const answered = await Promise.race([
      fs.promises.realpath(share).then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!answered) return { path: share, serverArgs: stalledLookupArgs(share), release: () => {} };
  }
  return null;
}

async function readFile(client, filePath) {
  return client.callTool({ name: 'read_file', arguments: { path: filePath } }, undefined, { timeout: READ_DEADLINE_MS });
}

async function runTests() {
  const testEnv = createTestEnv();
  const healthyFile = path.join(testEnv.home, 'healthy.txt');
  fs.writeFileSync(healthyFile, `${FILE_TEXT}\n`);
  let stalled;
  let client;
  try {
    stalled = await createStalledPath(testEnv.home);
    if (!stalled) {
      return skip('read beside a stalled path: a realpath on a share in 192.0.2.0/24 answers at once on this machine, so nothing holds a thread');
    }
    const transport = serverTransport({ env: testEnv.env, nodeArgs: stalled.serverArgs });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += chunk; });
    client = new Client({ name: 'test-read-beside-stalled-path', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport, { timeout: 30_000 });

    console.log('\n--- Test 1: a healthy file reads before any stalled read ---');
    const before = await readFile(client, healthyFile);
    assert(!before.isError && answerText(before).includes(FILE_TEXT), `the first read failed: ${answerText(before)}`);
    console.log('ok');

    console.log(`\n--- Test 2: a healthy file still reads while ${STALLED_READS} reads of ${stalled.path} wait ---`);
    for (let i = 0; i < STALLED_READS; i++) {
      client.callTool({ name: 'read_file', arguments: { path: stalled.path } }, undefined, { timeout: 120_000 }).catch(() => {});
    }
    // Every lookup the server lets run there at once: all of them, or a per-folder limit's worth
    await waitUntil(() => {
      const arrived = stderr.split(ARRIVED).slice(1);
      return arrived.length > 0 && arrived.length >= Math.min(STALLED_READS, parseFloat(arrived[0]));
    }, ARRIVAL_DEADLINE_MS, 'the stalled reads reach the stalled path');
    const started = Date.now();
    const during = await readFile(client, healthyFile);
    const text = answerText(during);
    console.log(`answered after ${Date.now() - started} ms: ${text.slice(0, 120)}`);
    assert(!during.isError, `reading ${healthyFile} failed while reads of a stalled path were waiting: ${text}`);
    assert(text.includes(FILE_TEXT), `the read answered without the file's text: ${text}`);
    console.log('ok');
    console.log('\n✅ read beside a stalled path tests passed');
  } finally {
    stalled?.release();
    await closeClient(client);
    testEnv.cleanup();
  }
}

runIfMain(import.meta.url, runTests);

export default runTests;
