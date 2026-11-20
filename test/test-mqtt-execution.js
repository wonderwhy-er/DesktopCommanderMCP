#!/usr/bin/env node
// The backend sends each call over MQTT (MQTT_TRANSPORT_ENABLED on) or over Broadcast (off), never
// both. An MQTT doorbell runs the call like a Broadcast doorbell; the database claim stops a second run.
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

test('an MQTT doorbell claims the call and runs it', async () => {
    setMqttTransport(true);
    const fixture = makeChannel(RemoteChannel, ['call-on']);
    await fixture.channel.onMqttDoorbell(doorbell('call-on'));
    assert.deepEqual(fixture.delivered, ['call-on']);
    assert.equal(fixture.rows[0].status, 'executing');
});

test('if MQTT and Broadcast ever both ring, the call runs once; the database claim lets one win', async () => {
    setMqttTransport(true);
    const fixture = makeChannel(RemoteChannel, ['call-both']);
    await Promise.all([
        fixture.channel.onMqttDoorbell(doorbell('call-both')),
        fixture.channel.onBroadcastDoorbell(doorbell('call-both')),
    ]);
    assert.deepEqual(fixture.delivered, ['call-both']);
});

test('a fresh MQTT subscription scans for calls missed while MQTT was down', async () => {
    setMqttTransport(true);
    const fixture = makeChannel(RemoteChannel, ['missed-1', 'missed-2']);
    fixture.channel.recoverAfterMqttChange('after MQTT connected');
    await waitUntil(() => fixture.delivered.length === 2, 10_000, 'both missed calls are delivered');
    assert.deepEqual(fixture.delivered, ['missed-1', 'missed-2']);
});

test('a failed MQTT start is tried again while the flag is on, and not once it is off', async () => {
    setMqttTransport(true);
    const fixture = makeChannel(RemoteChannel, []);
    let starts = 0;
    fixture.channel.startMqtt = async () => { starts++; if (starts === 1) throw new Error('broker down'); };
    await fixture.channel.updateMqttTransport(true);
    assert.ok(fixture.channel.mqttRestartTimer, 'a restart is planned');
    clearTimeout(fixture.channel.mqttRestartTimer);
    fixture.channel.mqttRestartTimer = null;
    await fixture.channel.updateMqttTransport(true);
    assert.equal(starts, 2);
    assert.equal(fixture.channel.mqttRestartFailures, 0, 'a start that works resets the wait');

    setMqttTransport(false);
    fixture.channel.startMqtt = async () => { throw new Error('broker down'); };
    await fixture.channel.updateMqttTransport(true);
    assert.equal(fixture.channel.mqttRestartTimer, null);
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

// The scan used to need Broadcast connected, so a device with only MQTT never scanned.
const broadcastDown = fixture => Object.assign(fixture.channel, { channel: { state: 'errored' }, channelReady: false });

test('with Broadcast down, MQTT ready is enough for the scan', async () => {
    setMqttTransport(true);
    const fixture = makeChannel(RemoteChannel, ['mqtt-only-1', 'mqtt-only-2']);
    broadcastDown(fixture);
    fixture.channel.mqttReady = true;
    fixture.channel.recoverAfterMqttChange('after MQTT connected');
    await waitUntil(() => fixture.delivered.length === 2, 10_000, 'both calls are delivered over MQTT alone');
});

test('with Broadcast down, the scan claims nothing if MQTT is not ready or the executor is dead', async () => {
    setMqttTransport(true);
    for (const [mqttReady, executorAlive] of [[false, true], [true, false]]) {
        const fixture = makeChannel(RemoteChannel, ['blocked']);
        broadcastDown(fixture);
        fixture.channel.mqttReady = mqttReady;
        fixture.channel.localExecutorProbe = () => executorAlive;
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
