#!/usr/bin/env node
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { parseDeviceTransportPayload } from '@desktop-commander/telemetry-contract/transport';
import { configManager } from '../dist/config-manager.js';
import { observeTransport } from '../dist/remote-device/transport-telemetry.js';
import { capture } from '../dist/utils/capture.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const target = { call_id: 'call-1', device_id: 'device-1', user_id: 'user-1' };
const received = payload => observeTransport({ stage: 'received', payload, deviceId: 'device-1',
    userId: 'user-1', transport: 'broadcast' });
const receipt = received(target);
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
    stage: 'received', notification_id: 'call-1:broadcast:1',
    attempt_number: 1, schema_version: 1,
});
assert.ok(!Number.isNaN(Date.parse(receipt.timestamp_utc)));
assert.equal('monotonic_ms' in receipt, false);
assert.match(receipt.observation_id, /^[0-9a-f-]{36}$/);
assert.match(receipt.source_process_id, /^[0-9a-f-]{36}$/);
assert.equal('tool_name' in receipt, false);
assert.notEqual(received(target).observation_id, receipt.observation_id);
assert.equal(observeTransport({ stage: 'received', payload: target, deviceId: 'device-1', userId: 'other-user' }), null);
assert.equal(observeTransport({ stage: 'received', payload: target, deviceId: 'other-device', userId: 'user-1' }), null);
assert.equal(received({ ...target, call_id: 'bad id' }), null);
assert.equal(received({ ...target, call_id: { unsafe: true } }), null);
const start = observeTransport({ stage: 'operation_start', callId: 'call-1', deviceId: 'device-1',
    toolName: 'read_file', operation: 'result_write' });
const end = observeTransport({ stage: 'operation_end', callId: 'call-1', deviceId: 'device-1',
    toolName: 'read_file', operation: 'result_write', operationId: start.operation_id,
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
    toolName: 'read_file', transport: 'mqtt' });
assert.equal(mqtt.transport, 'mqtt');
assert.equal('notification_id' in mqtt, false);
assert.equal('duration_ms' in end, false);
assert.equal('outcome' in end, false);
assert.equal('tool_name' in observeTransport({ stage: 'execution_start', callId: 'call-1', deviceId: 'device-1',
    toolName: 'x'.repeat(129) }), false);
assert.equal(observeTransport({ stage: 'operation_end', callId: 'bad id', deviceId: 'device-1' }), null);
assert.equal(observeTransport({ stage: '', callId: 'call-1', deviceId: 'device-1' }), null);

// Capture the actual /mp/collect body without making a network request.
const originalRequest = https.request;
const originalGetValue = configManager.getValue;
const originalGetOrCreateClientId = configManager.getOrCreateClientId;
const originalDisableTelemetry = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
const sent = [];
let resolveSent;
let sendTimeout;
const bothSent = new Promise(resolve => { resolveSent = resolve; });
try {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = (options, onResponse) => {
        assert.equal(options.hostname, 'telemetry.desktopcommander.app');
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
            if (sent.length === 2) resolveSent();
        };
        return request;
    };
    syncBuiltinESMExports();

    const wireObservation = received({ ...target, call_id: 'call-wire' });
    void capture('ordinary_event', { custom_field: 'kept' });
    await Promise.race([
        bothSent,
        new Promise((_, reject) => {
            sendTimeout = setTimeout(() => reject(new Error('Telemetry requests were not sent')), 3000);
        }),
    ]);

    const transportBody = sent.find(body => body.events[0].name === 'received');
    assert.deepEqual(transportBody.events[0].params, wireObservation);
    assert.equal('platform' in transportBody.events[0].params, false);
    const parsed = parseDeviceTransportPayload(transportBody);
    assert.equal(parsed.client_id, 'installation-1');
    assert.equal(parsed.events[0].params.call_id, 'call-wire');
    assert.equal(parsed.events[0].params.source, 'device');
    assert.equal(parsed.events[0].params.monotonic_ms, undefined);

    const ordinaryBody = sent.find(body => body.events[0].name === 'ordinary_event');
    assert.equal(ordinaryBody.events[0].params.custom_field, 'kept');
    assert.equal(typeof ordinaryBody.events[0].params.platform, 'string');
    assert.throws(() => parseDeviceTransportPayload(ordinaryBody), /Invalid transport/);
} finally {
    clearTimeout(sendTimeout);
    https.request = originalRequest;
    syncBuiltinESMExports();
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalGetOrCreateClientId;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = originalDisableTelemetry;
}
console.log('PASS transport observations: contract accepted wire payload; ordinary capture unchanged');
