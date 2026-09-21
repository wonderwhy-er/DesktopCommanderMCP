#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import dns from 'node:dns';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import aedes from 'aedes';
import { memoryDatabase } from './mqtt-state-db.js';
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { configManager } = await import('../dist/config-manager.js');
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { MCPDevice } = await import('../dist/remote-device/device.js');
const { DesktopCommanderIntegration } = await import('../dist/remote-device/desktop-commander-integration.js');
const { TransportAnalytics, captureArrival, OBSERVATION_WINDOW_MS, MAX_OBSERVED_CALLS, MAX_BUFFERED_OBSERVATIONS, MAX_TRACKED_NOTIFICATIONS_PER_CALL } = await import('../dist/remote-device/transport-analytics.js');
const { readMqttConfig, mqttDoorbellTopic } = await import('../dist/remote-device/mqtt-transport.js');
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const start = performance.now();
  while (!predicate() && performance.now() - start < 2000) await pause();
  assert.ok(predicate(), 'asynchronous boundary reached');
}
function configured(transport, execution, enrollment) {
  const before = [process.env.MQTT_TRANSPORT_ENABLED, process.env.MQTT_EXECUTION_ENABLED];
  process.env.MQTT_TRANSPORT_ENABLED = transport;
  process.env.MQTT_EXECUTION_ENABLED = execution;
  const channel = new RemoteChannel(enrollment);
  ['MQTT_TRANSPORT_ENABLED', 'MQTT_EXECUTION_ENABLED'].forEach((key, index) => {
    if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index];
  });
  return channel;
}
function setup(transport = 'true', execution = 'false', tool = 'ping') {
  const rc = configured(transport, execution);
  const db = memoryDatabase();
  const row = { id: 'call-1', user_id: 'user-1', device_id: 'device-1', status: 'pending',
    timeout_at: new Date(Date.now() + 60_000).toISOString(), tool_name: tool,
    tool_args: { private_argument: 'must-not-be-in-analytics' } };
  db.calls.set(row.id, row);
  db.devices.set('device-1', { id: 'device-1', user_id: 'user-1' });
  const observations = [];
  const analytics = new TransportAnalytics(async (events) => { observations.push(...structuredClone(events)); });
  Object.assign(rc, { client: db.client('user-1'), _user: { id: 'user-1' }, deviceId: 'device-1', transportAnalytics: analytics });
  const device = Object.create(MCPDevice.prototype);
  Object.assign(device, { remoteChannel: rc, deviceId: 'device-1', seenCallIds: new Set(), inFlightCallIds: new Set() });
  rc.onToolCall = (payload) => device.handleNewToolCall(payload);
  const envelope = { call_id: row.id, device_id: row.device_id, user_id: row.user_id, expires_at: row.timeout_at,
    notification_id: 'attempt-1', attempt_number: 1 };
  return { rc, db, row, device, analytics, observations, envelope };
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('all flags and both arrival orders: inactive source does zero I/O, selected source claims once', async () => {
  for (const enabled of ['false', 'true', '']) for (const execute of ['false', 'true', '']) {
    for (const first of ['mqtt', 'broadcast']) {
      const s = setup(enabled, execute);
      try {
        const selected = enabled === 'true' && execute === 'true' ? 'mqtt' : 'broadcast';
        const inactive = selected === 'mqtt' ? 'broadcast' : 'mqtt';
        await s.rc.onDoorbell(s.envelope, inactive);
        assert.equal(s.db.operations.length, 0, `${enabled}/${execute} inactive fetch/claim`);
        for (const source of [first, first === 'mqtt' ? 'broadcast' : 'mqtt']) {
          await s.rc.onDoorbell(s.envelope, source);
        }
        await s.analytics.flush();
        assert.equal(s.db.operations.filter((op) => op.kind === 'claim').length, 1);
        assert.equal(s.observations.filter((event) => event.stage === 'execution_start').length, 1);
        assert.equal(s.observations.find((event) => event.stage === 'execution_start').transport, selected);
        assert.ok(s.observations.some((event) => event.reason === 'observation_only'));
        assert.ok(s.observations.every((event) => event.call_id === 'call-1'));
        assert.ok(!JSON.stringify(s.observations).includes('must-not-be-in-analytics'));
        const broadcast = s.observations.find((event) => event.transport === 'broadcast');
        assert.equal(broadcast.notification_id, 'call-1:broadcast:1');
      } finally { s.analytics.stop(); }
    }
  }
});

await check('master disabled ignores invalid MQTT config and true execution flag, and flags are startup-only', async () => {
  const rc = configured('false', 'true');
  const config = { url: 'not-a-url', options: {} };
  assert.equal(await rc.prepareMqttConfig(() => { throw new Error('must not validate'); }), null);
  await rc.startMqttTransport(config);
  assert.equal(rc.mqttReceiver, null);
  process.env.MQTT_EXECUTION_ENABLED = 'true';
  assert.equal(rc.mqttExecutionEnabled, false);
  delete process.env.MQTT_EXECUTION_ENABLED;
  rc.transportAnalytics.stop();
});

await check('real MQTT callback observes expired old/new envelopes before rejection, validates correlation strictly', async () => {
  const broker = aedes();
  const sockets = new Set();
  const server = createServer(broker.handle);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const s = setup('true', 'true');
  const config = readMqttConfig({ MQTT_TRANSPORT_ENABLED: 'true', MQTT_ALLOW_INSECURE_LOCAL: 'true', MQTT_BROKER_URL: `mqtt://127.0.0.1:${server.address().port}` });
  const publish = (payload) => new Promise((resolve, reject) => broker.publish({ topic: mqttDoorbellTopic('user-1', 'device-1'), qos: 1, retain: false, payload: Buffer.from(JSON.stringify(payload)) }, (error) => error ? reject(error) : resolve()));
  try {
    await s.rc.startMqttTransport(config);
    const expired = { ...s.envelope, expires_at: new Date(0).toISOString() };
    await publish(expired);
    const old = { ...expired }; delete old.notification_id; delete old.attempt_number;
    await publish(old);
    await until(() => s.analytics.counters.queued >= 4);
    assert.equal(s.db.operations.filter((op) => op.kind === 'read' || op.kind === 'claim').length, 0);
    await publish({ ...expired, attempt_number: 0 });
    await publish({ ...expired, secret: 'reject-extra-key' });
    await publish({ ...expired, user_id: 'foreign' });
    await until(() => s.analytics.counters.malformed === 3);
    await s.analytics.flush();
    assert.equal(s.observations.filter((event) => event.stage === 'received').length, 2);
    assert.equal(s.observations.filter((event) => event.reason === 'expired').length, 2);
    assert.ok(s.observations.every((event) => event.monotonic_ms >= 0));
    assert.ok(s.observations.some((event) => event.notification_id === 'attempt-1'));
    assert.ok(s.observations.some((event) => event.notification_id === 'call-1:mqtt:1'));
    assert.equal(s.db.devices.get('device-1').capabilities.transport_mqtt_observability_v1, true);
  } finally {
    s.analytics.stop(); await s.rc.stopMqttTransport();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

await check('execution_start is after claim and child readiness, and claim loss has no execution event', async () => {
  const s = setup('true', 'true', 'echo');
  const desktop = new DesktopCommanderIntegration();
  s.device.desktop = desktop;
  let ready;
  desktop.ensureReady = () => new Promise((resolve) => { ready = resolve; });
  let executed = 0;
  desktop.mcpClient = { async callTool() { executed++; return {}; } };
  try {
    const running = s.rc.onDoorbell(s.envelope, 'mqtt');
    await until(() => ready);
    await s.analytics.flush();
    assert.equal(executed, 0);
    assert.ok(!s.observations.some((event) => event.stage === 'execution_start'));
    ready(); await running; await s.analytics.flush();
    assert.equal(executed, 1);
    assert.equal(s.observations.filter((event) => event.stage === 'execution_start').length, 1);
    const context = s.observations.find((event) => event.stage === 'execution_start');
    assert.ok(context.duration_ms >= 0);
    s.db.calls.set('call-2', { ...s.row, id: 'call-2', status: 'pending' });
    s.rc.markCallExecuting = async () => false;
    await s.rc.onDoorbell({ ...s.envelope, call_id: 'call-2' }, 'mqtt');
    await s.analytics.flush();
    assert.ok(s.observations.some((event) => event.call_id === 'call-2' && event.reason === 'claim_lost'));
    assert.equal(executed, 1);
  } finally { s.analytics.stop(); }
});

await check('monotonic receipt gap survives wall clock jumps and delayed duplicate telemetry', async () => {
  const events = [];
  const analytics = new TransportAnalytics(async (batch) => { events.push(...batch); });
  try {
    analytics.receipt('call-1', 'broadcast', { monotonic_ms: 100, timestamp_utc: '2030-01-01T00:00:00.000Z' });
    analytics.receipt('call-1', 'mqtt', { monotonic_ms: 135, timestamp_utc: '2020-01-01T00:00:00.000Z' });
    analytics.receipt('call-1', 'mqtt', { monotonic_ms: 180, timestamp_utc: '2020-01-01T00:00:01.000Z' });
    await analytics.flush();
    assert.equal(events[1].arrival_gap_ms, 35);
    assert.equal(events[2].arrival_gap_ms, 35, 'first arrival stays stable');
    assert.equal(events[2].duplicate_count, 1);
    const script = "import {TransportAnalytics,captureArrival} from './dist/remote-device/transport-analytics.js'; const a=new TransportAnalytics(); console.log(a.receipt('call','mqtt',captureArrival()).source_process_id);";
    const other = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
    assert.notEqual(events[0].source_process_id, other, 'new process gets independent monotonic origin');
  } finally { analytics.stop(); }
});

await check('application retry IDs are not duplicates; repeated IDs and identity tracking stay bounded', async () => {
  const analytics = new TransportAnalytics();
  try {
    const time = { monotonic_ms: 100, timestamp_utc: '2026-01-01T00:00:00.000Z' };
    const first = analytics.receipt('call-1', 'mqtt', time, 'send-1', 1);
    const retry = analytics.receipt('call-1', 'mqtt', { ...time, monotonic_ms: 120 }, 'send-2', 2);
    const duplicate = analytics.receipt('call-1', 'mqtt', { ...time, monotonic_ms: 130 }, 'send-2', 2);
    assert.deepEqual([first, retry, duplicate].map((event) => event.duplicate_count), [0, 0, 1]);
    const broadcast = analytics.receipt('call-1', 'broadcast', { ...time, monotonic_ms: 150 });
    assert.equal(broadcast.arrival_gap_ms, -50, 'new attempts do not replace first transport arrival');
    for (let index = 0; index < MAX_TRACKED_NOTIFICATIONS_PER_CALL * 2; index++) {
      analytics.receipt('call-1', 'mqtt', { ...time, monotonic_ms: 160 }, `extra-${index}`, 3);
    }
    assert.equal(analytics.arrivals.get('call-1').notifications.size, MAX_TRACKED_NOTIFICATIONS_PER_CALL);
    analytics.prune(100 + OBSERVATION_WINDOW_MS);
    assert.equal(analytics.counters.tracked, 0, 'per-notification identities expire with call observation');
  } finally { analytics.stop(); }
});

await check('receipt cache and queue are bounded; retry IDs stable; loss counters are reported; stop releases state', async () => {
  const sent = [];
  let fail = true;
  const analytics = new TransportAnalytics(async (events) => { sent.push(events.map((event) => event.observation_id)); if (fail) throw new Error('local collector unavailable'); });
  for (let index = 0; index < MAX_BUFFERED_OBSERVATIONS + 10; index++) {
    analytics.receipt(`call-${index}`, 'mqtt', { monotonic_ms: index, timestamp_utc: '2026-01-01T00:00:00.000Z' });
  }
  assert.equal(analytics.counters.queued, MAX_BUFFERED_OBSERVATIONS);
  assert.equal(analytics.counters.tracked, MAX_OBSERVED_CALLS);
  assert.equal(analytics.counters.dropped, 10);
  await analytics.flush(); await analytics.flush(); await analytics.flush();
  assert.deepEqual(sent[0], sent[1]); assert.deepEqual(sent[1], sent[2]);
  assert.equal(analytics.counters.dropped, 60);
  fail = false;
  analytics.receipt('after-outage', 'broadcast', { monotonic_ms: OBSERVATION_WINDOW_MS + MAX_OBSERVED_CALLS + 10, timestamp_utc: '2026-01-01T00:01:10.000Z' });
  assert.equal(analytics.counters.tracked, 1);
  const recovered = analytics.queue.at(-1);
  assert.equal(recovered.dropped_count, 60);
  assert.equal(recovered.outcome, 'receipt_observed', 'completeness does not overwrite receipt evidence');
  analytics.stop();
  assert.equal(analytics.counters.queued, 0); assert.equal(analytics.counters.tracked, 0);
  assert.equal(analytics.timer, null);
});

await check('identity reset cancels reporting and cannot remove observations of a renewed session', async () => {
  let release;
  let aborted = false;
  const analytics = new TransportAnalytics(async (_events, signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    await new Promise((resolve) => { release = resolve; });
  });
  analytics.receipt('old-call', 'mqtt', captureArrival());
  const sending = analytics.flush();
  analytics.reset();
  analytics.receipt('new-call', 'mqtt', captureArrival());
  release(); await sending;
  assert.ok(aborted);
  assert.equal(analytics.counters.queued, 1);
  assert.equal(analytics.queue[0].call_id, 'new-call');
  analytics.stop();
});

await check('analytics failures do not interrupt execution or expose tool payloads', async () => {
  const s = setup();
  try {
    s.analytics.receipt = () => { throw new Error('injected logging error'); };
    await s.rc.onDoorbell(s.envelope, 'broadcast');
    assert.equal(s.db.calls.get('call-1').status, 'completed');
    assert.equal(s.rc.activeDoorbells.size, 0);
  } finally { s.analytics.stop(); }
});
await check('shadow enrollment/subscription faults preserve Broadcast startup; active MQTT startup fails explicitly', async () => {
  for (const execution of ['false', 'true']) for (const failure of ['enroll', 'subscribe']) {
    const s = setup('true', execution);
    let broadcastStarted = false;
    Object.assign(s.rc, {
      findDevice: async () => ({ id: 'device-1', capabilities: { transport_mqtt_v1: true, transport_mqtt_observability_v1: true } }),
      updateDevice: async (_id, patch) => {
        assert.equal(patch.capabilities.transport_mqtt_v1, undefined);
        assert.equal(patch.capabilities.transport_mqtt_observability_v1, undefined);
      },
      prepareMqttConfig: async () => {
        if (failure === 'enroll') throw new Error('local enrollment outage');
        return { url: 'mqtt://127.0.0.1', options: {} };
      },
      createChannel: async () => { broadcastStarted = true; },
      startMqttTransport: async () => { throw new Error('local subscription outage'); },
    });
    try {
      const start = s.rc.registerDevice({}, 'device-1', 'test', (payload) => s.device.handleNewToolCall(payload));
      if (execution === 'true') await assert.rejects(start, /outage/);
      else {
        await start;
        assert.equal(broadcastStarted, true);
        await s.rc.onDoorbell(s.envelope, 'broadcast');
        assert.equal(s.db.calls.get('call-1').status, 'completed');
      }
    } finally { s.analytics.stop(); }
  }
});

await check('authenticated local relay uses device bearer only, validates partial loss, and tears down timers', async () => {
  let requestBody;
  let authorization;
  const server = createHttpServer(async (request, response) => {
    authorization = request.headers.authorization;
    let body = '';
    for await (const chunk of request) body += chunk;
    requestBody = JSON.parse(body);
    assert.equal(request.url, '/device/transport-observations');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ accepted: 0, dropped: requestBody.observations.length }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const configGet = configManager.getValue;
  configManager.getValue = async () => true;
  const disabled = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  const insecure = process.env.MQTT_ALLOW_INSECURE_LOCAL;
  delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  process.env.MQTT_ALLOW_INSECURE_LOCAL = 'true';
  const rc = configured('false', 'false', { serverUrl: `http://127.0.0.1:${server.address().port}`, profilePath: '/unused' });
  Object.assign(rc, { client: {}, _user: { id: 'user-1' }, deviceId: 'device-1', lastKnownSession: { access_token: 'synthetic-device-token' } });
  try {
    rc.transportAnalytics.receipt('call-1', 'broadcast', captureArrival());
    await rc.transportAnalytics.flush();
    assert.equal(authorization, 'Bearer synthetic-device-token');
    assert.equal(requestBody.device_id, 'device-1');
    assert.equal(requestBody.observations[0].call_id, 'call-1');
    assert.ok(!JSON.stringify(requestBody).includes('synthetic-device-token'));
    assert.equal(rc.transportAnalytics.counters.dropped, 1);
    rc.transportAnalytics.prune(performance.now() + OBSERVATION_WINDOW_MS + 1);
    assert.equal(rc.transportAnalytics.timer, null, 'idle observer expires its timer');
  } finally {
    rc.transportAnalytics.stop();
    configManager.getValue = configGet;
    if (disabled === undefined) delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY; else process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = disabled;
    if (insecure === undefined) delete process.env.MQTT_ALLOW_INSECURE_LOCAL; else process.env.MQTT_ALLOW_INSECURE_LOCAL = insecure;
    await new Promise((resolve) => server.close(resolve));
  }
});
await check('relay supports enrollment local hostnames only with explicit local HTTP opt-in', async () => {
  let requests = 0;
  let lookups = 0;
  const server = createHttpServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, 'Bearer synthetic-device-token');
    let body = '';
    for await (const chunk of request) body += chunk;
    const batch = JSON.parse(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ accepted: batch.observations.length, dropped: 0 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = {
    disabled: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY,
    insecure: process.env.MQTT_ALLOW_INSECURE_LOCAL,
    getValue: configManager.getValue,
    lookup: dns.lookup,
  };
  delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  configManager.getValue = async () => true;
  // DNS is the only simulated seam; HTTP uses the actual allowed URL and local server.
  dns.lookup = (hostname, options, callback) => {
    assert.ok(['mcp.localhost', 'mcp.localhost.localdomain'].includes(hostname));
    lookups++;
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  };
  try {
    for (const [hostname, optIn, allowed] of [
      ['mcp.localhost', 'true', true], ['mcp.localhost.localdomain', 'true', true],
      ['mcp.localhost.localdomain', 'false', false],
      ['mcp.localhost.localdomain.example.test', 'true', false],
      ['remote.example.test', 'true', false],
    ]) {
      process.env.MQTT_ALLOW_INSECURE_LOCAL = optIn;
      const before = requests;
      const rc = configured('false', 'false', {
        serverUrl: `http://${hostname}:${server.address().port}`, profilePath: '/unused',
      });
      Object.assign(rc, { client: {}, _user: { id: 'user-1' }, deviceId: 'device-1',
        lastKnownSession: { access_token: 'synthetic-device-token' } });
      try {
        rc.transportAnalytics.receipt('call-1', 'broadcast', captureArrival());
        await rc.transportAnalytics.flush();
        assert.equal(requests - before, allowed ? 1 : 0, `${hostname}, optIn=${optIn}`);
        assert.equal(rc.transportAnalytics.counters.queued, allowed ? 0 : 1);
      } finally { rc.transportAnalytics.stop(); }
    }
    assert.equal(lookups, 2, 'rejected remote hosts never reach DNS or the network');
  } finally {
    dns.lookup = previous.lookup; configManager.getValue = previous.getValue;
    if (previous.disabled === undefined) delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    else process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = previous.disabled;
    if (previous.insecure === undefined) delete process.env.MQTT_ALLOW_INSECURE_LOCAL;
    else process.env.MQTT_ALLOW_INSECURE_LOCAL = previous.insecure;
    await new Promise((resolve) => server.close(resolve));
  }
});
await check('all existing telemetry opt-out forms suppress transport reporting', async () => {
  const previous = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  const getValue = configManager.getValue;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('must not send'); };
  try {
    for (const flag of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = flag;
      const rc = configured('true', 'false', { serverUrl: 'https://unused.invalid', profilePath: '/unused' });
      rc.transportAnalytics.receipt('call', 'mqtt', captureArrival());
      await rc.transportAnalytics.flush();
      rc.transportAnalytics.stop();
    }
    delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    configManager.getValue = async () => false;
    const rc = configured('true', 'false', { serverUrl: 'https://unused.invalid', profilePath: '/unused' });
    rc.transportAnalytics.receipt('call', 'mqtt', captureArrival());
    await rc.transportAnalytics.flush(); rc.transportAnalytics.stop();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch; configManager.getValue = getValue;
    if (previous === undefined) delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    else process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = previous;
  }
});
await check('old admitted work cannot report under a replacement authentication generation', async () => {
  const s = setup('true', 'true', 'echo');
  let claim;
  s.rc.markCallExecuting = () => new Promise((resolve) => { claim = resolve; });
  try {
    const running = s.rc.onDoorbell(s.envelope, 'mqtt');
    await until(() => claim);
    const oldGeneration = s.rc.authGeneration;
    s.rc.authGeneration++;
    s.analytics.reset();
    const receipt = s.analytics.receipt('new-session-call', 'broadcast', captureArrival());
    s.rc.recordTransportStage(receipt, 'execution_start', undefined, oldGeneration);
    claim(true);
    await running;
    await s.analytics.flush();
    assert.deepEqual(s.observations.map((event) => event.call_id), ['new-session-call']);
  } finally { s.analytics.stop(); }
});
console.log(`PASS ${passed} shadow analytics checks; Node ${process.version}`);
