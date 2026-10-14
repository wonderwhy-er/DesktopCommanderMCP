#!/usr/bin/env node

/**
 * The device's rollouts (src/remote-device/rollouts.ts). A rollout turns
 * something on for a share of users, and the Remote MCP server decides who is
 * in. At start the device asks it, once, which rollouts are on for its user:
 *
 *     GET {MCP_SERVER_URL}/device/rollouts
 *     Authorization: Bearer <the session's access token>
 *     -> 200 { "rollouts": { "<name>": true|false } }   (401 for a missing or bad token)
 *
 * and keeps the answer for the run: rolloutManager.get(name, false).
 *
 * Anything but a good answer leaves every rollout off for that run: a refused
 * token, a server error, an answer that isn't the rollouts JSON, or no answer
 * within 3 s.
 *
 * A local HTTP server stands in for the Remote MCP server's /device/rollouts.
 * The last case starts a real device process (dist/remote-device/device.js)
 * against the remote stand-in (helpers/remote-stand-in.js), as
 * integration/remote-device-restart.js does: it must ask after sign-in, before
 * it registers, and log what it got.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-device-rollouts.js
 */
import assert from 'node:assert';
import http from 'node:http';
import { rolloutManager } from '../dist/remote-device/rollouts.js';
import { STARTED, startDevice, stopHard, tail, waitFor, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

const TOKEN = 'access-token-of-the-signed-in-user';
/** The device waits 3 s for an answer; a load still running after this long hangs the start */
const LOAD_DEADLINE_MS = 30_000;
/** A device start (local MCP child, session, registration) takes seconds; this is far above */
const START_DEADLINE_MS = 60_000;

const json = (body) => JSON.stringify(body);

/**
 * A Remote MCP server whose /device/rollouts checks the Bearer token as the
 * real route does, then answers `answer()`: [status, body text], or null for
 * no answer at all. Every request is kept in `requests`.
 */
async function startServer(answer) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    const result = request.headers.authorization === `Bearer ${TOKEN}`
      ? answer()
      : [401, json({ error: 'invalid token' })];
    if (!result) return;
    const [status, body] = result;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** rolloutManager.load() from `server`; false if it was still running after LOAD_DEADLINE_MS */
async function load(server) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(false), LOAD_DEADLINE_MS); });
  try {
    return await Promise.race([rolloutManager.load(server.url, TOKEN).then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTests() {
  const failures = [];
  const servers = [];

  async function test(name, fn) {
    const start = async (answer) => {
      const server = await startServer(answer);
      servers.push(server);
      return server;
    };
    try {
      await fn(start);
      console.log(`✅ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${name}\n   ${error.message}`);
    } finally {
      for (const server of servers.splice(0)) await server.close();
    }
  }

  await test('the device asks GET /device/rollouts with the session\'s access token as Bearer', async (start) => {
    const server = await start(() => [200, json({ rollouts: { check: true } })]);
    await load(server);
    assert.deepStrictEqual(server.requests, [{ method: 'GET', url: '/device/rollouts', authorization: `Bearer ${TOKEN}` }],
      `the device's request for its rollouts was not GET /device/rollouts with its token as Bearer, so the server `
      + `cannot tell whose rollouts to answer. Requests: ${json(server.requests)}`);
  });

  await test('get() answers what the server said; a rollout it did not name gets the default', async (start) => {
    const server = await start(() => [200, json({ rollouts: { check: true, beta: false } })]);
    await load(server);
    const seen = {
      check: rolloutManager.get('check'),
      'beta, default true': rolloutManager.get('beta', true),
      unnamed: rolloutManager.get('unnamed'),
      'unnamed, default true': rolloutManager.get('unnamed', true),
      all: rolloutManager.getAll(),
    };
    assert.deepStrictEqual(seen, {
      check: true,
      'beta, default true': false,
      unnamed: false,
      'unnamed, default true': true,
      all: { check: true, beta: false },
    }, `the server answered { check: true, beta: false }, but the device read ${json(seen)}: `
      + 'a user the server put in a rollout would not get it, or one it left out would');
  });

  /**
   * A load that fails, after one that turned check on: whatever is kept then
   * comes from this load, and it must be nothing.
   */
  async function expectAllOff(start, answer, what) {
    await load(await start(() => [200, json({ rollouts: { check: true } })]));
    const server = await start(answer);
    const finished = await load(server);
    assert.ok(finished, `with ${what}, the device's start waited for its rollouts longer than ${LOAD_DEADLINE_MS / 1000} s`);
    const seen = { check: rolloutManager.get('check'), all: rolloutManager.getAll() };
    assert.deepStrictEqual(seen, { check: false, all: {} },
      `with ${what}, the device kept rollouts on (${json(seen)}): it must run with every rollout off`);
  }

  await test('a refused token (401) leaves every rollout off', (start) =>
    expectAllOff(start, () => [401, json({ error: 'invalid token' })], 'its token refused (401)'));

  await test('a server error (500) leaves every rollout off', (start) =>
    expectAllOff(start, () => [500, json({ error: 'internal error' })], 'a server error (500)'));

  for (const [body, what] of [
    ['{"rollouts": {"check": tr', 'an answer cut off mid-JSON'],
    [json({}), 'an answer without rollouts'],
    [json({ rollouts: 'check' }), 'rollouts that are not a name -> on/off object'],
  ]) {
    await test(`a broken answer (${what}) leaves every rollout off`, (start) =>
      expectAllOff(start, () => [200, body], what));
  }

  await test('no answer within 3 s leaves every rollout off', (start) =>
    expectAllOff(start, () => null, 'a server that never answers'));

  await test('a starting device asks for its rollouts after sign-in and before it registers, and logs them', async () => {
    const standIn = await startRemoteStandIn();
    const testEnv = createTestEnv();
    let device;
    try {
      standIn.rollouts = { check: true };
      // Saved by a run that ended longer ago than its access token lives, so
      // sign-in refreshes it. The stand-in refuses the saved token: only the
      // session's current one gets the rollouts.
      writeDeviceConfig(testEnv.home, { deviceId: standIn.deviceId, session: standIn.login({ accessExpiresInSec: -60 }) });
      device = startDevice({ ...testEnv.env, MCP_SERVER_URL: standIn.url });
      await waitFor(device, () => STARTED.test(device.output), START_DEADLINE_MS);

      const order = standIn.requests.map((r) => `${r.method} ${new URL(r.url, standIn.url).pathname}`);
      const signIn = order.findIndex((r) => r.includes(' /auth/v1/'));
      const asked = order.indexOf('GET /device/rollouts');
      const registered = order.indexOf('PATCH /rest/v1/mcp_devices');
      const logged = device.output.match(/^Rollouts: .*$/m)?.[0];
      const problems = [];
      if (!STARTED.test(device.output)) {
        problems.push(device.exited ? `it exited (code ${device.code})` : 'it did not get through its start');
      }
      if (asked === -1) {
        problems.push('it never asked GET /device/rollouts');
      } else {
        if (order.filter((r) => r === 'GET /device/rollouts').length > 1) problems.push('it asked more than once');
        if (!(signIn !== -1 && signIn < asked)) problems.push('it asked before signing in');
        if (!(registered === -1 || asked < registered)) problems.push('it asked after registering');
      }
      if (logged !== 'Rollouts: { check: true }') {
        problems.push(`it logged ${logged ? `"${logged}"` : 'no "Rollouts:" line'} where the server had check on for its user`);
      }
      assert.ok(problems.length === 0,
        `a starting device did not get its rollouts from the server, so a rollout could never reach it: ${problems.join('; ')}.\n`
        + `    Requests: ${order.join(', ')}\n    Its output:\n${tail(device.output)}`);
    } finally {
      if (device) await stopHard(device);
      await standIn.close();
      try {
        testEnv.cleanup();
      } catch (error) {
        console.log(`   (could not remove ${testEnv.home}: ${error.message})`);
      }
    }
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} device rollouts: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
