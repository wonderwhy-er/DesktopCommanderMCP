#!/usr/bin/env node
// Exercise rollout changes through the real MQTT lifecycle and capability writes, without network calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { rolloutManager } = await import('../dist/remote-device/rollouts.js');
const { VERSION } = await import('../dist/version.js');
const enabled = { MQTT_TRANSPORT_ENABLED: true };
const disabled = { MQTT_TRANSPORT_ENABLED: false };
const settle = () => new Promise(setImmediate);

function fixture(t) {
    const channel = new RemoteChannel();
    const capabilities = [];
    let starts = 0;
    let stops = 0;
    let enrollments = 0;
    let broadcasts = 0;
    Object.assign(channel, {
        _user: { id: 'owner' }, deviceId: 'device',
        findDevice: async () => ({ id: 'device' }),
        updateDevice: async () => ({ error: null }),
        client: { from: table => {
            assert.equal(table, 'mcp_devices');
            return { update: value => {
                assert.deepEqual(Object.keys(value), ['capabilities'], 'MQTT only changes its capability');
                return { eq: () => ({ abortSignal: async () => {
                    capabilities.push(value.capabilities);
                    return { error: null };
                } }) };
            } };
        } },
        createChannel: async () => {
            broadcasts++;
            channel.channelReady = true;
            channel.channel = { state: 'joined', untrack: async () => {}, unsubscribe: async () => {} };
        },
        prepareMqttConfig: async () => { enrollments++; return {}; },
        startMqttTransport: async () => {
            starts++;
            channel.mqttReceiver = { stop: async () => { stops++; } };
            await channel.setMqttReady(true);
        },
    });
    t.after(() => channel.unsubscribe());
    return { channel, capabilities, get starts() { return starts; }, get stops() { return stops; },
        get enrollments() { return enrollments; }, get broadcasts() { return broadcasts; } };
}

for (const rollouts of [{}, disabled]) {
    await test(`startup keeps MQTT off for ${JSON.stringify(rollouts)}`, async t => {
        rolloutManager.update(rollouts);
        const f = fixture(t);
        await f.channel.startMqtt();
        await f.channel.registerDevice({}, 'device', 'fixture', () => {});
        await f.channel.mqttLifecycle;
        assert.equal(f.enrollments, 0, 'the startup flag check still prevents enrollment');
        assert.equal(f.starts, 0);
        assert.equal(f.broadcasts, 1);
        assert.deepEqual(f.channel.capabilitiesPayload(), { app_version: VERSION });
    });
}

await test('registration skips MQTT when the server loaded the flag as false', async t => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ rollouts: disabled });
    t.after(() => { globalThis.fetch = originalFetch; });
    await rolloutManager.load('https://server.example', async () => 'test-token');
    const debug = t.mock.method(console, 'debug', () => {});
    const f = fixture(t);
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    await f.channel.mqttLifecycle;
    assert.equal(f.enrollments, 0);
    assert.equal(f.starts, 0);
    assert.equal(debug.mock.calls.some(call => call.arguments[0] === '[DEBUG] starting MQTT'), false);
    assert.equal(f.broadcasts, 1);
    rolloutManager.update(enabled);
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 1, 'the listener still starts MQTT when the flag later becomes true');
});

await test('a running device starts and stops MQTT and updates its saved capabilities', async t => {
    rolloutManager.update(disabled);
    const f = fixture(t);
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    rolloutManager.update(enabled);
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 1);
    assert.deepEqual(f.capabilities.at(-1), { transport_mqtt_v1: true, app_version: VERSION });

    rolloutManager.update({ ...enabled, other: true });
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 1, 'an unrelated rollout cannot start another receiver');

    rolloutManager.update(disabled);
    await f.channel.mqttLifecycle;
    assert.equal(f.stops, 1);
    assert.equal(f.channel.mqttReceiver, null);
    assert.deepEqual(f.capabilities.at(-1), { app_version: VERSION });
    assert.equal(f.channel.isReachable(), true, 'Broadcast remains reachable while MQTT is off');

    rolloutManager.update(enabled);
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 2);
    rolloutManager.update({});
    await f.channel.mqttLifecycle;
    assert.equal(f.stops, 2, 'removing the rollout also stops MQTT');
    assert.deepEqual(f.capabilities.at(-1), { app_version: VERSION });
    assert.equal(f.broadcasts, 1, 'MQTT changes do not restart Broadcast');
});

await test('flag changes wait for enrollment and run start, stop and start in order', async t => {
    rolloutManager.update(enabled);
    const f = fixture(t);
    const pending = [];
    f.channel.prepareMqttConfig = () => new Promise(resolve => pending.push(resolve));
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    assert.equal(pending.length, 1);
    rolloutManager.update(disabled);
    rolloutManager.update(enabled);
    assert.equal(pending.length, 1, 'enrollments cannot overlap');
    pending[0]({});
    await settle();
    assert.equal(f.starts, 1, 'the first startup finishes before the queued stop');
    assert.equal(f.stops, 1, 'the stop finishes before the next enrollment');
    assert.equal(pending.length, 2);
    pending[1]({});
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 2);
    assert.deepEqual(f.capabilities.map(value => value.transport_mqtt_v1), [true, undefined, true]);
    assert.deepEqual(f.capabilities.at(-1), { transport_mqtt_v1: true, app_version: VERSION });
});

await test('disabling waits for the broker startup to finish before stopping the receiver', async t => {
    rolloutManager.update(enabled);
    const f = fixture(t);
    let stops = 0;
    let release;
    f.channel.startMqttTransport = () => new Promise(resolve => {
        release = resolve;
        f.channel.mqttReceiver = { stop: async () => { stops++; } };
    });
    try {
        await f.channel.registerDevice({}, 'device', 'fixture', () => {});
        await settle();
        assert.ok(f.channel.mqttReceiver);
        rolloutManager.update(disabled);
        await settle();
        assert.equal(stops, 0, 'stop cannot run while startup is pending');
        release();
        await f.channel.mqttLifecycle;
        assert.equal(stops, 1);
        assert.equal(f.channel.mqttReceiver, null);
        assert.deepEqual(f.channel.capabilitiesPayload(), { app_version: VERSION });
    } finally {
        release?.();
    }
});

await test('a failed startup releases the queue for the next flag change', async t => {
    rolloutManager.update(enabled);
    const f = fixture(t);
    f.channel.prepareMqttConfig = async () => { throw Error('enrollment unavailable'); };
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 0);
    f.channel.prepareMqttConfig = async () => ({});
    rolloutManager.update(disabled);
    rolloutManager.update(enabled);
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 1);
    assert.deepEqual(f.capabilities.at(-1), { transport_mqtt_v1: true, app_version: VERSION });
});

await test('a new start waits until the previous stop and capability withdrawal finish', async t => {
    rolloutManager.update(enabled);
    const f = fixture(t);
    await f.channel.registerDevice({}, 'device', 'fixture', () => {});
    await f.channel.mqttLifecycle;
    let release;
    f.channel.mqttReceiver.stop = () => new Promise(resolve => { release = resolve; });
    rolloutManager.update(disabled);
    rolloutManager.update(enabled);
    await settle();
    assert.equal(f.starts, 1, 'the old receiver must finish stopping before a new one starts');
    release();
    await f.channel.mqttLifecycle;
    assert.equal(f.starts, 2);
    assert.deepEqual(f.capabilities.map(value => value.transport_mqtt_v1), [true, undefined, true]);
});

for (const reason of ['shutdown', 'session lost', 'session replaced']) {
    await test(`${reason} removes the listener so later flags cannot restart MQTT`, async t => {
        rolloutManager.update(disabled);
        const f = fixture(t);
        await f.channel.registerDevice({}, 'device', 'fixture', () => {});
        await f.channel.mqttLifecycle;
        if (reason === 'shutdown') {
            await f.channel.unsubscribe();
        } else if (reason === 'session lost') {
            f.channel.setOffline = async () => {};
            await f.channel.handleSignedOut();
        } else {
            Object.assign(f.channel.client, {
                auth: {
                    setSession: async () => ({ data: { user: { id: 'next-owner' } }, error: null }),
                    getSession: async () => ({ data: { session: { access_token: 'next-token' } } }),
                    onAuthStateChange: () => {},
                },
                realtime: { setAuth: () => {} },
            });
            await f.channel.setSession({ access_token: 'next-token', refresh_token: null });
        }
        rolloutManager.update(enabled);
        await settle();
        assert.equal(f.enrollments, 0);
        assert.equal(f.starts, 0);
    });
}
