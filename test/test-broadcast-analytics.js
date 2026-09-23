#!/usr/bin/env node
import assert from 'node:assert/strict';
import { broadcastReceipt, broadcastStage } from '../dist/remote-device/broadcast-analytics.js';

const arrival = { timestamp_utc: '2026-09-22T10:00:00.000Z', monotonic_ms: 123.5 };
const target = { call_id: 'call-1', device_id: 'device-1', user_id: 'user-1' };
const receipt = broadcastReceipt(target, 'device-1', 'user-1', arrival);
assert.deepEqual({
    call_id: receipt.call_id,
    device_id: receipt.device_id,
    transport: receipt.transport,
    stage: receipt.stage,
    notification_id: receipt.notification_id,
    attempt_number: receipt.attempt_number,
    schema_version: receipt.schema_version,
    timestamp_utc: receipt.timestamp_utc,
    monotonic_ms: receipt.monotonic_ms,
}, {
    call_id: 'call-1', device_id: 'device-1', transport: 'broadcast',
    stage: 'received', notification_id: 'call-1:broadcast:1',
    attempt_number: 1, schema_version: 1, ...arrival,
});
assert.match(receipt.observation_id, /^[0-9a-f-]{36}$/);
assert.match(receipt.source_process_id, /^[0-9a-f-]{36}$/);
assert.notEqual(broadcastReceipt(target, 'device-1', 'user-1', arrival).observation_id, receipt.observation_id);
assert.equal(broadcastReceipt(target, 'device-1', 'other-user', arrival), null);
assert.equal(broadcastReceipt(target, 'other-device', 'user-1', arrival), null);
assert.equal(broadcastReceipt({ ...target, call_id: 'bad id' }, 'device-1', 'user-1', arrival), null);
assert.equal(broadcastReceipt({ ...target, call_id: { unsafe: true } }, 'device-1', 'user-1', arrival), null);
const stage = broadcastStage('call-1', 'device-1', 'operation_end', { operation: 'result_write', tool_name: 'read_file', duration_ms: 12 });
assert.equal(stage.call_id, receipt.call_id);
assert.equal(stage.tool_name, 'read_file');
assert.equal(stage.duration_ms, 12);
assert.equal(stage.stage, 'operation_end');
assert.equal(stage.operation, 'result_write');
assert.match(stage.operation_id, /^[0-9a-f-]{36}$/);
assert.equal(broadcastStage('bad id', 'device-1', 'operation_end'), null);
console.log('PASS broadcast receipt: captured callback time, correlation, and target filtering');
