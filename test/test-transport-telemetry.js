#!/usr/bin/env node
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { rolloutManager } from '../dist/remote-device/rollouts.js';
import { waitUntil } from './helpers/wait.js';
import { configManager } from '../dist/config-manager.js';
import { observeTransport } from '../dist/remote-device/transport-telemetry.js';
import { capture } from '../dist/utils/capture.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const received = (callId, payload) => observeTransport({ stage: 'received_from_backend', callId, payload, deviceId: 'device-1',
    userId: 'user-1', transport: 'broadcast' });
const receipt = received('call-1');
assert.deepEqual({
    call_id: receipt.call_id,
    device_id: receipt.device_id,
    transport: receipt.transport,
    stage: receipt.stage,
    notification_id: receipt.notification_id,
    attempt_number: receipt.attempt_number,
    schema_version: receipt.schema_version,
}, {
    call_id: 'call-1', device_id: 'device-1', transport: 'broadcast',
    stage: 'received_from_backend', notification_id: 'call-1:broadcast:1',
    attempt_number: 1, schema_version: 1,
});
assert.ok(!Number.isNaN(Date.parse(receipt.timestamp_utc)));
assert.equal('monotonic_ms' in receipt, false);
assert.match(receipt.observation_id, /^[0-9a-f-]{36}$/);
assert.match(receipt.source_process_id, /^[0-9a-f-]{36}$/);
assert.equal('tool_name' in receipt, false);
assert.equal('IS_MQTT_EXECUTION_ENABLED' in receipt, false);
assert.notEqual(received('call-1').observation_id, receipt.observation_id);
assert.equal(received('call-1', { call_id: 'other-call', device_id: 'device-1' }), null);
assert.equal(received('bad id'), null);
assert.equal(received({ unsafe: true }), null);
const start = observeTransport({ stage: 'operation_start', callId: 'call-1', deviceId: 'device-1',
    userId: 'user-1', toolName: 'read_file', operation: 'result_write' });
const end = observeTransport({ stage: 'operation_end', callId: 'call-1', deviceId: 'device-1',
    userId: 'user-1', toolName: 'read_file', operation: 'result_write', operationId: start.operation_id,
    fields: { duration_ms: 12, outcome: 'success', tool_name: 'injected' } });
assert.equal(start.operation_id, start.observation_id);
assert.equal(end.operation_id, start.operation_id);
assert.equal(end.call_id, receipt.call_id);
assert.equal(end.stage, 'operation_end');
assert.equal(end.operation, 'result_write');
assert.equal(start.tool_name, 'read_file');
assert.equal(end.tool_name, 'read_file');
assert.equal('monotonic_ms' in start, false);
assert.equal('monotonic_ms' in end, false);
assert.equal('transport' in start, false);
assert.equal('notification_id' in start, false);
assert.equal('attempt_number' in start, false);
const mqtt = observeTransport({ stage: 'execution_start', callId: 'call-1', deviceId: 'device-1',
    userId: 'user-1', toolName: 'read_file', transport: 'mqtt' });
assert.equal(mqtt.transport, 'mqtt');
assert.equal('notification_id' in mqtt, false);
assert.equal('attempt_number' in mqtt, false);
assert.equal('duration_ms' in end, false);
assert.equal('outcome' in end, false);
assert.equal('tool_name' in observeTransport({ stage: 'execution_start', callId: 'call-1', deviceId: 'device-1',
    userId: 'user-1', toolName: 'x'.repeat(129) }), false);
assert.equal(observeTransport({ stage: 'operation_end', callId: 'bad id', deviceId: 'device-1', userId: 'user-1' }), null);
assert.equal(observeTransport({ stage: '', callId: 'call-1', deviceId: 'device-1', userId: 'user-1' }), null);
assert.equal(observeTransport({ stage: 42, callId: 'call-1', deviceId: 'device-1', userId: 'user-1' }), null);
for (const userId of [undefined, '', ' ', 'x'.repeat(129)]) {
    assert.equal(observeTransport({ stage: 'execution_start', callId: 'call-1', deviceId: 'device-1', userId }), null);
}

// Capture the actual /mp/collect body without making a network request.
const originalRequest = https.request;
const originalGetValue = configManager.getValue;
const originalGetOrCreateClientId = configManager.getOrCreateClientId;
const originalDisableTelemetry = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
const sent = [];
try {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = (options, onResponse) => {
        assert.equal(options.path, '/mp/collect');
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.write = body => { sent.push(JSON.parse(body)); };
        request.end = () => {
            const response = new EventEmitter();
            response.statusCode = 204;
            response.resume = () => {};
            onResponse(response);
            queueMicrotask(() => response.emit('end'));
        };
        return request;
    };
    syncBuiltinESMExports();

    const channel = new RemoteChannel();
    channel.deviceId = 'device-1';
    channel._user = { id: 'user-1' };
    await channel.onBroadcastDoorbell({ call_id: 'wrong-device', device_id: 'other-device' });
    await channel.onBroadcastDoorbell({ call_id: 'wrong-user', device_id: 'device-1', user_id: 'other-user' });
    await channel.onBroadcastDoorbell({ device_id: 'device-1' });
    await channel.onBroadcastDoorbell({ call_id: 'call-wire', device_id: 'device-1', IS_MQTT_EXECUTION_ENABLED: false });
    void capture('ordinary_event', { custom_field: 'kept' });
    await waitUntil(() => sent.some(body => body.events[0].params.call_id === 'call-wire') &&
        sent.some(body => body.events[0].name === 'ordinary_event'), 3000, 'Broadcast receipt and ordinary event');

    const transportBodies = sent.filter(body => body.telemetry_type === 'transport');
    assert.equal(transportBodies.length, 1, 'only the targeted Broadcast receipt with a call ID is sent');
    const [transportBody] = transportBodies;
    assert.equal(transportBody.events[0].name, 'received_from_backend');
    assert.equal(transportBody.user_id, 'user-1');
    assert.equal(transportBody.events[0].params.notification_id, 'call-wire:broadcast:1');
    assert.equal(transportBody.events[0].params.device_id, 'device-1');
    assert.equal('platform' in transportBody.events[0].params, false);
    assert.equal(transportBody.client_id, 'installation-1');
    assert.equal(transportBody.events[0].params.call_id, 'call-wire');
    assert.equal('payload' in transportBody.events[0].params, false);
    assert.equal(transportBody.events[0].params.stage, transportBody.events[0].name);
    assert.ok(!Number.isNaN(Date.parse(transportBody.events[0].params.timestamp_utc)));
    assert.equal(transportBody.events[0].params.monotonic_ms, undefined);
    assert.equal('IS_MQTT_EXECUTION_ENABLED' in transportBody.events[0].params, false);

    const ordinaryBody = sent.find(body => body.events[0].name === 'ordinary_event');
    assert.equal('telemetry_type' in ordinaryBody, false);
    assert.equal('user_id' in ordinaryBody, false);
    assert.equal(ordinaryBody.events[0].params.custom_field, 'kept');
    assert.equal(typeof ordinaryBody.events[0].params.platform, 'string');

    const writes = [];
    channel.client = { from: () => ({ update: () => ({ eq: async (_, id) => {
        writes.push({ id, time: Date.now() });
        if (id === 'broadcast') {
            channel.deviceId = 'new-device';
            channel._user = { id: 'new-user' };
        }
        return { error: id === 'write-error' ? { message: 'write failed' } : null };
    } }) }) };
    const mqttResults = [];
    channel.mqttReceiver = { publishResult: async id => { mqttResults.push(id); } };
    rolloutManager.update({ MQTT_TRANSPORT_ENABLED: false });
    await channel.updateCallResult('no-origin', 'completed', {});
    await channel.updateCallResult('nonterminal', 'executing', null, null, 'backend');
    await channel.updateCallResult('write-error', 'failed', null, 'fixture error', 'backend');
    await channel.updateCallResult('broadcast', 'completed', {}, null, 'backend');
    rolloutManager.update({ MQTT_TRANSPORT_ENABLED: true });
    await channel.updateCallResult('mqtt', 'completed', {}, null, 'backend');
    await waitUntil(() => sent.some(body => body.events[0].params.call_id === 'broadcast'), 3000, 'Broadcast result telemetry');
    const publications = sent.flatMap(body => body.events).filter(event => event.name === 'publish_from_device');
    assert.deepEqual(publications.map(({ params }) => [params.call_id, params.transport]), [['broadcast', 'broadcast']]);
    assert.ok(Date.parse(publications[0].params.timestamp_utc) <= writes.find(write => write.id === 'broadcast').time);
    assert.equal(publications[0].params.device_id, 'device-1');
    assert.equal(sent.find(body => body.events[0] === publications[0]).user_id, 'user-1');
    assert.deepEqual(mqttResults, ['mqtt']);
} finally {
    rolloutManager.update({});
    https.request = originalRequest;
    syncBuiltinESMExports();
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalGetOrCreateClientId;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = originalDisableTelemetry;
}
console.log('PASS transport observations: required wire fields and identity retained; ordinary capture unchanged');
