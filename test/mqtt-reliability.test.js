#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { connect } from 'mqtt';
import aedes from 'aedes';
import { memoryDatabase } from './mqtt-state-db.js';
// Exercise compiled production classes with local MQTT; auth/database and the local tool
// executor are explicit seams below, so these checks need no cloud credentials or telemetry.
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { RemoteChannel, MAX_CONCURRENT_REMOTE_CALLS } = await import('../dist/remote-device/remote-channel.js');
const { MqttDoorbellReceiver, readMqttConfig, mqttDoorbellTopic } = await import('../dist/remote-device/mqtt-transport.js');
const { MCPDevice } = await import('../dist/remote-device/device.js');
// Yield to the real socket/timer loop when a test deliberately delays an operation.
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
// Fresh durable-row fixture; overrides introduce foreign identity, terminal state or expiry.
const rowFor = (id = 'call-1', patch = {}) => ({ id, user_id: 'user-1', device_id: 'device-1', status: 'pending', tool_name: 'echo', tool_args: {}, timeout_at: new Date(Date.now() + 10000).toISOString(), ...patch });
/** Wire real doorbell/claim/result handling without browser authentication or a child process. */
function makeDevice(db, execute = async () => ({ content: [{ type: 'text', text: 'ok' }] })) {
  const rc = new RemoteChannel();
  Object.assign(rc, { client: db.client('user-1'), _user: { id: 'user-1' }, deviceId: 'device-1' });
  const device = Object.create(MCPDevice.prototype);
  Object.assign(device, { deviceId: 'device-1', remoteChannel: rc, seenCallIds: new Set(), inFlightCallIds: new Set(), desktop: { callClientTool: execute } });
  rc.onToolCall = (payload) => device.handleNewToolCall(payload);
  return { rc, device };
}
/** Wait for an observable asynchronous boundary and fail with its name instead of hanging. */
async function until(fn, label, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!fn() && Date.now() < deadline) await pause();
  assert.ok(fn(), label);
}
/** Real loopback broker; options inject subscription faults while MQTT framing stays real. */
async function localBroker(options = {}) {
  const broker = aedes(options);
  const sockets = new Set();
  const server = createServer(broker.handle);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // close() tears down live sockets before broker shutdown so fault cases cannot leak clients.
  return { broker, url: `mqtt://127.0.0.1:${server.address().port}`, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  } };
}
/** Use production config validation, shortening only network timing for deterministic local runs. */
function configFor(url) {
  const config = readMqttConfig({ MQTT_TRANSPORT_ENABLED: 'true', MQTT_ALLOW_INSECURE_LOCAL: 'true', MQTT_BROKER_URL: url });
  config.options.connectTimeout = 400;
  config.options.reconnectPeriod = 50;
  return config;
}
/** Scope the MQTT opt-in while handleSignedOut() restores prepared credentials. */
async function withMqttEnv(url, run) {
  const values = { MQTT_TRANSPORT_ENABLED: 'true', MQTT_ALLOW_INSECURE_LOCAL: 'true', MQTT_BROKER_URL: url };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await run(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
let passed = 0;
const failures = [];
/** Run each independent scenario and retain failures for one nonzero final test result. */
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
// Stall each database stage with all slots occupied. The decisive check is a fresh call
// completing after aborts, proving recovery rather than merely observing a timeout error.
await check('stalled fetch, claim and terminal writes abort and release all device admission slots', async () => {
  for (const stalledKind of ['read', 'claim', 'write']) {
  const db = memoryDatabase();
  const { rc, device } = makeDevice(db);
  rc.sleep = async () => {};
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  db.before = async (operation) => operation.kind === stalledKind ? stalled : null;
  // Keep production-requested timeout budgets observable but make their real aborts fast.
  const originalTimeout = AbortSignal.timeout;
  const requestedBudgets = [];
  AbortSignal.timeout = (ms) => { requestedBudgets.push(ms); return originalTimeout(Math.min(ms, 40)); };
  const pending = [];
  try {
    for (let index = 0; index < MAX_CONCURRENT_REMOTE_CALLS; index++) {
      const row = rowFor(`stall-${index}`);
      db.calls.set(row.id, row);
      pending.push(rc.onDoorbell({ call_id: row.id, device_id: row.device_id }));
    }
    const completed = await Promise.race([Promise.all(pending).then(() => true), pause(1500).then(() => false)]);
    assert.equal(completed, true, `stalled ${stalledKind} must have an AbortSignal and bounded completion`);
    assert.equal(rc.activeDoorbells.size, 0);
    assert.equal(device.inFlightCallIds.size, 0);
    assert.ok(db.operations.filter((operation) => operation.kind === stalledKind).every((operation) => operation.signal), 'each stalled operation has a deadline');
    assert.ok(requestedBudgets.every((ms) => ms > 0 && ms <= 5000));
    db.before = async () => null;
    db.calls.set('fresh-after-stall', rowFor('fresh-after-stall'));
    await rc.onDoorbell({ call_id: 'fresh-after-stall', device_id: 'device-1' });
    assert.equal(db.calls.get('fresh-after-stall').status, 'completed');
  } finally {
    release(null);
    await Promise.all(pending);
    AbortSignal.timeout = originalTimeout;
  }
  }
});
// Independent in-memory dedupe sets share a database model and varied claim delays.
// One claim/execution, including after a simulated restart, must be decided by row state.
await check('independent device handlers share one atomic claim across repeated adversarial scheduling', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const db = memoryDatabase();
    const row = rowFor(`race-${seed}`);
    db.calls.set(row.id, row);
    db.calls.set('foreign', rowFor('foreign', { user_id: 'user-2' }));
    let claims = 0;
    db.before = async ({ kind }) => { if (kind === 'claim') { claims++; await pause((claims * seed) % 4); } };
    let executions = 0;
    const execute = async () => { executions++; return { content: [{ type: 'text', text: 'once' }] }; };
    const first = makeDevice(db, execute);
    const second = makeDevice(db, execute);
    await Promise.all([first.device.handleNewToolCall({ new: structuredClone(row) }), second.device.handleNewToolCall({ new: structuredClone(row) })]);
    assert.equal(executions, 1, `seed ${seed}`);
    assert.equal(db.writes.filter((write) => write.status === 'executing').length, 1);
    assert.equal(db.calls.get(row.id).status, 'completed');
    const restarted = makeDevice(db, execute);
    await restarted.device.handleNewToolCall({ new: structuredClone(row) });
    assert.equal(executions, 1, 'fresh process dedupe cannot reclaim a terminal database row');
    assert.equal(await first.rc.markCallExecuting('foreign'), false);
    assert.equal(db.calls.get('foreign').status, 'pending');
    assert.equal(first.device.inFlightCallIds.size + second.device.inFlightCallIds.size, 0);
  }
});
// Inject explicit failures at each durable flow stage. Pre-claim faults cannot execute;
// post-claim faults must release capacity even if neither terminal write can be stored.
await check('fetch failures, claim failures, execution failures and result serialization failures release capacity', async () => {
  for (const failure of ['fetch', 'claim', 'execute', 'result', 'both-results']) {
    const db = memoryDatabase();
    const row = rowFor();
    db.calls.set(row.id, row);
    let reads = 0;
    let writes = 0;
    db.before = async ({ kind }) => {
      if (kind === 'read') { reads++; if (failure === 'fetch') return { message: 'read failed' }; }
      if (kind === 'claim' && failure === 'claim') return { message: 'claim failed' };
      if (kind === 'write') { writes++; if (failure === 'both-results' || (failure === 'result' && writes === 1)) return { message: 'result failed' }; }
      return null;
    };
    let executions = 0;
    const { rc, device } = makeDevice(db, async () => { executions++; if (failure === 'execute') throw new Error('tool failed'); return { text: 'ok' }; });
    rc.sleep = async () => {};
    await rc.onDoorbell({ call_id: row.id, device_id: row.device_id });
    assert.equal(rc.activeDoorbells.size + device.inFlightCallIds.size, 0, failure);
    const final = db.calls.get(row.id);
    if (['fetch', 'claim'].includes(failure)) { assert.equal(executions, 0); assert.equal(final.status, 'pending'); }
    else if (failure === 'both-results') { assert.equal(executions, 1); assert.equal(final.status, 'executing'); }
    else { assert.equal(executions, 1); assert.equal(final.status, 'failed'); assert.ok(final.error_message); }
    if (failure === 'fetch') assert.equal(reads, 3, 'existing bounded read retry budget');
    db.before = async () => null;
    const followup = rowFor('fresh');
    db.calls.set(followup.id, followup);
    device.desktop.callClientTool = async () => ({ text: 'fresh-ok' });
    await rc.onDoorbell({ call_id: followup.id, device_id: followup.device_id });
    assert.equal(db.calls.get(followup.id).status, 'completed', 'failure must not wedge later commands');
  }
});
// Hold the row fetch across session change/expiry, or fail its first two attempts.
// Only the recoverable read error may reach the executor; stale admissions must stop after fetch.
await check('transient fetch failure retries, stale generation and expiry after fetch do not execute', async () => {
  for (const scenario of ['retry', 'generation', 'expiry']) {
    const db = memoryDatabase();
    const row = rowFor('call', { timeout_at: new Date(Date.now() + (scenario === 'expiry' ? 40 : 10000)).toISOString() });
    db.calls.set(row.id, row);
    let reads = 0;
    let release;
    db.before = async ({ kind }) => {
      if (kind !== 'read') return null;
      reads++;
      if (scenario === 'retry' && reads < 3) return { message: 'temporary' };
      if (scenario !== 'retry') await new Promise((resolve) => { release = resolve; });
      return null;
    };
    let executions = 0;
    const { rc } = makeDevice(db, async () => { executions++; return {}; });
    rc.sleep = async () => {};
    const running = rc.onDoorbell({ call_id: row.id, device_id: row.device_id });
    if (scenario !== 'retry') {
      await until(() => release, 'fetch waiting');
      if (scenario === 'generation') rc.authGeneration++;
      else await pause(70);
      release();
    }
    await running;
    assert.equal(executions, scenario === 'retry' ? 1 : 0);
    assert.equal(rc.activeDoorbells.size, 0);
  }
});
// Delay the first whole-JSON PATCH and fail the withdrawal behind it. The existing health
// loop must retry the latest mixed flags while retaining unrelated capability fields.
await check('capability write serialization preserves newest mixed flags and retries failed persistence', async () => {
  const db = memoryDatabase();
  db.devices.set('device-1', { id: 'device-1', user_id: 'user-1' });
  const { rc } = makeDevice(db);
  rc.capabilityBase = { unrelated: true };
  let release;
  let attempts = 0;
  db.before = async ({ table }) => {
    if (table !== 'mcp_devices') return null;
    attempts++;
    if (attempts === 1) await new Promise((resolve) => { release = resolve; });
    if (attempts === 2) return { message: 'transient capabilities error' };
    return null;
  };
  rc.mqttReady = true;
  const first = rc.setTransportCapable(true);
  await until(() => release, 'first capability write pending');
  rc.mqttReady = false;
  const second = rc.setTransportCapable(false);
  release();
  await Promise.all([first, second]);
  assert.equal(db.devices.get('device-1').capabilities.transport_mqtt_v1, true, 'failed withdrawal is not falsely reported as persisted');
  rc.checkConnectionHealth();
  await rc.capabilityWriteChain;
  const current = db.devices.get('device-1').capabilities;
  assert.equal(current.transport_mqtt_v1, undefined);
  assert.equal(current.transport_broadcast_v1, undefined);
  assert.equal(current.unrelated, true);
  assert.equal(attempts, 3);
  rc.mqttReady = true;
  await Promise.all([rc.setTransportCapable(true), rc.writeCapabilities()]);
  assert.equal(db.devices.get('device-1').capabilities.transport_mqtt_v1, true);
  assert.equal(db.devices.get('device-1').capabilities.transport_broadcast_v1, true);
});
// Withhold broker authorization until stop() cancels startup, then deliver the late SUBACK.
// No true readiness or second start may resurrect this stopped receiver.
await check('stopping while SUBACK is pending prevents late capability resurrection', async () => {
  let release;
  const local = await localBroker({ authorizeSubscribe(_client, subscription, done) { release = () => done(null, subscription); } });
  const states = [];
  const receiver = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1', async () => {}, async (ready) => states.push(ready));
  try {
    const starting = receiver.start();
    const rejected = assert.rejects(starting, /stopped/);
    await until(() => release, 'SUBACK pending');
    await assert.rejects(receiver.start(), /already/);
    await receiver.stop();
    release();
    await rejected;
    await pause(80);
    assert.ok(!states.includes(true));
    await assert.rejects(receiver.start(), /stopped/);
  } finally { await receiver.stop(); await local.close(); }
});
// Here SUBACK succeeded but durable-readiness work is still pending. Stopping must win
// over that callback's later success and leave both local readiness and client cleared.
await check('stop during successful asynchronous readiness callback cannot resurrect the subscription', async () => {
  const local = await localBroker();
  let release;
  const states = [];
  const receiver = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1', async () => {}, async (ready) => {
    states.push(ready);
    if (ready) await new Promise((resolve) => { release = resolve; });
  });
  try {
    const starting = receiver.start();
    const stopped = assert.rejects(starting, /stopped/);
    await until(() => release, 'ready persistence is pending');
    await receiver.stop();
    release();
    await stopped;
    await pause(50);
    assert.equal(receiver.ready, false);
    assert.equal(receiver.client, null);
    assert.equal(states.at(-1), false);
  } finally { await receiver.stop(); await local.close(); }
});
// Fail startup persistence on one receiver and a delivered callback on another. Startup
// must reject cleanly; an isolated handler failure must not prevent the next wire notification.
await check('receiver contains failed readiness and notification callbacks without unhandled rejection', async () => {
  const unhandled = [];
  // Observe detached EventEmitter callback failures; cleanup removes this process-level probe.
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  const local = await localBroker();
  const rejected = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1', async () => {}, async (ready) => { if (ready) throw new Error('persist failed'); });
  let attempts = 0;
  const accepted = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-2', async () => { attempts++; if (attempts === 1) throw new Error('handler failed'); }, async () => {});
  const publisher = connect(local.url, { reconnectPeriod: 0 });
  try {
    await assert.rejects(rejected.start(), /readiness update failed/);
    assert.equal(rejected.stopped, true);
    await accepted.start();
    await until(() => publisher.connected, 'publisher connected');
    for (let index = 0; index < 2; index++) {
      await new Promise((resolve, reject) => publisher.publish(mqttDoorbellTopic('user-1', 'device-2'), JSON.stringify({ call_id: `call-${index}`, user_id: 'user-1', device_id: 'device-2', expires_at: new Date(Date.now() + 1000).toISOString() }), { qos: 1 }, (error) => error ? reject(error) : resolve()));
    }
    await until(() => attempts === 2, 'second notification survives first rejection');
    assert.deepEqual(unhandled, []);
  } finally { await rejected.stop(); await accepted.stop(); await publisher.endAsync(true); await local.close(); process.off('unhandledRejection', listener); }
});
// Call the production sign-out handler while its auth API double waits. The old receiver
// must stop immediately; only successful refresh without shutdown may create a fresh receiver.
await check('actual SIGNED_OUT stops MQTT and restores only a valid session before rejoining', async () => {
  for (const outcome of ['restored', 'revoked', 'shutdown']) {
    const local = await localBroker();
    try {
      await withMqttEnv(local.url, async () => {
        const db = memoryDatabase();
        db.devices.set('device-1', { id: 'device-1', user_id: 'user-1' });
        const { rc } = makeDevice(db);
        rc.lastKnownSession = { access_token: 'synthetic-test-token', refresh_token: 'synthetic-refresh-token' };
        let release;
        let refreshes = 0;
        // setSession is the controllable await; refreshSession models live versus revoked auth.
        // These synthetic tokens never reach a real Supabase endpoint.
        rc.client.auth = {
          async setSession() { await new Promise((resolve) => { release = resolve; }); return { error: null }; },
          async refreshSession() { refreshes++; return outcome === 'revoked' ? { error: new Error('revoked') } : { data: { session: { access_token: 'synthetic-new-token' } }, error: null }; },
        };
        rc.client.realtime = { disconnect: async () => {} };
        rc.setOffline = async () => {};
        // Model the prepared enrollment cache; recovery must not reread manual environment credentials.
        rc.mqttConfig = { config: configFor(local.url), userId: 'user-1', deviceId: 'device-1' };
        await rc.startMqttTransport(rc.mqttConfig.config);
        const oldReceiver = rc.mqttReceiver;
        const running = rc.handleSignedOut();
        await until(() => release, 'auth restore pending');
        assert.equal(oldReceiver.stopped, true);
        assert.equal(rc.mqttReady, false);
        assert.equal(db.devices.get('device-1').capabilities.transport_mqtt_v1, undefined);
        if (outcome === 'shutdown') rc.shuttingDown = true;
        release();
        await running;
        assert.equal(refreshes, 1);
        if (outcome === 'restored') {
          assert.notEqual(rc.mqttReceiver, oldReceiver);
          assert.equal(rc.mqttReady, true);
          assert.equal(rc.sessionLost, false);
        } else {
          assert.equal(rc.mqttReceiver, null);
          assert.equal(rc.mqttReady, false);
        }
        await rc.stopMqttTransport();
      });
    } finally { await local.close(); }
  }
});
console.log(`MQTT reliability: ${passed} passed, ${failures.length} failed`);
assert.equal(failures.length, 0, failures.join('; '));
