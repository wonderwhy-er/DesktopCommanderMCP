#!/usr/bin/env node
// Shadow startup and result failure isolation through production handlers, with no network calls.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
for (const key of Object.keys(process.env)) if (key.startsWith('MQTT_')) delete process.env[key];
// Old environment flags must not override the user's rollout values.
process.env.IS_MQTT_EXECUTION_ENABLED = 'true';
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { rolloutManager } = await import('../dist/remote-device/rollouts.js');
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { MqttTransport } = await import('../dist/remote-device/mqtt/mqtt-transport.js');
const { observeTransport } = await import('../dist/remote-device/transport-telemetry.js');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
    const channel = new RemoteChannel();
    let broadcasts = 0;
    Object.assign(channel, {
        _user: { id: 'owner' }, client: {}, deviceId: 'device',
        findDevice: async () => ({ id: 'device' }), updateDevice: async () => ({ error: null }),
        createChannel: async () => { broadcasts++; },
    });
    return { channel, broadcasts: () => broadcasts };
}
// Cached execution state cannot hold Broadcast startup behind MQTT enrollment.
for (const execution of [undefined, false, true]) {
    rolloutManager.update(execution === undefined ? {} : { IS_MQTT_EXECUTION_ENABLED: execution });
    const f = fixture();
    let release;
    let enrollments = 0;
    let mqtt = 0;
    f.channel.prepareMqttConfig = () => {
        enrollments++;
        return new Promise(resolve => { release = resolve; });
    };
    f.channel.startMqttTransport = async () => { mqtt++; };
    const registration = f.channel.registerDevice({}, 'device', 'fixture', () => {});
    await settle();
    assert.equal(enrollments, 1);
    assert.equal(f.broadcasts(), 1);
    assert.equal(mqtt, 0);
    await registration;
    release({});
    await settle();
    assert.equal(mqtt, 1, 'MQTT starts exactly once in both modes');
    assert.equal(enrollments, 1);
    assert.equal(f.broadcasts(), 1);
}
rolloutManager.update({});
// A transient initial Broadcast join failure must not permanently skip shadow startup.
{
    const f = fixture();
    let mqtt = 0;
    f.channel.createChannel = async () => { throw Error('initial Broadcast join failed'); };
    f.channel.prepareMqttConfig = async () => ({});
    f.channel.startMqttTransport = async () => { mqtt++; };
    await assert.rejects(f.channel.registerDevice({}, 'device', 'fixture', () => {}), /Broadcast join failed/);
    await settle();
    assert.equal(mqtt, 1);
}
for (const failAt of ['enrollment', 'broker']) {
    rolloutManager.update({ IS_MQTT_EXECUTION_ENABLED: true });
    const f = fixture();
    f.channel.prepareMqttConfig = async () => { if (failAt === 'enrollment') throw Error('unavailable'); return {}; };
    f.channel.startMqttTransport = async () => { throw Error('unavailable'); };
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    await settle();
    assert.equal(f.broadcasts(), 1);
}
// A failed MQTT capability write must not withdraw healthy Broadcast on cleanup.
for (const failure of ['response', 'rejection']) {
    const f = fixture();
    const writes = [];
    let failWrite = true;
    Object.assign(f.channel, { channel: { state: 'joined' }, channelReady: true });
    f.channel.client = { from: () => ({ update: value => ({ eq: () => ({ abortSignal: async () => {
        assert.deepEqual(Object.keys(value), ['capabilities'], 'MQTT must not change Broadcast status');
        writes.push(value.capabilities);
        if (failWrite && failure === 'rejection') throw Error('temporary capability write failure');
        return { error: failWrite ? { message: 'temporary capability write failure' } : null };
    } }) }) }) };
    await assert.rejects(f.channel.setMqttReady(true), /capability could not be saved/);
    await assert.doesNotReject(f.channel.setMqttReady(false), 'failed cleanup must not stop Broadcast');
    assert.equal(writes.at(-1).transport_mqtt_v1, undefined);
    assert.equal(f.channel.isReachable(), true);
    failWrite = false;
    await f.channel.setMqttReady(true);
    assert.equal(writes.at(-1).transport_mqtt_v1, true, 'failed writes must not poison the queue');
    assert.ok(writes.every(value => value.app_version === writes[0].app_version && value.app_version));
}
// Overlapping readiness transitions persist their snapshots in order.
{
    const f = fixture();
    const writes = [];
    let release;
    f.channel.client = { from: () => ({ update: value => ({ eq: (key, id) => ({ abortSignal: async signal => {
        assert.equal(key, 'id');
        assert.equal(id, 'device');
        assert.ok(signal instanceof AbortSignal, 'capability writes must have a deadline');
        writes.push(value.capabilities.transport_mqtt_v1);
        if (writes.length === 1) await new Promise(resolve => { release = resolve; });
        return { error: null };
    } }) }) }) };
    const ready = f.channel.setMqttReady(true);
    const disconnected = f.channel.setMqttReady(false);
    const reconnected = f.channel.setMqttReady(true);
    await settle();
    assert.deepEqual(writes, [true], 'later writes must wait for the first to finish');
    release();
    await Promise.all([ready, disconnected, reconnected]);
    assert.deepEqual(writes, [true, undefined, true]);
}
// Queued readiness must not publish after shutdown or an auth session change.
for (const property of ['shuttingDown', 'sessionLost', 'authGeneration']) {
    const f = fixture();
    let writes = 0;
    f.channel.client = { from: () => { writes++; throw Error('unexpected write'); } };
    const ready = f.channel.setMqttReady(true);
    f.channel[property] = property === 'authGeneration' ? 1 : true;
    await assert.rejects(ready, /capability could not be saved/);
    assert.equal(writes, 0);
}
for (const execution of [undefined, false, true, false]) {
    rolloutManager.update(execution === undefined ? {} : { IS_MQTT_EXECUTION_ENABLED: execution });
    const f = fixture();
    f.channel.mqttReady = true;
    const sources = [];
    f.channel.onDoorbell = async (_payload, source = 'broadcast') => { sources.push(source); };
    const payload = { call_id: 'call', device_id: 'device', user_id: 'owner' };
    for (const enabled of [undefined, false, true]) {
        const before = sources.length;
        await f.channel.onMqttDoorbell({ ...payload, ...(enabled === undefined ? {} : { IS_MQTT_EXECUTION_ENABLED: enabled }) });
        assert.deepEqual(sources.slice(before), [], 'MQTT remains observation-only for every packet flag and cached rollout');
    }
    await f.channel.onBroadcastDoorbell(payload);
    assert.equal(sources.at(-1), 'broadcast');
    Object.assign(f.channel, { channel: { state: 'joined' }, channelReady: true, mqttReady: false });
    assert.equal(f.channel.isReachable(), true, 'cached execution cannot withdraw healthy Broadcast');
    const observation = observeTransport({ stage: 'received', payload, deviceId: 'device', userId: 'owner', transport: 'mqtt' });
    assert.equal('notification_id' in observation, false);
    assert.equal('attempt_number' in observation, false);
    assert.equal('monotonic_ms' in observation, false);
    assert.ok(Number.isFinite(Date.parse(observation.timestamp_utc)));
    let attempts = 0;
    let writes = 0;
    let failWrite = false;
    f.channel.client = { from: () => ({ update: () => ({ eq: async () => { writes++; return { error: failWrite ? { message: 'write failure' } : null }; } }) }) };
    f.channel.sleep = async () => {};
    f.channel.mqttReceiver = { publishResult: async (...args) => {
        assert.equal(writes, 1, 'persist the terminal result before notifying the backend');
        assert.deepEqual(args, ['result', 'origin']);
        attempts++;
        throw Error('publish failure');
    } };
    await f.channel.updateCallResult('result', 'completed', {}, null, 'origin', { IS_MQTT_EXECUTION_ENABLED: true });
    await settle();
    assert.equal(writes, 1);
    assert.equal(attempts, 3, 'MQTT retry is bounded and cannot reject a durable result');
    failWrite = true;
    await f.channel.updateCallResult('failed-write', 'failed', null, 'failure', 'origin');
    await settle();
    assert.equal(attempts, 3, 'no notification before successful result persistence');
}
{
    const transport = new MqttTransport({}, 'owner', 'device', async () => {}, async () => {});
    let published;
    transport.client = Object.assign(new EventEmitter(), {
        connected: true,
        publish(_topic, payload, _options, done) { published = JSON.parse(payload.toString()); done(); },
    });
    transport.ready = true;
    await transport.publishResult('call', 'origin');
    assert.deepEqual(published, { call_id: 'call' });
}
rolloutManager.update({});
console.log('PASS MQTT shadow: observation-only packets, identifier-only results and retries, cache-independent readiness, startup, failure isolation and UTC observations');
