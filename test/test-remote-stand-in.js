#!/usr/bin/env node

/**
 * The remote stand-in (helpers/remote-stand-in.js) itself.
 *
 * Without `realtime` or `channel`, the stand-in refuses every websocket
 * upgrade with a 503, and the device tries again later. A device that resets
 * the connection while that answer is on its way must not stop the test
 * process. Node's http server stops watching a socket for errors once it hands
 * the socket to an 'upgrade' handler, so the reset's "read ECONNRESET" is an
 * unhandled error unless the handler listens for it. That stopped
 * integration/remote-device-restart.js on a busy Windows machine.
 *
 * The stand-in runs in this process, as in the device tests, so an error it
 * leaves unhandled lands here. This file records it instead of stopping.
 *
 * Runs as part of `npm test`, or alone:
 *   node test/run-all-tests.js test-remote-stand-in.js
 */
import assert from 'node:assert';
import net from 'node:net';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { runIfMain } from './helpers/run-if-main.js';

/** The stand-in answers within milliseconds; this is far above */
const ANSWER_DEADLINE_MS = 10_000;

/** The first line of the stand-in's answer to a websocket it refuses */
const REFUSED = 'HTTP/1.1 503 Service Unavailable';

// An error the stand-in leaves unhandled would stop this process; it is kept
// here and fails the file, even if it lands after the last check
let uncaught = null;
process.on('uncaughtException', (error) => {
  uncaught = error;
  process.exitCode = 1;
  console.log(`❌ uncaught exception: ${error.message}`);
});

/**
 * Asks the stand-in for the realtime websocket on a new connection, as the
 * device does, and resolves with the first line of the answer once the
 * connection is closed. With `reset`, the connection is reset as soon as the
 * answer starts to arrive, without closing it first.
 */
function upgrade(standIn, { reset = false } = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(standIn.url);
    // With allowHalfOpen, the stand-in closing its side doesn't close this side, so only the reset ends the connection
    const socket = net.connect({ host: hostname, port: Number(port), allowHalfOpen: reset });
    let answer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the stand-in did not answer the upgrade within ${ANSWER_DEADLINE_MS} ms`));
    }, ANSWER_DEADLINE_MS);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => {
      socket.write([
        `GET /realtime/v1/websocket?apikey=${standIn.anonKey}&vsn=1.0.0 HTTP/1.1`,
        `Host: ${hostname}:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '', '',
      ].join('\r\n'));
    });
    socket.on('data', (data) => {
      answer += data;
      if (reset) socket.resetAndDestroy();
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(answer.split('\r\n')[0]);
    });
  });
}

async function runTests() {
  const failures = [];

  async function test(name, fn) {
    // As the device tests start it: no realtime, no channel
    const standIn = await startRemoteStandIn();
    try {
      await fn(standIn);
      console.log(`✅ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${name}\n   ${error.message}`);
    } finally {
      await standIn.close();
    }
  }

  await test('a device that resets the refused websocket connection does not stop the test process, and the next upgrade is answered', async (standIn) => {
    const refused = await upgrade(standIn, { reset: true });
    assert.strictEqual(refused, REFUSED, `the stand-in answered the upgrade ${JSON.stringify(refused)}, not with a 503`);
    // A few round trips: by the time this upgrade is answered, the reset of the first one has reached the stand-in
    const next = await upgrade(standIn);
    const problems = [];
    if (uncaught) {
      problems.push(`the reset connection's error was left unhandled (${uncaught.message}), which stops the process the stand-in runs in`);
    }
    if (next !== REFUSED) problems.push(`the next upgrade was answered ${JSON.stringify(next)}, not with a 503`);
    assert.ok(problems.length === 0, problems.join('; '));
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} remote stand-in: ${failures.length} failing test(s).`);
  return failures.length === 0 && !uncaught;
}

runIfMain(import.meta.url, runTests);
