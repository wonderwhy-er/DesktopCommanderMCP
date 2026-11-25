#!/usr/bin/env node
// A receiver reports startup failures through start() and later disconnects through onFailed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** A connected fake MQTT.js client that grants every subscription at QoS 1. */
function fakeClient() {
    const client = new EventEmitter();
    client.connected = true;
    client.subscribe = (topic, _options, callback) => callback(null, [{ topic, qos: 1 }]);
    client.end = () => { client.ended = true; };
    return client;
}

/** The current mqtt-transport.ts, compiled so that `mqtt` connects to `client`. */
function loadTransport(client) {
    const exports = {};
    const source = readFileSync(new URL('../src/remote-device/mqtt/mqtt-transport.ts', import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    runInNewContext(outputText, {
        exports, URL, setTimeout, clearTimeout, console: { debug() {} },
        require(name) {
            if (name === 'mqtt') return { connect: () => client };
            if (name === '../transport-telemetry.js') return { observeTransport() {} };
            throw new Error(`Unexpected import: ${name}`);
        },
    });
    return exports;
}

/** A receiver for owner/device on `client`, with its failure count and a readiness callback to control. */
function receiverOn(client, onReady = async () => {}, options = {}) {
    const { MqttTransport } = loadTransport(client);
    const failures = { count: 0 };
    const receiver = new MqttTransport({ url: 'mqtts://example.invalid', options }, 'owner', 'device',
        async () => {}, onReady, undefined, () => failures.count++);
    return { receiver, failures };
}

test('a lost connection withdraws readiness and requests one replacement', async () => {
    const client = fakeClient();
    const readiness = [];
    const { receiver, failures } = receiverOn(client, async ready => readiness.push(ready));
    const started = receiver.start();
    client.emit('connect');
    await started;
    client.emit('close');
    client.emit('close');
    assert.deepEqual(readiness, [true, false]);
    assert.equal(failures.count, 1);
    assert.equal(client.ended, true);
});

test('a subscription refused during startup rejects start() and does not report a later failure', async () => {
    const client = fakeClient();
    client.subscribe = (_topic, _options, callback) => callback(new Error('not authorized'));
    const { receiver, failures } = receiverOn(client);
    const started = receiver.start();
    client.emit('connect');
    await assert.rejects(started, /subscription refused/);
    assert.equal(failures.count, 0, 'start() already reports it; RemoteChannel retries the start');
});

test('a readiness write that fails during startup rejects the attempt', async () => {
    const client = fakeClient();
    const { receiver, failures } = receiverOn(client, async ready => {
        if (ready) throw new Error('capability write failed');
    });
    const started = receiver.start();
    client.emit('connect');
    await assert.rejects(started, /readiness/);
    assert.equal(failures.count, 0);
    assert.equal(client.ended, true);
});

test('a connection lost before the subscription is granted fails startup immediately', async () => {
    const client = fakeClient();
    client.subscribe = () => {};
    const { receiver, failures } = receiverOn(client);
    const started = receiver.start();
    client.emit('connect');
    client.emit('close');
    await assert.rejects(started, /close|disconnect/i);
    assert.equal(failures.count, 0);
    assert.equal(client.ended, true);
});

test('a broker that never grants the subscription reaches the startup deadline', async () => {
    const client = fakeClient();
    client.subscribe = () => {};
    const { receiver, failures } = receiverOn(client, undefined, { connectTimeout: 30 });
    const started = receiver.start();
    client.emit('connect');
    await assert.rejects(started, /timed out/);
    assert.equal(failures.count, 0);
    assert.equal(client.ended, true);
});

test('an intentional stop does not request a replacement when the socket closes', async () => {
    const client = fakeClient();
    const { receiver, failures } = receiverOn(client);
    const started = receiver.start();
    client.emit('connect');
    await started;
    await receiver.stop();
    client.emit('close');
    assert.equal(failures.count, 0);
});
