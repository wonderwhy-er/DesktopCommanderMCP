#!/usr/bin/env node
// Shadow startup and result failure isolation through production handlers, with no network calls.
import assert from 'node:assert/strict';
for (const key of Object.keys(process.env)) if (key.startsWith('MQTT_')) delete process.env[key];
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
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
// Start MQTT once in either mode; only execution mode waits for readiness.
for (const execution of [false, true]) {
    if (execution) process.env.MQTT_EXECUTION_ENABLED = 'true';
    else delete process.env.MQTT_EXECUTION_ENABLED;
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
    assert.equal(f.broadcasts(), execution ? 0 : 1);
    assert.equal(mqtt, 0);
    release({});
    await registration;
    await settle();
    assert.equal(mqtt, 1, 'MQTT starts exactly once in both modes');
    assert.equal(enrollments, 1);
    assert.equal(f.broadcasts(), 1);
}
delete process.env.MQTT_EXECUTION_ENABLED;
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
    const f = fixture();
    f.channel.prepareMqttConfig = async () => { if (failAt === 'enrollment') throw Error('unavailable'); return {}; };
    f.channel.startMqttTransport = async () => { throw Error('unavailable'); };
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    await settle();
    assert.equal(f.broadcasts(), 1);
}
// A failed MQTT capability write must not withdraw healthy Broadcast on cleanup.
{
    const f = fixture();
    const writes = [];
    let failWrite = false;
    f.channel.client = { from: () => ({ update: value => ({ eq: () => ({ abortSignal: async () => {
        if (value.capabilities) writes.push(value.capabilities);
        return { error: failWrite ? { message: 'temporary capability write failure' } : null };
    } }) }) }) };
    assert.equal(await f.channel.setTransportCapable(true), true);
    failWrite = true;
    await assert.rejects(f.channel.setMqttReady(true), /capability could not be saved/);
    failWrite = false;
    await f.channel.setMqttReady(false);
    assert.equal(writes.at(-1).transport_broadcast_v1, true);
    assert.equal(writes.at(-1).transport_mqtt_v1, undefined);
    assert.equal(f.channel.transportCapableWritten, true);
}
// Failed overlapping writes must not leave a queued marker that suppresses recovery.
{
    const f = fixture();
    let failWrite = true;
    let writes = 0;
    f.channel.syncReachabilityStatus = () => {};
    f.channel.client = { from: () => ({ update: () => ({ eq: () => ({ abortSignal: async () => {
        writes++;
        return { error: failWrite ? { message: 'temporary database outage' } : null };
    } }) }) }) };
    const broadcast = f.channel.setTransportCapable(true);
    const mqtt = f.channel.setMqttReady(true);
    await assert.rejects(mqtt, /capability could not be saved/);
    assert.equal(await broadcast, false);
    await f.channel.setMqttReady(false);
    assert.equal(writes, 3);
    failWrite = false;
    assert.equal(await f.channel.setTransportCapable(true), true);
    assert.equal(writes, 4);
    assert.equal(f.channel.transportCapableQueued, null);
}
for (const execution of [false, true]) {
    process.env.MQTT_EXECUTION_ENABLED = String(execution);
    const f = fixture();
    f.channel.mqttReady = true;
    let claims = 0;
    f.channel.onDoorbell = async () => { claims++; };
    const payload = { call_id: 'call', device_id: 'device', user_id: 'owner', expires_at: new Date(Date.now()+60_000).toISOString(), notification_id: 'attempt-id', attempt_number: 2 };
    await f.channel.onMqttDoorbell(payload);
    assert.equal(claims, execution ? 1 : 0);
    await f.channel.onBroadcastDoorbell(payload);
    assert.equal(claims, 1);
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
        assert.deepEqual(args, ['result', 'origin']);
        attempts++;
        throw Error('publish failure');
    } };
    await f.channel.updateCallResult('result', 'completed', {}, null, 'origin');
    await settle();
    assert.equal(writes, 1);
    assert.equal(attempts, 3, 'MQTT retry is bounded and cannot reject a durable result');
    failWrite = true;
    await f.channel.updateCallResult('failed-write', 'failed', null, 'failure', 'origin');
    await settle();
    assert.equal(attempts, 3, 'no notification before successful result persistence');
}
console.log('PASS MQTT shadow: automatic nonblocking startup, failure isolation, exclusive handlers, UTC observations and bounded result retries');
