#!/usr/bin/env node

/**
 * The device's rollouts (src/remote-device/rollouts.ts). The Remote MCP server
 * decides which rollouts are on for each user. The device asks for them at
 * start (GET /device/rollouts, with the session's token), takes the ones each
 * call row carries (metadata.rollouts), and asks again every 30 minutes.
 *
 * RULES below is what the device has after each of these. fetch is replaced
 * by a stand-in for the server, and the clock by Node's fake timers, so the
 * 3-second wait and the 30-minute refresh happen at once.
 *
 * The last two tests start a real device (dist/remote-device/device.js)
 * against the remote stand-in (helpers/remote-stand-in.js).
 *
 * Runs as part of `npm test`, or alone:
 *   node test/run-all-tests.js test-device-rollouts.js
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mock } from 'node:test';
import { MCPDevice } from '../dist/remote-device/device.js';
import { rolloutManager } from '../dist/remote-device/rollouts.js';
import { STARTED, startDevice, stopHard, tail, waitFor, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

const SERVER = 'https://server.example';
const MINUTE = 60_000;
/** A device start (local MCP child, session, registration) takes seconds; this is far above */
const START_DEADLINE_MS = 60_000;
/** A claimed call runs within seconds of the start; this is far above */
const CALL_DEADLINE_MS = 30_000;

const json = (value) => JSON.stringify(value);

// What the server answers
const rollouts = (map) => ({ status: 200, body: json({ rollouts: map }) });
const status = (code) => ({ status: code, body: json({ error: 'refused' }) });
const body = (text) => ({ status: 200, body: text });
const NO_ANSWER = null;

const ON = { check: true };

/**
 * What the device has after each event, starting from a device that has
 * { check: true }. `token: null` is a device with no session token.
 */
const RULES = [
  { event: 'start', answer: rollouts({ check: false, beta: true }), has: { check: false, beta: true }, name: 'start: the answer is used' },
  { event: 'start', answer: status(401), has: {}, name: 'start: a refused token turns every rollout off' },
  { event: 'start', answer: status(500), has: {}, name: 'start: a server error turns every rollout off' },
  { event: 'start', answer: body('{"rollouts": {"check": tr'), has: {}, name: 'start: an answer cut off in the middle turns every rollout off' },
  { event: 'start', answer: body('{}'), has: {}, name: 'start: an answer without rollouts turns every rollout off' },
  { event: 'start', answer: rollouts({ check: 'yes' }), has: {}, name: 'start: a rollout that is neither on nor off turns every rollout off' },
  { event: 'start', answer: NO_ANSWER, has: {}, name: 'start: no answer within 3 seconds turns every rollout off' },
  { event: 'start', token: null, answer: rollouts(ON), has: {}, name: 'start: with no session token nothing is asked, and every rollout is off' },
  { event: 'call row', row: { beta: true }, has: { beta: true }, name: 'call row: its rollouts replace what the device has' },
  { event: 'call row', row: undefined, has: ON, name: 'call row: a row without rollouts (an older server) keeps what the device has' },
  { event: 'call row', row: { check: 'yes' }, has: ON, name: 'call row: a rollout that is neither on nor off keeps what the device has' },
  { event: '30 minutes', answer: rollouts({ beta: true }), has: { beta: true }, name: '30 minutes later: the answer replaces what the device has' },
  { event: '30 minutes', answer: status(401), has: ON, name: '30 minutes later: a refused token keeps what the device has' },
  { event: '30 minutes', answer: status(500), has: ON, name: '30 minutes later: a server error keeps what the device has' },
  { event: '30 minutes', answer: body('{"rollouts": {"check": tr'), has: ON, name: '30 minutes later: an answer cut off in the middle keeps what the device has' },
  { event: '30 minutes', answer: body('{}'), has: ON, name: '30 minutes later: an answer without rollouts keeps what the device has' },
  { event: '30 minutes', answer: NO_ANSWER, has: ON, name: '30 minutes later: no answer within 3 seconds keeps what the device has' },
  { event: '30 minutes', token: null, answer: rollouts({}), has: ON, name: '30 minutes later: with no session token nothing is asked, and the device keeps what it has' },
];

/**
 * Replaces fetch with a server that answers `server.answer` (or, when that is a
 * promise, what it resolves to, once it does); each request is kept as "url token"
 */
function fakeServer(answer) {
  const server = { answer, requests: [] };
  mock.method(globalThis, 'fetch', async (url, { headers }) => {
    server.requests.push(`${url} ${headers.Authorization}`);
    if (server.answer === NO_ANSWER) return new Promise(() => {});
    const { status: code, body: text } = await server.answer;
    return { ok: code === 200, status: code, json: async () => JSON.parse(text) };
  });
  return server;
}

/** The maps logged as "Rollouts: …" since `console.debug` was replaced */
function logLines() {
  const debug = mock.method(console, 'debug', () => {});
  return () => debug.mock.calls.filter((call) => call.arguments[0] === 'Rollouts:').map((call) => call.arguments[1]);
}

/** Lets the device's pending work finish: fetch and every step after it answer at once here */
const settle = () => new Promise(setImmediate);

/** Runs `ms` of the fake clock, letting the device's work finish before and after */
async function wait(ms) {
  await settle();
  mock.timers.tick(ms);
  await settle();
}

async function checkRule(rule) {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const server = fakeServer(rollouts(ON));
  let token = 'token-at-start';
  await rolloutManager.load(SERVER, async () => token);
  rolloutManager.startRefresh();

  const logged = logLines();
  server.requests = [];
  server.answer = rule.answer;
  token = rule.token === undefined ? 'token-now' : rule.token;
  if (rule.event === 'start') {
    const loading = rolloutManager.load(SERVER, async () => token);
    await wait(3000);
    await loading;
  } else if (rule.event === 'call row') {
    rolloutManager.update(rule.row);
  } else {
    await wait(30 * MINUTE);
    await wait(3000);
  }

  const asked = rule.event !== 'call row' && token !== null ? [`${SERVER}/device/rollouts Bearer token-now`] : [];
  const changed = json(rule.has) !== json(ON);
  assert.deepStrictEqual(
    { has: rolloutManager.getAll(), asked: server.requests, logged: logged() },
    { has: rule.has, asked, logged: changed ? [rule.has] : [] },
    `the device has ${json(rolloutManager.getAll())} (expected ${json(rule.has)}), asked ${json(server.requests)} `
    + `(expected ${json(asked)}), and logged ${json(logged())}`,
  );
}

/**
 * A real device process against a fresh remote stand-in. `prepare(standIn)`
 * sets the stand-in up and returns the session device.json holds;
 * `check(standIn, device)` runs once the device got through its start.
 */
async function withDevice({ standInOptions, prepare }, check) {
  const standIn = await startRemoteStandIn(standInOptions);
  const testEnv = createTestEnv();
  let device;
  try {
    writeDeviceConfig(testEnv.home, { deviceId: standIn.deviceId, session: prepare(standIn) });
    device = startDevice({ ...testEnv.env, MCP_SERVER_URL: standIn.url });
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

/** The time a device process starts each printed line with, e.g. "[15:27:03] " */
const TIME = /^\[\d{2}:\d{2}:\d{2}\] /;

/** The "Rollouts: …" lines a device process printed, without their time */
const rolloutLinesOf = (device) =>
  (device.output.match(/^\[\d{2}:\d{2}:\d{2}\] Rollouts: .*$/gm) ?? []).map((line) => line.replace(TIME, ''));

async function runTests() {
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${name}\n   ${error.message}`);
    } finally {
      rolloutManager.stopRefresh();
      mock.restoreAll();
      mock.timers.reset();
    }
  }

  for (const rule of RULES) {
    await test(rule.name, () => checkRule(rule));
  }

  await test('the device asks again every 30 minutes, not sooner, until the refresh is stopped', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const server = fakeServer(rollouts(ON));
    await rolloutManager.load(SERVER, async () => 'token');
    rolloutManager.startRefresh();
    const asked = [];
    for (const minutes of [29, 1, 30]) {
      await wait(minutes * MINUTE);
      asked.push(server.requests.length);
    }
    rolloutManager.stopRefresh();
    await wait(60 * MINUTE);
    asked.push(server.requests.length);
    assert.deepStrictEqual(asked, [1, 2, 3, 3],
      `requests so far after 29 minutes, 30, 60, and an hour after the refresh stopped: ${json(asked)}`);
  });

  await test('a call row that arrives while the 30-minute request waits wins over its answer', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const server = fakeServer(rollouts(ON));
    await rolloutManager.load(SERVER, async () => 'token');
    rolloutManager.startRefresh();
    let answer;
    server.answer = new Promise((resolve) => { answer = resolve; });
    await wait(30 * MINUTE); // the device asks; the answer is not there yet
    rolloutManager.update({ check: false, beta: true }); // a call row, newer than that request
    answer(rollouts(ON)); // the 30-minute answer arrives, with the older values
    await settle();
    assert.deepStrictEqual({ asked: server.requests.length, has: rolloutManager.getAll() }, { asked: 2, has: { check: false, beta: true } },
      `after the call row's { check: false, beta: true } and the late 30-minute answer { check: true }, the device has `
      + `${json(rolloutManager.getAll())} (it asked ${server.requests.length} time(s))`);
  });

  await test('a rollout the server did not name is off, unless the caller says otherwise', async () => {
    fakeServer(rollouts({ check: true, beta: false }));
    await rolloutManager.load(SERVER, async () => 'token');
    const all = rolloutManager.getAll();
    all.check = false;
    const seen = {
      check: rolloutManager.get('check'),
      beta: rolloutManager.get('beta', true),
      unnamed: rolloutManager.get('unnamed'),
      unnamedSaidOn: rolloutManager.get('unnamed', true),
      all: rolloutManager.getAll(),
    };
    assert.deepStrictEqual(seen, { check: true, beta: false, unnamed: false, unnamedSaidOn: true, all: { check: true, beta: false } },
      `the server answered { check: true, beta: false }, and the device read ${json(seen)}`);
  });

  await test('a pending 30-minute refresh does not keep a finished process running', async () => {
    const script = `import { rolloutManager } from ${json(new URL('../dist/remote-device/rollouts.js', import.meta.url).href)};
      await rolloutManager.load(${json(SERVER)}, async () => null);
      rolloutManager.startRefresh();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) child.kill();
    assert.ok(exited, 'the 30-minute refresh keeps a finished process waiting');
  });

  await test('a device that shuts down stops the 30-minute refresh', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const server = fakeServer(rollouts(ON));
    await rolloutManager.load(SERVER, async () => 'token');
    rolloutManager.startRefresh();
    const device = new MCPDevice();
    device.remoteChannel = { stopHeartbeat() {}, unsubscribe: async () => {}, setOffline: async () => {} };
    device.desktop = { shutdown: async () => {} };
    await device.shutdown();
    await wait(30 * MINUTE);
    assert.strictEqual(server.requests.length, 1, 'the device asked for its rollouts again after it shut down');
  });

  // A real device

  await test('a starting device asks for its rollouts after sign-in and before it registers', () => withDevice({
    prepare(standIn) {
      standIn.rollouts = ON;
      // Saved longer ago than an access token lives, so sign-in gets a new
      // one. The stand-in refuses the saved token: only the new one gets an answer.
      return standIn.login({ accessExpiresInSec: -60 });
    },
  }, async (standIn, device) => {
    const order = standIn.requests.map((r) => `${r.method} ${new URL(r.url, standIn.url).pathname}`);
    const signIn = order.findIndex((r) => r.includes(' /auth/v1/'));
    const asked = order.indexOf('GET /device/rollouts');
    const registered = order.indexOf('PATCH /rest/v1/mcp_devices');
    const problems = [];
    if (asked === -1) problems.push('it never asked');
    if (order.filter((r) => r === 'GET /device/rollouts').length > 1) problems.push('it asked more than once');
    if (asked !== -1 && !(signIn !== -1 && signIn < asked)) problems.push('it asked before signing in');
    if (asked !== -1 && registered !== -1 && registered < asked) problems.push('it asked after registering');
    if (json(rolloutLinesOf(device)) !== json(['Rollouts: { check: true }'])) {
      problems.push(`it logged ${json(rolloutLinesOf(device))} where the server had check on`);
    }
    assert.ok(problems.length === 0,
      `${problems.join('; ')}.\n    Requests: ${order.join(', ')}\n    Its output:\n${tail(device.output)}`);
  }));

  await test('a call row the device claims updates its rollouts', () => withDevice({
    standInOptions: { channel: true },
    prepare(standIn) {
      standIn.rollouts = ON;
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
    await waitFor(device, () => call.status === 'completed', CALL_DEADLINE_MS);
    const problems = [];
    if (call.status !== 'completed') problems.push(`it did not run the pending call (its row is ${call.status})`);
    if (json(rolloutLinesOf(device)) !== json(['Rollouts: { check: true }', 'Rollouts: { check: false }'])) {
      problems.push(`it logged ${json(rolloutLinesOf(device))} where the start had check on and the call row had it off`);
    }
    assert.ok(problems.length === 0, `${problems.join('; ')}.\n    Its output:\n${tail(device.output)}`);
  }));

  console.log(`\n${failures.length ? '🔴' : '✅'} device rollouts: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
