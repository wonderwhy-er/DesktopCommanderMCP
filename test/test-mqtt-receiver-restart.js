#!/usr/bin/env node
// A receiver that stops itself after startup (the broker refuses the subscription on a
// reconnect, a reconnect never subscribes again, or the readiness write fails) tells RemoteChannel through onFailed, so MQTT is
// restarted instead of staying off until the app restarts.
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

test('a subscription refused on a reconnect stops the receiver and reports it once', async () => {
    const client = fakeClient();
    const { receiver, failures } = receiverOn(client);
    const started = receiver.start();
    client.emit('connect');
    await started;
    client.subscribe = (_topic, _options, callback) => callback(new Error('not authorized'));
    client.emit('connect');
    assert.equal(failures.count, 1);
    assert.equal(client.ended, true, 'the receiver stopped');
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

test('a readiness write that fails on a reconnect stops the receiver and reports it', async () => {
    const client = fakeClient();
    let failReadiness = false;
    const { receiver, failures } = receiverOn(client, async ready => {
        if (ready && failReadiness) throw new Error('capability write failed');
    });
    const started = receiver.start();
    client.emit('connect');
    await started;
    failReadiness = true;
    client.emit('connect');
    // The readiness callback is a promise, so the failure is seen a few microtask turns later.
    for (let turn = 0; turn < 5 && failures.count === 0; turn++) await Promise.resolve();
    assert.equal(failures.count, 1);
});

// After a dropped connection the receiver has the startup limit to subscribe again. A broker that
// never grants it again would otherwise leave the device connected and not ready until a restart.
const DEADLINE = { connectTimeout: 30 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A started receiver whose next subscriptions get no answer from the broker. */
async function startedThenSilent(onReady) {
    const client = fakeClient();
    const { receiver, failures } = receiverOn(client, onReady, DEADLINE);
    const started = receiver.start();
    client.emit('connect');
    await started;
    client.subscribe = () => {};
    return { client, receiver, failures };
}

test('a reconnect that never subscribes again stops the receiver and reports it once', async () => {
    const { client, failures } = await startedThenSilent();
    client.emit('close');
    client.emit('connect');
    client.emit('close');
    await wait(60);
    assert.equal(failures.count, 1);
    assert.equal(client.ended, true, 'the receiver stopped');
});

test('a reconnect that subscribes again in time keeps the receiver', async () => {
    const { client, failures } = await startedThenSilent();
    client.emit('close');
    client.subscribe = (topic, _options, callback) => callback(null, [{ topic, qos: 1 }]);
    client.emit('connect');
    await wait(60);
    assert.equal(failures.count, 0);
    assert.notEqual(client.ended, true);
});
