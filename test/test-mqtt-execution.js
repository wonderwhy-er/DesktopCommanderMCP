#!/usr/bin/env node
// Three modes, set by two rollouts. Transport off: Broadcast only. Transport on, execution off:
// Broadcast runs the call and MQTT only observes. Transport and execution on: MQTT runs the call and
// Broadcast only observes (no takeover when MQTT is down).
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { waitUntil } from './helpers/wait.js';
import { doorbell, makeChannel } from './helpers/remote-calls-table.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { rolloutManager } = await import('../dist/remote-device/rollouts.js');
const { configManager } = await import('../dist/config-manager.js');

const setMqttTransport = enabled => rolloutManager.update({ MQTT_TRANSPORT_ENABLED: enabled });
afterEach(() => rolloutManager.update({}));

const setFlags = (transport, execution) =>
    rolloutManager.update({ MQTT_TRANSPORT_ENABLED: transport, MQTT_ON_DEVICE_EXECUTION_ENABLED: execution });

test('execution off: an MQTT doorbell is only observed and Broadcast runs the call', async () => {
    setFlags(true, false);
    const fixture = makeChannel(RemoteChannel, ['call-off']);
    await fixture.channel.onMqttDoorbell(doorbell('call-off'));
    assert.deepEqual(fixture.table.claimRequests, [], 'MQTT does not claim');
    await fixture.channel.onBroadcastDoorbell(doorbell('call-off'));
    assert.deepEqual(fixture.delivered, ['call-off']);
});

test('execution on: a Broadcast doorbell is only observed and MQTT runs the call', async () => {
    setFlags(true, true);
    const fixture = makeChannel(RemoteChannel, ['call-on']);
    await fixture.channel.onBroadcastDoorbell(doorbell('call-on'));
    assert.deepEqual(fixture.table.claimRequests, [], 'Broadcast does not claim');
    assert.equal(fixture.rows[0].status, 'pending');
    await fixture.channel.onMqttDoorbell(doorbell('call-on'));
    assert.deepEqual(fixture.delivered, ['call-on']);
    assert.equal(fixture.rows[0].status, 'executing');
});

test('execution on, MQTT down: Broadcast still only observes (no takeover)', async () => {
    setFlags(true, true);
    const fixture = makeChannel(RemoteChannel, ['call-mqtt-down']);
    fixture.channel.mqttReady = false;
    await fixture.channel.onBroadcastDoorbell(doorbell('call-mqtt-down'));
    assert.deepEqual(fixture.table.claimRequests, []);
});

test('execution on with transport off: Broadcast keeps running calls', async () => {
    setFlags(false, true);
    const fixture = makeChannel(RemoteChannel, ['call-transport-off']);
    await fixture.channel.onBroadcastDoorbell(doorbell('call-transport-off'));
    assert.deepEqual(fixture.delivered, ['call-transport-off']);
});

test('execution on: the doorbell field cannot override the rollout', async () => {
    setFlags(true, false);
    const fixture = makeChannel(RemoteChannel, ['call-field']);
    await fixture.channel.onMqttDoorbell({ ...doorbell('call-field'), IS_MQTT_EXECUTION_ENABLED: true });
    assert.deepEqual(fixture.table.claimRequests, []);
});

test('if MQTT and Broadcast both ring with execution on, MQTT runs the call once', async () => {
    setFlags(true, true);
    const fixture = makeChannel(RemoteChannel, ['call-both']);
    await Promise.all([
        fixture.channel.onMqttDoorbell(doorbell('call-both')),
        fixture.channel.onBroadcastDoorbell(doorbell('call-both')),
    ]);
    assert.deepEqual(fixture.delivered, ['call-both']);
});

test('in shadow mode a fresh MQTT subscription can scan while Broadcast is ready', async () => {
    setFlags(true, false);
    const fixture = makeChannel(RemoteChannel, ['missed-1', 'missed-2']);
    fixture.channel.recoverAfterMqttChange('after MQTT connected');
    await waitUntil(() => fixture.delivered.length === 2, 10_000, 'both missed calls are delivered');
    assert.deepEqual(fixture.delivered, ['missed-1', 'missed-2']);
});

test('MQTT retries ten times at 10 seconds, then every 5 minutes until it recovers', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    setMqttTransport(true);
    const { channel } = makeChannel(RemoteChannel, []);
    let starts = 0;
    let brokerAvailable = false;
    channel.prepareMqttConfig = async () => ({});
    channel.startMqttTransport = async () => {
        starts++;
        if (!brokerAvailable) throw new Error('broker down');
        channel.mqttReceiver = { stop: async () => {} };
    };
    async function expectRetryAfter(delayMs) {
        const before = starts;
        t.mock.timers.tick(delayMs - 1); // Just before the retry deadline, no new attempt should have started.
        await channel.mqttLifecycle;
        assert.equal(starts, before, `retry ${before} started before ${delayMs} ms`);
        t.mock.timers.tick(1); // Reach the deadline exactly.
        await channel.mqttLifecycle;
        assert.equal(starts, before + 1, `retry ${before} should start at ${delayMs} ms`);
    }

    await channel.updateMqttTransport(true);
    assert.equal(starts, 1, 'the initial connection starts immediately');
    for (let retry = 1; retry <= 10; retry++) { // The MQTT retry policy allows ten fast retries after the initial failure.
        await expectRetryAfter(10_000); // The fast retry interval is ten seconds.
    }
    const startsBeforeRefresh = starts;
    await channel.updateMqttTransport(true);
    assert.equal(starts, startsBeforeRefresh, 'another request to start MQTT respects the pending five-minute wait');
    await expectRetryAfter(300_000); // Five minutes between attempts during a prolonged outage.
    brokerAvailable = true;
    await expectRetryAfter(300_000); // The device can still recover on a later five-minute retry.
    assert.equal(channel.mqttRestartTimer, null);

    brokerAvailable = false;
    await channel.onMqttReceiverFailed(channel.mqttReceiver);
    await expectRetryAfter(10_000); // A fresh outage after a successful connection starts with the ten-second interval.
    setMqttTransport(false);
    const startsBeforeDisable = starts;
    await channel.updateMqttTransport(false);
    t.mock.timers.tick(300_000);
    await channel.mqttLifecycle;
    assert.equal(starts, startsBeforeDisable, 'disabling MQTT cancels the pending retry');
});

test('a receiver that stopped itself is replaced; a failure from an old receiver is ignored', async () => {
    setMqttTransport(true);
    const fixture = makeChannel(RemoteChannel, []);
    const current = { stop: async () => {} };
    fixture.channel.mqttReceiver = current;
    await fixture.channel.onMqttReceiverFailed({ stop: async () => {} });
    assert.equal(fixture.channel.mqttReceiver, current, 'an old receiver changes nothing');
    assert.equal(fixture.channel.mqttRestartTimer, null);

    await fixture.channel.onMqttReceiverFailed(current);
    assert.equal(fixture.channel.mqttReceiver, null, 'the broken receiver is removed');
    assert.ok(fixture.channel.mqttRestartTimer, 'a restart is planned');
    clearTimeout(fixture.channel.mqttRestartTimer);
});

const broadcastDown = fixture => Object.assign(fixture.channel, { channel: { state: 'errored' }, channelReady: false });

test('when MQTT runs calls, a ready MQTT connection can recover calls with Broadcast down', async () => {
    setFlags(true, true);
    const fixture = makeChannel(RemoteChannel, ['mqtt-only-1', 'mqtt-only-2']);
    broadcastDown(fixture);
    fixture.channel.mqttReady = true;
    fixture.channel.recoverAfterMqttChange('after MQTT connected');
    await waitUntil(() => fixture.delivered.length === 2, 10_000, 'both calls are delivered over MQTT alone');
});

test('when MQTT runs calls, a ready Broadcast connection cannot recover calls while MQTT is down', async () => {
    setFlags(true, true);
    const fixture = makeChannel(RemoteChannel, ['blocked']);
    fixture.channel.mqttReady = false;
    await fixture.channel.recoverPendingCalls();
    assert.deepEqual(fixture.table.scans, []);
});

test('when Broadcast runs calls, a ready MQTT connection cannot recover calls while Broadcast is down', async () => {
    for (const [transport, execution] of [[true, false], [false, true], [false, false]]) {
        setFlags(transport, execution);
        const fixture = makeChannel(RemoteChannel, ['blocked']);
        broadcastDown(fixture);
        fixture.channel.mqttReady = true;
        await fixture.channel.recoverPendingCalls();
        assert.deepEqual(fixture.table.scans, [], `transport=${transport}, execution=${execution}`);
    }
});

test('both execution transports require a live local executor before scanning', async () => {
    for (const execution of [true, false]) {
        setFlags(true, execution);
        const fixture = makeChannel(RemoteChannel, ['blocked']);
        fixture.channel.mqttReady = true;
        fixture.channel.localExecutorProbe = () => false;
        await fixture.channel.recoverPendingCalls();
        assert.deepEqual(fixture.table.scans, []);
    }
});

test('restart telemetry: a planned restart is reported, and so is the start that works after it', async () => {
    // Catch the telemetry HTTP requests instead of sending them.
    const events = [];
    const originalRequest = https.request;
    https.request = (_options, onResponse) => Object.assign(new EventEmitter(), {
        setTimeout() { return this; },
        write: body => events.push(...JSON.parse(body).events),
        end: () => onResponse(Object.assign(new EventEmitter(), { statusCode: 204, resume() { queueMicrotask(() => this.emit('end')); } })),
    });
    syncBuiltinESMExports();
    configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    const sent = name => events.filter(event => event.name === name).map(event => event.params);
    try {
        setMqttTransport(true);
        const fixture = makeChannel(RemoteChannel, []);
        let starts = 0;
        fixture.channel.startMqtt = async () => {
            starts++;
            if (starts === 1) throw new Error('broker down');
            fixture.channel.mqttReceiver = { stop: async () => {} };
        };
        await fixture.channel.updateMqttTransport(true);
        await waitUntil(() => sent('remote_channel_mqtt_restart_scheduled').length === 1, 5_000, 'the restart is reported');
        assert.equal(sent('remote_channel_mqtt_restart_scheduled')[0].failures, 1);
        clearTimeout(fixture.channel.mqttRestartTimer);
        fixture.channel.mqttRestartTimer = null;
        await fixture.channel.updateMqttTransport(true);
        await waitUntil(() => sent('remote_channel_mqtt_restart_succeeded').length === 1, 5_000, 'the recovery is reported');
        assert.equal(sent('remote_channel_mqtt_restart_succeeded')[0].attempts, 1);
    } finally {
        process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
        https.request = originalRequest;
        syncBuiltinESMExports();
    }
});
