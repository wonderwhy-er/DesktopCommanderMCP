#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect } from 'mqtt';
import aedes from 'aedes';
// Import compiled production code only after disabling telemetry. MQTT sockets/TLS are real;
// database/auth and most local tool calls below are controlled seams with synthetic identities.
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { MqttDoorbellReceiver, readMqttConfig, mqttDoorbellTopic } = await import('../dist/remote-device/mqtt-transport.js');
const { RemoteChannel, MAX_CONCURRENT_REMOTE_CALLS } = await import('../dist/remote-device/remote-channel.js');
const { MCPDevice } = await import('../dist/remote-device/device.js');
const { DesktopCommanderIntegration } = await import('../dist/remote-device/desktop-commander-integration.js');
// Yield to MQTT/socket callbacks or deliberately cross a tested deadline.
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
/** Poll an observable boundary with a labelled deadline so a broken callback cannot hang QA. */
async function until(fn, label, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!fn() && Date.now() < end) await pause();
  assert.ok(fn(), label);
}
/** Start a real loopback MQTT broker with optional subscription fault hooks. */
async function localBroker(options = {}) {
  const broker = aedes(options);
  const sockets = new Set();
  const server = createServer(broker.handle);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Expose sockets for disconnect injection; close() force-drains them before broker teardown.
  return { broker, sockets, url: `mqtt://127.0.0.1:${server.address().port}`, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  } };
}
/** Exercise the production config parser with shorter test-only startup/reconnect timing. */
const configFor = (url) => {
  const config = readMqttConfig({ MQTT_TRANSPORT_ENABLED: 'true', MQTT_ALLOW_INSECURE_LOCAL: 'true', MQTT_BROKER_URL: url });
  config.options.connectTimeout = 500;
  config.options.reconnectPeriod = 80;
  return config;
};
// Wire fixture: identifiers/deadline only, matching the server's new_call envelope.
const envelope = () => ({ call_id: 'call-1', user_id: 'user-1', device_id: 'device-1', expires_at: new Date(Date.now() + 10000).toISOString() });
// Durable-row fixture: identity/state/deadline overrides exercise validation after retrieval.
const rowFor = (patch = {}) => ({ id: 'call-1', user_id: 'user-1', device_id: 'device-1', status: 'pending', tool_name: 'echo', tool_args: {}, timeout_at: new Date(Date.now() + 10000).toISOString(), ...patch });
/**
 * Record query filters/writes and inject errors at the Supabase boundary. This deliberately
 * returns even foreign rows so production validation is tested; it does not emulate RLS/claims.
 */
function fakeDatabase(row = rowFor()) {
  const writes = [];
  const filters = [];
  let error = null;
  // from() creates one fluent query; methods either record intent or return the selected fixture.
  const client = { from() {
    let patch;
    const chain = {
      select: () => chain, abortSignal: () => chain,
      eq(key, value) { filters.push([key, value]); return chain; }, gt: () => chain,
      update(value) { patch = value; return chain; },
      maybeSingle: async () => ({ data: row, error }),
      // Awaiting a query records its patch and returns the configurable claim/write response.
      // biome-ignore lint/suspicious/noThenProperty: Supabase query doubles must be awaitable.
      then(resolve, reject) {
        if (patch && !error) { writes.push(patch); }
        return Promise.resolve({ data: error ? null : [{ id: row?.id }], error }).then(resolve, reject);
      },
    };
    return chain;
  } };
  // fail() switches subsequent reads/writes between the injected REST error and success.
  return { client, writes, filters, fail(value) { error = value; } };
}
/** Attach a synthetic authenticated registration without touching real session storage. */
function channelFor(db, mqtt = false) {
  const previous = process.env.MQTT_TRANSPORT_ENABLED;
  if (mqtt) process.env.MQTT_TRANSPORT_ENABLED = 'true';
  const rc = new RemoteChannel();
  if (previous === undefined) delete process.env.MQTT_TRANSPORT_ENABLED;
  else process.env.MQTT_TRANSPORT_ENABLED = previous;
  Object.assign(rc, { client: db.client, _user: { id: 'user-1' }, deviceId: 'device-1' });
  return rc;
}
let passed = 0;
/** Count only completed assertions; a rejection stops the script with a nonzero exit. */
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
/** Capture complete console arguments so readiness assertions also reject accidental private context. */
async function withMqttLogs(run) {
  const messages = [];
  const original = { log: console.log, warn: console.warn };
  console.log = (...args) => messages.push(['log', ...args]);
  console.warn = (...args) => messages.push(['warn', ...args]);
  try { await run(messages); }
  finally { console.log = original.log; console.warn = original.warn; }
}
// Legacy opt-out must create no MQTT resources; opt-in must reject insecure/ambiguous URLs.
await check('disabled config needs no broker or credentials and does not create a client', async () => {
  assert.equal(readMqttConfig({}), null);
  const rc = channelFor(fakeDatabase());
  await rc.startMqttTransport(null);
  assert.equal(rc.mqttReceiver, null);
  for (const url of ['mqtt://example.com', 'mqtt://user:pass@localhost', 'mqtt://localhost/path', 'mqtts://localhost', 'http://localhost']) {
    assert.throws(() => readMqttConfig({ MQTT_TRANSPORT_ENABLED: 'true', MQTT_BROKER_URL: url, MQTT_ALLOW_INSECURE_LOCAL: 'true' }));
  }
});
// Delay broker SUBACK, then break real sockets. A connected socket alone must never advertise
// readiness, and reconnect must prove its subscription again before restoring the flag.
await check('readiness waits for SUBACK; disconnect withdraws it, reconnect restores it, stop withdraws it', async () => {
  await withMqttLogs(async (messages) => {
  let release;
  const local = await localBroker({ authorizeSubscribe(_client, subscription, done) { release = () => done(null, subscription); } });
  const states = [];
  const receiver = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1', async () => {}, async (ready) => states.push(ready));
  try {
    const starting = receiver.start();
    // Observe teardown rejection even if an earlier log assertion fails before awaiting startup.
    starting.catch(() => {});
    await until(() => release, 'broker sees subscription');
    assert.deepEqual(states, []);
    assert.deepEqual(messages, [['log', '[MQTT] Connecting to broker:', '127.0.0.1']], 'socket connection alone must not log readiness');
    release();
    await starting;
    assert.equal(states.at(-1), true);
    assert.deepEqual(messages, [
      ['log', '[MQTT] Connecting to broker:', '127.0.0.1'],
      ['log', '[MQTT] Connected and subscribed; ready for tool calls'],
    ]);
    local.broker.authorizeSubscribe = (_client, subscription, done) => done(null, subscription);
    for (const socket of local.sockets) socket.destroy();
    await until(() => states.includes(false), 'connection loss withdraws capability');
    await until(() => messages.length === 4, 'reconnect obtains new SUBACK and logs readiness');
    assert.equal(states.filter(Boolean).length, 2);
  } finally { await receiver.stop(); await local.close(); }
  assert.equal(states.at(-1), false);
  assert.deepEqual(messages, [
    ['log', '[MQTT] Connecting to broker:', '127.0.0.1'],
    ['log', '[MQTT] Connected and subscribed; ready for tool calls'],
    ['warn', '[MQTT] Disconnected; waiting for reconnection'],
    ['log', '[MQTT] Connected and subscribed; ready for tool calls'],
  ], 'intentional stop must not append a disconnect warning');
  });
});
// A broker refusal must reject startup without advertising MQTT readiness.
await check('rejected subscription never advertises MQTT capability', async () => {
  await withMqttLogs(async (messages) => {
  const local = await localBroker({ authorizeSubscribe(_client, _subscription, done) { done(null, null); } });
  const states = [];
  const receiver = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1', async () => {}, async (ready) => states.push(ready));
  try { await assert.rejects(receiver.start(), /subscription refused/); assert.ok(!states.includes(true)); }
  finally { await receiver.stop(); await local.close(); }
  assert.deepEqual(messages, [['log', '[MQTT] Connecting to broker:', '127.0.0.1']], 'refused subscription must not log ready or an established-connection loss');
  });
});
// Deliver adversarial inputs over actual MQTT framing. Zero callbacks until the final valid
// message proves rejection happens at the receiver boundary, before database access.
await check('real wire filters malformed, oversize, missing identity, wrong tenant/device/topic and retained messages; expired arrivals stay observable', async () => {
  const local = await localBroker();
  const delivered = [];
  const topic = mqttDoorbellTopic('user-1', 'device-1');
  const publisher = connect(local.url, { reconnectPeriod: 0 });
  await new Promise((resolve) => publisher.once('connect', resolve));
  // Await broker PUBACK so each injected frame is accepted before checking receiver callbacks.
  const send = (target, data, retain = false) => new Promise((resolve, reject) => publisher.publish(target, typeof data === 'string' ? data : JSON.stringify(data), { qos: 1, retain }, (error) => error ? reject(error) : resolve()));
  // A retained message must be rejected when the subscription later delivers it.
  await send(topic, envelope(), true);
  const receiver = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1', async (payload) => delivered.push(payload), async () => {});
  try {
    await receiver.start();
    const valid = envelope();
    for (const data of ['{', 'x'.repeat(1025), null, [], { ...valid, call_id: undefined }, { ...valid, user_id: 'other-user' }, { ...valid, device_id: 'other-device' }, { ...valid, expires_at: 'tomorrow' }, { ...valid, extra: true }]) await send(topic, data);
    await send(mqttDoorbellTopic('user-2', 'device-1'), valid);
    await send(mqttDoorbellTopic('user-1', 'device-2'), valid);
    await pause(100);
    assert.equal(delivered.length, 0);
    await send(topic, valid);
    await until(() => delivered.length === 1, 'valid targeted notification arrives');
    assert.deepEqual(delivered[0], valid);
    await send(topic, { ...valid, expires_at: new Date(0).toISOString() });
    await until(() => delivered.length === 2, 'expired valid envelope reaches receipt observer');
  } finally { await receiver.stop(); await publisher.endAsync(true); await local.close(); }
});
// Valid JSON plus ASCII whitespace isolates the byte limit from JSON/schema validation.
await check('wire payload accepts 1023/1024 bytes and rejects 1025 bytes and 16 KiB', async () => {
  const local = await localBroker();
  const delivered = [];
  const topic = mqttDoorbellTopic('user-1', 'device-1');
  const receiver = new MqttDoorbellReceiver(configFor(local.url), 'user-1', 'device-1',
    async (payload) => delivered.push(payload.call_id), async () => {});
  try {
    await receiver.start();
    for (const size of [1023, 1025, 16 * 1024, 1024]) {
      const valid = { ...envelope(), call_id: `size-${size}` };
      const json = JSON.stringify(valid);
      const payload = Buffer.from(json + ' '.repeat(size - Buffer.byteLength(json)));
      assert.equal(payload.length, size);
      assert.deepEqual(JSON.parse(payload), valid);
      await new Promise((resolve, reject) => local.broker.publish({
        topic, qos: 1, retain: false, payload,
      }, (error) => error ? reject(error) : resolve()));
    }
    // Same-topic QoS1 delivery is ordered; the last valid message is our processing barrier.
    await until(() => delivered.includes('size-1024'), 'exactly 1024 bytes reaches the handler');
    assert.deepEqual(delivered, ['size-1023', 'size-1024']);
  } finally { await receiver.stop(); await local.close(); }
});
// The database stub intentionally returns invalid rows despite recorded filters. Delivery
// must still stop, and an MQTT envelope cannot extend the independently stored deadline.
await check('row identity, state and deadline are rechecked after fetch', async () => {
  for (const patch of [{ user_id: 'other' }, { device_id: 'other' }, { status: 'completed' }, { timeout_at: new Date(0).toISOString() }, { timeout_at: 'invalid' }]) {
    const db = fakeDatabase(rowFor(patch));
    const rc = channelFor(db);
    let delivered = 0;
    rc.onToolCall = () => delivered++;
    await rc.onDoorbell({ call_id: 'call-1', device_id: 'device-1' });
    assert.equal(delivered, 0);
  }
  const row = rowFor({ timeout_at: new Date(Date.now() + 10000).toISOString().replace('Z', '+00:00') });
  const db = fakeDatabase(row);
  const rc = channelFor(db);
  let delivered = 0;
  rc.onToolCall = () => delivered++;
  await rc.onDoorbell({ ...envelope(), expires_at: new Date(Date.now() + 20000).toISOString() });
  assert.equal(delivered, 0, 'envelope cannot extend persisted deadline');
  await rc.onDoorbell({ ...envelope(), expires_at: new Date(row.timeout_at).toISOString() });
  assert.equal(delivered, 1);
  assert.ok(db.filters.some(([key, value]) => key === 'user_id' && value === 'user-1'));
  assert.ok(db.filters.some(([key, value]) => key === 'device_id' && value === 'device-1'));
});
// An ambiguous claim error cannot authorize execution. Once the seam recovers, concurrent
// same-process deliveries must occupy one local slot and call the executor once.
await check('DB claim failure never executes; later safe retry and simultaneous duplicates execute once', async () => {
  const db = fakeDatabase();
  const rc = channelFor(db);
  const device = Object.create(MCPDevice.prototype);
  let executions = 0;
  Object.assign(device, { deviceId: 'device-1', remoteChannel: rc, seenCallIds: new Set(), inFlightCallIds: new Set(), desktop: { async callClientTool() { executions++; await pause(); return {}; } } });
  rc.updateCallResult = async () => {};
  rc.notifyResult = async () => {};
  db.fail({ message: 'injected' });
  await device.handleNewToolCall({ new: rowFor() });
  assert.equal(executions, 0);
  assert.equal(device.inFlightCallIds.size, 0);
  db.fail(null);
  await Promise.all([device.handleNewToolCall({ new: rowFor() }), device.handleNewToolCall({ new: rowFor() })]);
  assert.equal(executions, 1);
  await device.handleNewToolCall({ new: rowFor() });
  assert.equal(executions, 1);
});
// Exercise the actual RemoteChannel wrapper, rather than passing a handler directly to a receiver.
await check('RemoteChannel forwards rejected handling promises without crashing MQTT delivery', async () => {
  const local = await localBroker();
  const rc = channelFor(fakeDatabase(), true);
  const handled = [];
  rc.onDoorbell = async (payload) => {
    handled.push(payload.call_id);
    if (payload.call_id === 'rejected') throw new Error('injected doorbell rejection');
  };
  try {
    await rc.startMqttTransport(configFor(local.url));
    for (const callId of ['rejected', 'after-rejection']) {
      // Real MQTT delivery traverses RemoteChannel's logging wrapper, including its promise return.
      await new Promise((resolve, reject) => local.broker.publish({
        topic: mqttDoorbellTopic('user-1', 'device-1'), qos: 1, retain: false,
        payload: Buffer.from(JSON.stringify({ ...envelope(), call_id: callId })),
      }, (error) => error ? reject(error) : resolve()));
      await until(() => handled.includes(callId), 'wrapper remains usable after rejected handling');
    }
    assert.deepEqual(handled, ['rejected', 'after-rejection']);
  } finally { await rc.stopMqttTransport(); await local.close(); }
});

// Real SUBACK/stop callbacks produce whole-JSON writes; adding/removing MQTT must preserve
// independently proven broadcast readiness and unrelated application capabilities.
await check('MQTT capability writes preserve broadcast and unrelated capability fields', async () => {
  const local = await localBroker();
  const db = fakeDatabase();
  const rc = channelFor(db, true);
  rc.capabilityBase = { app_feature: true };
  rc.broadcastReady = true;
  try {
    await rc.startMqttTransport(configFor(local.url));
    assert.equal(db.writes.at(-1).capabilities.transport_mqtt_v1, true);
    assert.equal(db.writes.at(-1).capabilities.transport_broadcast_v1, true);
    assert.equal(db.writes.at(-1).capabilities.app_feature, true);
    await rc.stopMqttTransport();
    assert.equal(db.writes.at(-1).capabilities.transport_mqtt_v1, undefined);
    assert.equal(db.writes.at(-1).capabilities.transport_broadcast_v1, true);
    assert.equal(db.writes.at(-1).capabilities.app_feature, true);
  } finally { await rc.stopMqttTransport(); await local.close(); }
});
// Hold a successful claim response across each invalidation boundary. Even a winning claim
// must not execute after sign-out, shutdown, deadline expiry or same-identity session restoration.
await check('signout, shutdown and expiry during a successful claim prevent execution', async () => {
  for (const interruption of ['handlingSignedOut', 'shuttingDown', 'expired', 'restored-session']) {
    const db = fakeDatabase();
    const rc = channelFor(db);
    let release;
    rc.markCallExecuting = () => new Promise((resolve) => { release = resolve; });
    rc.updateCallResult = async () => {};
    rc.notifyResult = async () => {};
    let executions = 0;
    const device = Object.create(MCPDevice.prototype);
    Object.assign(device, { deviceId: 'device-1', remoteChannel: rc, seenCallIds: new Set(), inFlightCallIds: new Set(), desktop: { async callClientTool() { executions++; return {}; } } });
    const row = rowFor({ timeout_at: new Date(Date.now() + (interruption === 'expired' ? 40 : 10000)).toISOString() });
    const running = device.handleNewToolCall({ new: row });
    await until(() => release, 'claim is waiting');
    if (interruption === 'expired') await pause(70);
    else if (interruption === 'restored-session') rc.authGeneration++;
    else rc[interruption] = true;
    release(true);
    await running;
    assert.equal(executions, 0, interruption);
    assert.equal(device.inFlightCallIds.size, 0);
  }
});
// Separate fetch and execution gates prove the 32-slot cap covers both phases. Repeated ids
// use one slot before I/O; overflow is not queued, and handler errors release admission.
await check('duplicate flood is coalesced before fetch and distinct work is bounded through execution', async () => {
  const rc = channelFor(fakeDatabase());
  let fetches = 0;
  let releaseFetches;
  const fetchGate = new Promise((resolve) => { releaseFetches = resolve; });
  const executions = [];
  const releases = [];
  // This query seam pauses real RemoteChannel work before returning the requested call id.
  rc.client = { from() {
    let callId;
    const chain = {
      select: () => chain, abortSignal: () => chain,
      eq(key, value) { if (key === 'id') callId = value; return chain; },
      async maybeSingle() { fetches++; await fetchGate; return { data: rowFor({ id: callId }), error: null }; },
    };
    return chain;
  } };
  rc.onToolCall = (payload) => { executions.push(payload.new.id); return new Promise((resolve) => releases.push(resolve)); };
  const pending = Array.from({ length: 100 }, () => rc.onDoorbell({ call_id: 'same', device_id: 'device-1' }));
  pending.push(...Array.from({ length: 100 }, (_, index) => rc.onDoorbell({ call_id: `distinct-${index}`, device_id: 'device-1' })));
  assert.equal(fetches, MAX_CONCURRENT_REMOTE_CALLS);
  assert.equal(rc.activeDoorbells.size, MAX_CONCURRENT_REMOTE_CALLS);
  releaseFetches();
  await until(() => executions.length === MAX_CONCURRENT_REMOTE_CALLS, 'bounded executions start');
  assert.equal(executions.filter((id) => id === 'same').length, 1);
  assert.equal(rc.activeDoorbells.size, MAX_CONCURRENT_REMOTE_CALLS);
  releases.forEach((resolve) => { resolve(); });
  await Promise.all(pending);
  assert.equal(rc.activeDoorbells.size, 0);
  rc.onToolCall = async () => { throw new Error('injected handler error'); };
  await rc.onDoorbell({ call_id: 'after-error', device_id: 'device-1' });
  assert.equal(rc.activeDoorbells.size, 0);
});
// One temporary self-signed test identity is trusted on both local TLS sides. Removing only
// the client's CA trust must prevent readiness; this exercises TLS, not AWS policy evaluation.
await check('receiver connects with verified mutual TLS and refuses an untrusted broker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mqtt-device-tls-'));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = await readFile(certFile);
  const key = await readFile(keyFile);
  const broker = aedes();
  const sockets = new Set();
  const server = createTlsServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, broker.handle);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { MQTT_TRANSPORT_ENABLED: 'true', MQTT_BROKER_URL: `mqtts://127.0.0.1:${server.address().port}`, MQTT_CERT_FILE: certFile, MQTT_KEY_FILE: keyFile, MQTT_CA_FILE: certFile };
  const accepted = [];
  const rejected = [];
  const config = readMqttConfig(env);
  config.options.connectTimeout = 300;
  config.options.reconnectPeriod = 0;
  const valid = new MqttDoorbellReceiver(config, 'user-1', 'device-1', async () => {}, async (ready) => accepted.push(ready));
  const invalidConfig = readMqttConfig({ ...env, MQTT_CA_FILE: undefined });
  invalidConfig.options.connectTimeout = 300;
  invalidConfig.options.reconnectPeriod = 0;
  const invalid = new MqttDoorbellReceiver(invalidConfig, 'user-1', 'device-2', async () => {}, async (ready) => rejected.push(ready));
  try {
    await valid.start();
    assert.deepEqual(accepted, [true]);
    await assert.rejects(invalid.start(), /timed out/);
    assert.ok(!rejected.includes(true));
  } finally {
    await valid.stop();
    await invalid.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
// Keep the production SDK adapter but pause ensureReady at the child-restart seam. If admission
// expires while it waits, callTool must never be invoked and MCPDevice must report failure.
await check('auth and deadline are rechecked after local MCP restart before sending a tool', async () => {
  for (const interruption of ['signout', 'expired', 'restored-session']) {
    const rc = channelFor(fakeDatabase());
    rc.markCallExecuting = async () => true;
    const results = [];
    rc.updateCallResult = async (_callId, status) => { results.push(status); };
    rc.notifyResult = async () => {};
    let release;
    let calls = 0;
    const desktop = new DesktopCommanderIntegration();
    desktop.ensureReady = () => new Promise((resolve) => { release = resolve; });
    desktop.mcpClient = { async callTool() { calls++; return {}; } };
    const device = Object.create(MCPDevice.prototype);
    Object.assign(device, { deviceId: 'device-1', remoteChannel: rc, seenCallIds: new Set(), inFlightCallIds: new Set(), desktop });
    const row = rowFor({ timeout_at: new Date(Date.now() + (interruption === 'expired' ? 40 : 10000)).toISOString() });
    const running = device.handleNewToolCall({ new: row });
    await until(() => release, 'local MCP restart is waiting');
    if (interruption === 'expired') await pause(70);
    else if (interruption === 'restored-session') rc.authGeneration++;
    else rc.handlingSignedOut = true;
    release();
    await running;
    assert.equal(calls, 0, interruption);
    assert.deepEqual(results, ['failed']);
  }
});
// Constructor-only check: select the isolated profile path without invoking startup/auth I/O.
// Restore environment and newly installed signal handlers so later checks inherit no test state.
await check('local profile override is selected without reading or writing credentials', async () => {
  const saved = process.env.MCP_DEVICE_CONFIG_PATH;
  const signals = ['SIGINT', 'SIGTERM'];
  const before = signals.map((signal) => process.listeners(signal));
  try {
    process.env.MCP_DEVICE_CONFIG_PATH = '/tmp/mqtt-test-profile/device.json';
    const device = new MCPDevice({ persistSession: false });
    assert.equal(device.configPath, process.env.MCP_DEVICE_CONFIG_PATH);
  } finally {
    if (saved === undefined) delete process.env.MCP_DEVICE_CONFIG_PATH;
    else process.env.MCP_DEVICE_CONFIG_PATH = saved;
    signals.forEach((signal, index) => { for (const listener of process.listeners(signal)) if (!before[index].includes(listener)) process.off(signal, listener); });
  }
});
console.log(`PASS ${passed} MQTT device checks; Node ${process.version}`);
