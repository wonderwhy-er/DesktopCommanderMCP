#!/usr/bin/env node

/**
 * The device's rollouts (src/remote-device/rollouts.ts). A rollout turns
 * something on for a share of users, and the Remote MCP server decides who is
 * in. The device learns its user's rollouts three ways:
 *
 * - at start, after sign-in, it asks:
 *     GET {MCP_SERVER_URL}/device/rollouts
 *     Authorization: Bearer <the session's access token>
 *     -> 200 { "rollouts": { "<name>": true|false } }   (401 for a missing or bad token)
 * - every call row the server writes carries them (metadata.rollouts)
 * - every 30 minutes it asks again, with the session's token at that moment
 *
 * rolloutManager.get(name, false) reads them. The rules:
 *
 *   start answer arrives                                 -> use it
 *   start answer fails (401, 500, broken, none in 3 s)   -> all off
 *   call row has rollouts                                -> replace with them
 *   call row has none (an older server)                  -> keep what it has
 *   30-minute answer arrives                             -> replace with it
 *   30-minute answer fails                               -> keep what it has
 *
 * and each change logs a debug line, "Rollouts: …".
 *
 * A local HTTP server stands in for the Remote MCP server's /device/rollouts,
 * and setInterval is replaced, so the 30-minute refresh runs when a test says.
 *
 * The last cases start a real device process (dist/remote-device/device.js)
 * against the remote stand-in (helpers/remote-stand-in.js), as
 * integration/remote-device-restart.js does: it must ask after sign-in and
 * before it registers, take the rollouts of a call row it claims, and ask again
 * with the session's current token (helpers/fast-intervals.js runs its
 * 30-minute and 45-minute refreshes in seconds).
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-device-rollouts.js
 */
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MCPDevice } from '../dist/remote-device/device.js';
import { rolloutManager } from '../dist/remote-device/rollouts.js';
import { STARTED, startDevice, stopHard, tail, waitFor, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

/** The session's access token at start, and the one it holds after auth-js refreshed it */
const START_TOKEN = 'access-token-at-start';
const LATER_TOKEN = 'access-token-after-a-refresh';
/** The device waits 3 s for an answer; a request still running after this long hangs the device */
const REQUEST_DEADLINE_MS = 30_000;
const MINUTE = 60_000;
/** A device start (local MCP child, session, registration) takes seconds; this is far above */
const START_DEADLINE_MS = 60_000;
/** A claimed call or a fast refresh lands within seconds of the start; this is far above */
const RUN_DEADLINE_MS = 30_000;
const FAST_INTERVALS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fast-intervals.js');

const json = (body) => JSON.stringify(body);

/** What the device's session holds now; rolloutManager reads it through getToken() */
let sessionToken = START_TOKEN;
const getToken = async () => sessionToken;

/** Every "Rollouts: …" debug line, as the map it logged */
const rolloutLines = [];

/**
 * A Remote MCP server whose /device/rollouts checks the Bearer token as the
 * real route does, then answers `server.answer()`: [status, body text], or
 * null for no answer at all. Every request is kept in `requests`.
 */
async function startServer(answer) {
  const live = [START_TOKEN, LATER_TOKEN].map((token) => `Bearer ${token}`);
  const server = http.createServer((request, response) => {
    stub.requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    const result = live.includes(request.headers.authorization) ? stub.answer() : [401, json({ error: 'invalid token' })];
    if (!result) return;
    const [status, body] = result;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  const stub = {
    url: '',
    requests: [],
    answer,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  return stub;
}

/** Runs `operation`; false if it was still running after REQUEST_DEADLINE_MS */
async function finishes(operation) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(false), REQUEST_DEADLINE_MS); });
  try {
    return await Promise.race([operation.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** rolloutManager.load() from `server`, as a starting device does; false if it hung */
const load = (server) => finishes(rolloutManager.load(server.url, getToken));

/**
 * setInterval and clearInterval replaced, so the 30-minute refresh runs when a
 * test calls advance(). The interval's callback returns the refresh's promise,
 * and advance() waits for it. Every interval set is kept in `intervals`.
 */
function installClock() {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const intervals = [];
  let now = 0;
  globalThis.setInterval = (callback, ms) => {
    const interval = { callback, ms, next: now + ms, unrefed: false, cleared: false };
    interval.unref = () => { interval.unrefed = true; return interval; };
    intervals.push(interval);
    return interval;
  };
  globalThis.clearInterval = (interval) => {
    if (intervals.includes(interval)) interval.cleared = true;
    else real.clearInterval(interval);
  };
  return {
    intervals,
    /** `ms` pass: every interval runs as often as it fell due, one run after another */
    async advance(ms) {
      now += ms;
      for (const interval of intervals) {
        while (!interval.cleared && interval.next <= now) {
          interval.next += interval.ms;
          if (!await finishes(Promise.resolve(interval.callback()))) {
            throw new Error(`the 30-minute refresh was still running after ${REQUEST_DEADLINE_MS / 1000} s`);
          }
        }
      }
    },
    restore() {
      Object.assign(globalThis, real);
    },
  };
}

/**
 * A real device process against a fresh remote stand-in. `prepare(standIn)`
 * sets the stand-in up and returns the session device.json holds;
 * `check(standIn, device)` runs once the device got through its start.
 */
async function withDevice({ standInOptions, nodeArgs, prepare }, check) {
  const standIn = await startRemoteStandIn(standInOptions);
  const testEnv = createTestEnv();
  let device;
  try {
    writeDeviceConfig(testEnv.home, { deviceId: standIn.deviceId, session: prepare(standIn) });
    device = startDevice({ ...testEnv.env, MCP_SERVER_URL: standIn.url }, [], { nodeArgs });
    await waitFor(device, () => STARTED.test(device.output), START_DEADLINE_MS);
    assert.ok(STARTED.test(device.output),
      `the device ${device.exited ? `exited (code ${device.code})` : 'did not get through its start'}.\n    Its output:\n${tail(device.output)}`);
    await check(standIn, device);
  } finally {
    if (device) await stopHard(device);
    await standIn.close();
    try {
      testEnv.cleanup();
    } catch (error) {
      console.log(`   (could not remove ${testEnv.home}: ${error.message})`);
    }
  }
}

/** The "Rollouts: …" lines a device process printed */
const rolloutLinesOf = (device) => device.output.match(/^Rollouts: .*$/gm) ?? [];

async function runTests() {
  const failures = [];
  const servers = [];
  let clock = null;

  const consoleDebug = console.debug;
  console.debug = (...args) => {
    if (args[0] === 'Rollouts:') rolloutLines.push(args[1]);
    consoleDebug(...args);
  };

  async function test(name, fn) {
    const start = async (answer) => {
      const server = await startServer(answer);
      servers.push(server);
      return server;
    };
    const useClock = () => {
      clock = installClock();
      return clock;
    };
    sessionToken = START_TOKEN;
    try {
      await fn({ start, useClock });
      console.log(`✅ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${name}\n   ${error.message}`);
    } finally {
      rolloutManager.stopRefresh();
      clock?.restore();
      clock = null;
      for (const server of servers.splice(0)) await server.close();
    }
  }

  // Start

  await test('at start the device asks GET /device/rollouts with the session\'s access token as Bearer', async ({ start }) => {
    const server = await start(() => [200, json({ rollouts: { check: true } })]);
    await load(server);
    assert.deepStrictEqual(server.requests, [{ method: 'GET', url: '/device/rollouts', authorization: `Bearer ${START_TOKEN}` }],
      `the device's request for its rollouts was not GET /device/rollouts with its token as Bearer, so the server `
      + `cannot tell whose rollouts to answer. Requests: ${json(server.requests)}`);
  });

  await test('the start answer is used: get() answers what the server said, and the default for a rollout it did not name', async ({ start }) => {
    const server = await start(() => [200, json({ rollouts: { check: true, beta: false } })]);
    await load(server);
    const all = rolloutManager.getAll();
    all.check = false;
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

  /** The broken answers a request can get, for the start and the 30-minute refresh alike */
  const BROKEN = [
    ['{"rollouts": {"check": tr', 'an answer cut off mid-JSON'],
    [json({}), 'an answer without rollouts'],
    [json({ rollouts: 'check' }), 'rollouts that are not a name -> on/off object'],
    [json({ rollouts: { check: 'true' } }), 'a rollout that is not on or off'],
  ];

  /**
   * A start whose answer fails, after one that turned check on: whatever is
   * kept then comes from this start, and it must be nothing.
   */
  async function expectAllOff(start, answer, what) {
    await load(await start(() => [200, json({ rollouts: { check: true } })]));
    const finished = await load(await start(answer));
    assert.ok(finished, `with ${what}, the device's start waited for its rollouts longer than ${REQUEST_DEADLINE_MS / 1000} s`);
    const seen = { check: rolloutManager.get('check'), all: rolloutManager.getAll() };
    assert.deepStrictEqual(seen, { check: false, all: {} },
      `with ${what} at start, the device kept rollouts on (${json(seen)}): it must run with every rollout off`);
  }

  await test('a start answer that refuses the token (401) leaves every rollout off', ({ start }) =>
    expectAllOff(start, () => [401, json({ error: 'invalid token' })], 'its token refused (401)'));

  await test('a start answer with a server error (500) leaves every rollout off', ({ start }) =>
    expectAllOff(start, () => [500, json({ error: 'internal error' })], 'a server error (500)'));

  for (const [body, what] of BROKEN) {
    await test(`a broken start answer (${what}) leaves every rollout off`, ({ start }) =>
      expectAllOff(start, () => [200, body], what));
  }

  await test('no start answer within 3 s leaves every rollout off', ({ start }) =>
    expectAllOff(start, () => null, 'a server that never answers'));

  // Call rows

  await test('a call row with rollouts replaces what the device has; it does not merge into it', async ({ start }) => {
    await load(await start(() => [200, json({ rollouts: { check: true, beta: false } })]));
    rolloutManager.update({ beta: true });
    assert.deepStrictEqual(rolloutManager.getAll(), { beta: true },
      `after a call row with { beta: true }, the device has ${json(rolloutManager.getAll())}: `
      + 'the server left check out of that call\'s rollouts, so check must be off');
  });

  await test('a call row without rollouts (an older server) keeps what the device has', async ({ start }) => {
    await load(await start(() => [200, json({ rollouts: { check: true } })]));
    for (const [rollouts, what] of [
      [undefined, 'no rollouts'],
      [null, 'rollouts: null'],
      ['check', 'rollouts that are not a name -> on/off object'],
      [[true], 'rollouts that are a list'],
      [{ check: 'true' }, 'a rollout that is not on or off'],
    ]) {
      rolloutManager.update(rollouts);
      assert.deepStrictEqual(rolloutManager.getAll(), { check: true },
        `after a call row with ${what}, the device has ${json(rolloutManager.getAll())}: it must keep { check: true }`);
    }
  });

  // The 30-minute refresh

  await test('every 30 minutes the device asks again, with the session\'s token at that moment, and uses the answer', async ({ start, useClock }) => {
    const clock = useClock();
    const server = await start(() => [200, json({ rollouts: { check: true } })]);
    await load(server);
    rolloutManager.startRefresh();
    server.answer = () => [200, json({ rollouts: { beta: true } })];
    // auth-js refreshed the session since the start
    sessionToken = LATER_TOKEN;

    await clock.advance(29 * MINUTE);
    assert.strictEqual(server.requests.length, 1,
      `the device asked again ${server.requests.length - 1} time(s) within 29 minutes of its start: it asks every 30 minutes`);

    await clock.advance(1 * MINUTE);
    assert.deepStrictEqual(server.requests.slice(1), [{ method: 'GET', url: '/device/rollouts', authorization: `Bearer ${LATER_TOKEN}` }],
      '30 minutes after its start the device did not ask GET /device/rollouts with the session\'s current token: '
      + `a device running longer than its start token lives would lose its rollouts. Requests: ${json(server.requests)}`);
    assert.deepStrictEqual(rolloutManager.getAll(), { beta: true },
      `the 30-minute answer was { beta: true }, but the device has ${json(rolloutManager.getAll())}: it must replace what it had`);

    await clock.advance(30 * MINUTE);
    assert.strictEqual(server.requests.length, 3, 'the device did not ask again another 30 minutes later');
  });

  await test('a pending 30-minute refresh does not keep the process running (unref)', async ({ start, useClock }) => {
    const clock = useClock();
    await load(await start(() => [200, json({ rollouts: {} })]));
    rolloutManager.startRefresh();
    assert.ok(clock.intervals.length === 1 && clock.intervals[0].unrefed,
      'the 30-minute refresh is not unref\'d: a process that is otherwise done would wait for it');
  });

  await test('stopRefresh() ends the 30-minute refresh', async ({ start, useClock }) => {
    const clock = useClock();
    const server = await start(() => [200, json({ rollouts: { check: true } })]);
    await load(server);
    rolloutManager.startRefresh();
    rolloutManager.stopRefresh();
    await clock.advance(60 * MINUTE);
    assert.strictEqual(server.requests.length, 1,
      `the device asked again ${server.requests.length - 1} time(s) after stopRefresh()`);
  });

  /** A 30-minute answer that fails, after a start that turned check on: the device must keep check on */
  async function expectKept(start, useClock, answer, what, token = START_TOKEN) {
    const clock = useClock();
    const server = await start(() => [200, json({ rollouts: { check: true } })]);
    await load(server);
    rolloutManager.startRefresh();
    server.answer = answer;
    sessionToken = token;
    await clock.advance(30 * MINUTE);
    assert.strictEqual(server.requests.length, 2, 'the device did not ask again 30 minutes after its start');
    assert.deepStrictEqual(rolloutManager.getAll(), { check: true },
      `with ${what} at the 30-minute refresh, the device has ${json(rolloutManager.getAll())}: it must keep { check: true }`);
  }

  await test('a 30-minute answer that refuses the token (401) keeps what the device has', ({ start, useClock }) =>
    expectKept(start, useClock, () => [200, json({ rollouts: {} })], 'its token refused (401)', 'a-token-the-server-refuses'));

  await test('a 30-minute answer with a server error (500) keeps what the device has', ({ start, useClock }) =>
    expectKept(start, useClock, () => [500, json({ error: 'internal error' })], 'a server error (500)'));

  for (const [body, what] of BROKEN) {
    await test(`a broken 30-minute answer (${what}) keeps what the device has`, ({ start, useClock }) =>
      expectKept(start, useClock, () => [200, body], what));
  }

  await test('no 30-minute answer within 3 s keeps what the device has', ({ start, useClock }) =>
    expectKept(start, useClock, () => null, 'a server that never answers'));

  // The debug line

  await test('each change logs one "Rollouts:" debug line, and no change logs none', async ({ start, useClock }) => {
    const clock = useClock();
    const server = await start(() => [200, json({ rollouts: {} })]);
    await load(server);
    rolloutLines.length = 0;

    server.answer = () => [200, json({ rollouts: { check: true } })];
    await load(server); // start: on
    rolloutManager.update({ check: true }); // the same again
    rolloutManager.update({ check: false }); // call row: off
    rolloutManager.update(undefined); // call row from an older server
    rolloutManager.startRefresh();
    await clock.advance(30 * MINUTE); // 30 minutes: on
    server.answer = () => [500, json({ error: 'internal error' })];
    await clock.advance(30 * MINUTE); // 30 minutes, failed
    await load(server); // start, failed: all off

    assert.deepStrictEqual(rolloutLines, [{ check: true }, { check: false }, { check: true }, {}],
      `the device logged ${json(rolloutLines)}; the changes were { check: true }, { check: false }, { check: true }, {}`);
  });

  // A real device

  await test('a starting device asks for its rollouts after sign-in and before it registers, and logs them', () => withDevice({
    prepare(standIn) {
      standIn.rollouts = { check: true };
      // Saved by a run that ended longer ago than its access token lives, so
      // sign-in refreshes it. The stand-in refuses the saved token: only the
      // session's current one gets the rollouts.
      return standIn.login({ accessExpiresInSec: -60 });
    },
  }, async (standIn, device) => {
    const order = standIn.requests.map((r) => `${r.method} ${new URL(r.url, standIn.url).pathname}`);
    const signIn = order.findIndex((r) => r.includes(' /auth/v1/'));
    const asked = order.indexOf('GET /device/rollouts');
    const registered = order.indexOf('PATCH /rest/v1/mcp_devices');
    const logged = rolloutLinesOf(device)[0];
    const problems = [];
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
  }));

  await test('a call row the device claims with { check: false } turns check off', () => withDevice({
    standInOptions: { channel: true },
    prepare(standIn) {
      standIn.rollouts = { check: true };
      standIn.calls.push({
        id: 'c0a1b2c3-0000-4000-8000-000000000695',
        user_id: standIn.userId,
        device_id: standIn.deviceId,
        status: 'pending',
        tool_name: 'ping',
        tool_args: {},
        metadata: { transport: 'broadcast_v1', rollouts: { check: false } },
        created_at: new Date().toISOString(),
        timeout_at: new Date(Date.now() + 5 * MINUTE).toISOString(),
      });
      return standIn.login();
    },
  }, async (standIn, device) => {
    const [call] = standIn.calls;
    await waitFor(device, () => call.status === 'completed', RUN_DEADLINE_MS);
    const logged = rolloutLinesOf(device);
    const problems = [];
    if (call.status !== 'completed') problems.push(`it did not run the pending call (its row is ${call.status})`);
    if (json(logged) !== json(['Rollouts: { check: true }', 'Rollouts: { check: false }'])) {
      problems.push(`it logged ${json(logged)} where the start answer had check on and the call row had it off`);
    }
    assert.ok(problems.length === 0,
      `a call row's rollouts did not reach the device, so a change would wait for its next start: ${problems.join('; ')}.\n`
      + `    Its output:\n${tail(device.output)}`);
  }));

  await test('a running device asks again with the session\'s current token, and uses the answer', () => withDevice({
    standInOptions: { channel: true },
    nodeArgs: ['--import', pathToFileURL(FAST_INTERVALS).href],
    prepare(standIn) {
      standIn.rollouts = { check: true };
      return standIn.login();
    },
  }, async (standIn, device) => {
    // Its session refreshes (every 45 minutes, here every 4 s), and then the server's answer changes
    await waitFor(device, () => standIn.rotations() > 0, RUN_DEADLINE_MS);
    standIn.rollouts = { check: false };
    const askedWithCurrentToken = () => standIn.rolloutRequests.some((r) => r.rotations > 0 && r.currentToken);
    const loggedChange = () => rolloutLinesOf(device).includes('Rollouts: { check: false }');
    await waitFor(device, () => askedWithCurrentToken() && loggedChange(), RUN_DEADLINE_MS);
    const problems = [];
    if (standIn.rotations() === 0) problems.push('its session never refreshed, so this test cannot tell which token it sends');
    else if (!askedWithCurrentToken()) problems.push('after its session refreshed, it never asked with the session\'s current token');
    if (!loggedChange()) problems.push(`it logged ${json(rolloutLinesOf(device))}, never the later answer { check: false }`);
    assert.ok(problems.length === 0,
      `a running device did not keep its rollouts current: ${problems.join('; ')}.\n`
      + `    Requests for rollouts: ${json(standIn.rolloutRequests)}\n    Its output:\n${tail(device.output)}`);
  }));

  await test('a device that shuts down stops the 30-minute refresh', async ({ start, useClock }) => {
    const clock = useClock();
    const server = await start(() => [200, json({ rollouts: { check: true } })]);
    await load(server);
    rolloutManager.startRefresh();
    const device = new MCPDevice();
    device.remoteChannel = { stopHeartbeat() {}, unsubscribe: async () => {}, setOffline: async () => {} };
    device.desktop = { shutdown: async () => {} };
    await device.shutdown();
    await clock.advance(30 * MINUTE);
    assert.strictEqual(server.requests.length, 1,
      `the device asked for its rollouts ${server.requests.length - 1} time(s) after it shut down`);
  });

  console.debug = consoleDebug;
  console.log(`\n${failures.length ? '🔴' : '✅'} device rollouts: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
