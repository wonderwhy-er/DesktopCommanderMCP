#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the current transport source with broker and telemetry spies, without RemoteChannel startup.
const client = new EventEmitter();
client.connected = true;
client.subscribe = (topic, options, callback) => callback(null, [{ topic, qos: 1 }]);
client.end = () => {};
const observations = [];
const deliveries = [];
let malformed = 0;
const exports = {};
const source = readFileSync(new URL('../src/remote-device/mqtt/mqtt-transport.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
runInNewContext(outputText, {
    exports, URL, setTimeout, clearTimeout, console: { debug() {} },
    require(name) {
        if (name === 'mqtt') return { connect: () => client };
        if (name === '../transport-telemetry.js') return { observeTransport: input => observations.push(input) };
        throw new Error(`Unexpected import: ${name}`);
    },
});
const { MqttTransport, mqttDoorbellTopic } = exports;
const receiver = new MqttTransport(
    { url: 'mqtts://example.invalid', options: {} }, 'owner', 'device',
    async payload => deliveries.push(payload), async () => {}, () => malformed++,
);
const started = receiver.start();
client.emit('connect');
await started;
const topic = mqttDoorbellTopic('owner', 'device');
const valid = { call_id: 'call-1', user_id: 'owner', device_id: 'device' };
const invalid = [
    'null', 'true', '42', '""', '[]', '{}', '{',
    JSON.stringify({ ...valid, user_id: 'foreign' }),
    JSON.stringify({ ...valid, device_id: 'foreign' }),
    JSON.stringify({ ...valid, call_id: '../bad' }),
    JSON.stringify({ ...valid, extra: 'unexpected' }),
    JSON.stringify({ ...valid, IS_MQTT_EXECUTION_ENABLED: 'true' }),
    JSON.stringify({ ...valid, IS_MQTT_EXECUTION_ENABLED: null }),
];
for (const raw of invalid) {
    assert.doesNotThrow(() => client.emit('message', topic, Buffer.from(raw), { retain: false }), raw);
    assert.equal(observations.length, 0, 'invalid payload must not record receipt');
    assert.equal(deliveries.length, 0, 'invalid payload must not reach the handler');
}
for (const [target, retain] of [[`${topic}/foreign`, false], [topic, true]]) {
    client.emit('message', target, Buffer.from(JSON.stringify(valid)), { retain });
}
assert.equal(malformed, invalid.length + 2);
assert.equal(observations.length, 0);
assert.equal(deliveries.length, 0);
for (const payload of [valid, { ...valid, IS_MQTT_EXECUTION_ENABLED: false }, { ...valid, IS_MQTT_EXECUTION_ENABLED: true }]) {
    client.emit('message', topic, Buffer.from(JSON.stringify(payload)), { retain: false });
}
assert.equal(observations.length, 3);
assert.equal(deliveries.length, 3);
for (const event of observations) {
    assert.equal(event.stage, 'received_from_backend');
    assert.equal(event.callId, valid.call_id);
    assert.equal(event.userId, 'owner');
    assert.equal(event.deviceId, 'device');
    assert.equal(event.transport, 'mqtt');
}
await receiver.stop();
console.log('PASS: invalid MQTT input is rejected before telemetry; valid messages are observed and delivered.');
