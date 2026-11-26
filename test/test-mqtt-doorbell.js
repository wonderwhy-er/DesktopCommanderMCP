#!/usr/bin/env node
// Real mutual-TLS MQTT plus the production handlers; database and telemetry HTTP are local doubles.
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import aedes from 'aedes';
import { connectAsync } from 'mqtt';
import forge from 'node-forge';

for (const key of Object.keys(process.env)) if (key.startsWith('MQTT_')) delete process.env[key];
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { rolloutManager } = await import('../dist/remote-device/rollouts.js');
rolloutManager.update({ MQTT_TRANSPORT_ENABLED: true });
/** Transport on; execution on means MQTT runs calls and Broadcast only observes. */
const setExecution = on => rolloutManager.update({ MQTT_TRANSPORT_ENABLED: true, MQTT_ON_DEVICE_EXECUTION_ENABLED: on });
const { MCPDevice } = await import('../dist/remote-device/device.js');
const { MqttTransport, createMqttConfig, mqttDoorbellTopic } = await import('../dist/remote-device/mqtt/mqtt-transport.js');
const { configManager } = await import('../dist/config-manager.js');

const until = async (condition, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for MQTT fixture');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};
const events = [];
/** Who claimed one call, from its call_claimed telemetry. */
const claims = id => events.filter(event => event.name === 'call_claimed' && event.params.call_id === id)
    .map(({ params }) => params.claimed_by);
const originalRequest = https.request;
const originalGetValue = configManager.getValue;
const originalGetId = configManager.getOrCreateClientId;
configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
configManager.getOrCreateClientId = async () => 'mqtt-test-installation';
https.request = (options, onResponse) => {
    assert.equal(options.hostname, 'telemetry.desktopcommander.app');
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.write = body => events.push(...JSON.parse(body).events);
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
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';

const broker = aedes();
const sockets = new Set();
// A throwaway CA keeps the test on the TLS path without changing the machine trust store.
function certificate(isCa, issuer) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = isCa ? '01' : '02';
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    cert.setSubject([{ name: 'commonName', value: isCa ? 'MQTT test CA' : 'MQTT test peer' }]);
    cert.setIssuer(issuer?.cert.subject.attributes ?? cert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: isCa },
        { name: 'keyUsage', keyCertSign: isCa, digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ]);
    cert.sign(issuer?.keys.privateKey ?? keys.privateKey, forge.md.sha256.create());
    return { cert, keys, pem: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}
const ca = certificate(true);
const peer = certificate(false, ca);
const tlsOptions = { cert: peer.pem, key: peer.key, ca: ca.pem, rejectUnauthorized: true };
const server = createServer({ ...tlsOptions, requestCert: true }, socket => {
    assert.equal(socket.authorized, true, 'broker requires an authenticated client certificate');
    broker.handle(socket);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `mqtts://127.0.0.1:${server.address().port}`;
const config = createMqttConfig({ url, cert: peer.pem, key: peer.key });
config.options.ca = ca.pem;
const channels = [];
let publisher;
let pendingReceiver;
let malformed = 0;
const bell = id => ({ call_id: id, user_id: 'owner', device_id: 'device' });

function fixture() {
    const rows = new Map();
    const operations = [];
    const capabilities = [];
    const executed = [];
    const channel = new RemoteChannel();
    channels.push(channel);
    Object.assign(channel, {
        _user: { id: 'owner' }, deviceId: 'device', channelReady: true,
        channel: { state: 'joined', untrack: async () => {}, unsubscribe: async () => {} },
        client: { from(table) {
            const filters = {};
            let update;
            let selected = false;
            let claimed = false;
            const query = {
                update(value) { update = value; return query; },
                select() { selected = true; return query; },
                eq(key, value) { filters[key] = value; return query; },
                gt(key, value) { assert.equal(key, 'timeout_at'); assert.equal(value, 'now'); return query; },
                order() { return query; },
                limit(value) { assert.equal(value, 100); return query; },
                abortSignal() { return query; },
                maybeSingle() { return query; },
                then(resolve, reject) {
                    return Promise.resolve().then(() => {
                        if (table === 'mcp_devices') { capabilities.push(update.capabilities); return { error: null }; }
                        assert.equal(table, 'mcp_remote_calls');
                        operations.push({ filters, update });
                        if (!update && !filters.id) {
                            return { data: [...rows.values()].filter(row => row.device_id === filters.device_id &&
                                row.status === 'pending' && Date.parse(row.timeout_at) > Date.now()), error: null };
                        }
                        const row = rows.get(filters.id);
                        if (update?.status === 'executing') {
                            assert.equal(filters.device_id, 'device');
                            assert.equal(filters.status, 'pending');
                            claimed = !!row && row.status === 'pending' && row.device_id === filters.device_id && Date.parse(row.timeout_at) > Date.now();
                            if (claimed) Object.assign(row, update);
                            return { data: claimed ? [{ ...row }] : [], error: null };
                        }
                        if (row && update) Object.assign(row, update);
                        return { data: selected ? row : null, error: null };
                    }).then(resolve, reject);
                },
            };
            return query;
        } },
    });
    const device = Object.assign(Object.create(MCPDevice.prototype), {
        deviceId: 'device', seenCallIds: new Set(), remoteChannel: channel,
        desktop: { callClientTool: async (_tool, args) => { executed.push(args); return { content: [] }; } },
    });
    channel.onToolCall = payload => device.handleNewToolCall(payload);
    const add = (id, transport = 'broadcast_v1') => rows.set(id, { id, device_id: 'device', user_id: 'owner', status: 'pending',
        timeout_at: new Date(Date.now() + 60_000).toISOString(), tool_name: 'read_file', tool_args: { id }, metadata: transport ? { transport } : {} });
    return { channel, rows, operations, capabilities, executed, add };
}

try {
    const f = fixture();
    assert.equal(f.channel.isReachable(), true, 'Broadcast readiness cannot depend on MQTT');
    f.channel.prepareMqttConfig = async () => config;
    await f.channel.updateMqttTransport(true);
    assert.equal(f.channel.isReachable(), true);
    assert.equal(f.capabilities.at(-1).transport_mqtt_v1, true);
    assert.deepEqual(Object.keys(f.capabilities.at(-1)).sort(), [
        'app_version', 'transport_mqtt_v1',
    ]);
    publisher = await connectAsync(url, tlsOptions);
    const topic = mqttDoorbellTopic('owner', 'device');
    const send = (payload, options = {}) => publisher.publishAsync(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 1, ...options });
    const resultTopic = 'dc/mqtt/v1/users/owner/devices/device/result-backend';
    const resultPackets = [];
    publisher.on('message', (topic, bytes, packet) => {
        if (topic === resultTopic) resultPackets.push({ body: JSON.parse(bytes.toString()), qos: packet.qos, retain: packet.retain });
    });
    await publisher.subscribeAsync(resultTopic, { qos: 1 });

    // Execution off: MQTT only observes and Broadcast runs the call. Execution on: MQTT runs it and
    // Broadcast only observes. The rollout decides; a doorbell field saying the opposite is ignored.
    // Two copies of one packet run the call once, and the "result ready" message goes out over MQTT.
    for (const [execution, field] of [[false, undefined], [false, true], [true, undefined], [true, false]]) {
        setExecution(execution);
        const id = `mqtt-${execution}-${field}`;
        f.add(id);
        f.rows.get(id).metadata.origin_instance = 'backend';
        const payload = bell(id);
        if (field !== undefined) payload.IS_MQTT_EXECUTION_ENABLED = field;
        const executionsBefore = f.executed.length;
        await Promise.all([send(payload), send(payload)]);
        await until(() => events.filter(event => event.params.call_id === id && event.name === 'received_from_backend').length === 2);
        const receipts = events.filter(event => event.params.call_id === id && event.name === 'received_from_backend');
        for (const event of receipts) {
            assert.equal(event.params.transport, 'mqtt');
            assert.equal('IS_MQTT_EXECUTION_ENABLED' in event.params, false);
            assert.ok(Number.isFinite(Date.parse(event.params.timestamp_utc)));
        }
        if (!execution) {
            // Time is the behaviour: give a wrongly started MQTT claim the chance to reach the fake table.
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(f.rows.get(id).status, 'pending', 'execution off: MQTT does not claim the call');
        }
        await f.channel.onBroadcastDoorbell(payload);
        await until(() => events.some(event => event.params.call_id === id &&
            event.name === 'received_from_backend' && event.params.transport === 'broadcast'));
        await until(() => f.rows.get(id).status === 'completed');
        await until(() => resultPackets.some(packet => packet.body.call_id === id));
        assert.deepEqual(resultPackets.find(packet => packet.body.call_id === id), {
            body: { call_id: id }, qos: 1, retain: false,
        });
        assert.equal(f.executed.length, executionsBefore + 1, 'the call runs once');
        assert.deepEqual(claims(id), [execution ? 'mqtt' : 'broadcast']);
    }

    setExecution(true);

    f.add('old-metadata', 'mqtt_v1');
    await send(bell('old-metadata'));
    await until(() => f.rows.get('old-metadata').status === 'completed');
    await f.channel.recoverPendingCalls();
    assert.equal(f.executed.filter(args => args.id === 'old-metadata').length, 1,
        'the call runs once regardless of transport metadata');

    for (const source of ['legacy', 'recovery', 'mqtt']) {
        const id = `result-${source}`;
        f.add(id, source === 'legacy' ? null : 'broadcast_v1');
        f.rows.get(id).metadata.origin_instance = 'backend';
        if (source === 'recovery') await f.channel.recoverPendingCalls();
        else await send(bell(id));
        await until(() => resultPackets.some(packet => packet.body.call_id === id));
        assert.deepEqual(resultPackets.find(packet => packet.body.call_id === id).body, { call_id: id });
        await until(() => events.some(event => event.params.call_id === id && event.name === 'publish_from_device'));
        await until(() => events.some(event => event.params.call_id === id && event.name === 'tool_call_completed'));
        const completion = events.find(event => event.params.call_id === id && event.name === 'tool_call_completed');
        assert.equal(completion.params.outcome, 'success');
        assert.equal('IS_MQTT_EXECUTION_ENABLED' in completion.params, false);
    }
    assert.ok(!events.some(event => event.name === 'device_call_received'));

    // Failed shadow result publications are retried and each attempt is observed.
    const originalPublish = f.channel.mqttReceiver.publishResult.bind(f.channel.mqttReceiver);
    const originalSleep = f.channel.sleep;
    try {
        const id = 'telemetry-retry';
        f.add(id);
        f.rows.get(id).metadata.origin_instance = 'backend';
        let attempts = 0;
        f.channel.mqttReceiver.publishResult = async (...args) => {
            if (args[0] === id && ++attempts <= 2) throw Error('synthetic publish failure');
            return originalPublish(...args);
        };
        f.channel.sleep = async () => {};
        await send(bell(id));
        await until(() => resultPackets.some(packet => packet.body.call_id === id));
        assert.equal(attempts, 3);
        const retryEvents = events.filter(event => event.params.call_id === id && event.name.startsWith('publish_from_device'));
        assert.deepEqual(retryEvents.map(event => event.name), ['publish_from_device_failed', 'publish_from_device_failed', 'publish_from_device']);
        for (const event of retryEvents) assert.equal('IS_MQTT_EXECUTION_ENABLED' in event.params, false);
    } finally {
        f.channel.mqttReceiver.publishResult = originalPublish;
        f.channel.sleep = originalSleep;
    }

    for (const [id, status, result, error] of [
        ['mqtt-sanitized', 'completed', { content: [{ type: 'text', text: 'a\u0000b' }] }, null],
        ['mqtt-failure', 'failed', null, 'bad\u0000message'],
    ]) {
        f.add(id);
        await f.channel.updateCallResult(id, status, result, error, 'backend');
        await until(() => resultPackets.some(packet => packet.body.call_id === id));
        const expected = status === 'completed'
            ? { status, result: { content: [{ type: 'text', text: 'ab' }] } }
            : { status, error_message: 'badmessage' };
        assert.deepEqual(resultPackets.find(packet => packet.body.call_id === id).body, { call_id: id });
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(f.rows.get(id)[key], value);
    }

    f.add('expired');
    f.rows.get('expired').timeout_at = new Date(Date.now() - 1000).toISOString();
    const executionsBeforeExpiry = f.executed.length;
    await send(bell('expired'));
    await until(() => events.some(event => event.params.call_id === 'expired'));
    await f.channel.onBroadcastDoorbell(bell('expired'));
    assert.equal(f.rows.get('expired').status, 'pending', 'the durable row controls expiry');
    assert.equal(f.executed.length, executionsBeforeExpiry, 'an expired row cannot execute through a valid envelope');

    const receiver = f.channel.mqttReceiver;
    receiver.onMalformed = () => malformed++;
    const operationsBeforeMalformed = f.operations.length;
    const valid = bell('malformed');
    const invalid = ['{', { ...valid, user_id: 'foreign' }, { ...valid, device_id: 'foreign' },
        { ...valid, call_id: '../bad' }, { ...valid, extra: 'tool_args' }, { ...valid, expires_at: 'yesterday' },
        // Earlier internal pilots used expires_at; that unsupported envelope is rejected explicitly.
        { ...valid, expires_at: new Date(Date.now() + 60_000).toISOString() },
        { call_id: valid.call_id, user_id: valid.user_id, device_id: valid.device_id, expires_at: new Date(Date.now() + 60_000).toISOString() },
        { ...valid, notification_id: 'malformed:mqtt:1' }, { ...valid, attempt_number: 1 },
        { ...valid, notification_id: 'malformed:mqtt:1', attempt_number: 1 },
        { ...valid, IS_MQTT_EXECUTION_ENABLED: 'true' },
        { ...valid, IS_MQTT_EXECUTION_ENABLED: null }, 'x'.repeat(1025)];
    for (const payload of invalid) await send(payload);
    await until(() => malformed === invalid.length);
    assert.equal(f.operations.length, operationsBeforeMalformed);
    // Retained replay is not an instruction, even if its envelope otherwise validates.
    receiver.client.emit('message', topic, Buffer.from(JSON.stringify(valid)), { retain: true });
    assert.equal(malformed, invalid.length + 1);

    // Two identical result doorbells must each discard their own packet on disconnect.
    const disconnectedClient = receiver.client;
    assert.equal(disconnectedClient.options.reconnectPeriod, 0, 'RemoteChannel owns socket retries');
    const brokerClient = broker.clients[disconnectedClient.options.clientId];
    const originalWrite = brokerClient.conn.write;
    brokerClient.conn.write = () => true;
    try {
        await Promise.all([
            assert.rejects(receiver.publishResult('same-call', 'backend'), /disconnected/),
            assert.rejects(receiver.publishResult('same-call', 'backend'), /disconnected/),
            (async () => {
                await until(() => resultPackets.filter(packet => packet.body.call_id === 'same-call').length === 2);
                disconnectedClient.stream.destroy();
            })(),
        ]);
        assert.deepEqual(Object.keys(disconnectedClient.outgoing), [], 'no unacknowledged result is replayed after reconnect');
    } finally {
        brokerClient.conn.write = originalWrite;
    }
    await until(() => !f.channel.mqttReady);
    assert.equal(f.channel.isReachable(), true, 'an MQTT outage does not withdraw healthy Broadcast');
    setExecution(false);
    f.add('while-mqtt-disconnected');
    await f.channel.onBroadcastDoorbell(bell('while-mqtt-disconnected'));
    await until(() => f.rows.get('while-mqtt-disconnected').status === 'completed');
    await until(() => claims('while-mqtt-disconnected').length === 1);
    assert.deepEqual(claims('while-mqtt-disconnected'), ['broadcast']);
    f.add('missed-while-disconnected');
    // Allow the specified 10-second retry delay plus time for the local TLS handshake.
    await until(() => f.channel.mqttReady, 15_000);
    assert.notEqual(f.channel.mqttReceiver, receiver, 'the retry creates a fresh receiver');
    await until(() => f.capabilities.at(-1).transport_mqtt_v1 === true);
    // Doorbells sent while MQTT was down are not delivered later, so the reconnect scans for waiting calls.
    await until(() => f.rows.get('missed-while-disconnected').status === 'completed');
    await until(() => claims('missed-while-disconnected').length === 1);
    assert.deepEqual(claims('missed-while-disconnected'), ['recovery']);
    setExecution(true);
    f.add('reconnected');
    await send(bell('reconnected'));
    await until(() => f.rows.get('reconnected').status === 'completed');

    // A pending claim from the old session must never execute after shutdown.
    const race = fixture();
    let resolveClaim;
    race.channel.client = { from: () => {
        const query = { update: () => query, eq: () => query, gt: () => query,
            select: () => new Promise(resolve => { resolveClaim = resolve; }) };
        return query;
    } };
    const claim = race.channel.onDoorbell(bell('race'));
    await race.channel.unsubscribe();
    resolveClaim({ data: [{ id: 'race', device_id: 'device' }], error: null });
    await claim;
    assert.equal(race.executed.length, 0);

    await f.channel.unsubscribe();
    assert.equal(f.channel.mqttReady, false);
    assert.equal(f.channel.mqttReceiver, null);
    const afterStop = f.operations.length;
    await f.channel.onMqttDoorbell(bell('stopped'));
    await f.channel.onBroadcastDoorbell(bell('stopped'));
    assert.equal(f.operations.length, afterStop);

    pendingReceiver = new MqttTransport(config, 'owner', 'pending-device', async () => {}, async () => {});
    const startup = pendingReceiver.start();
    const stopped = assert.rejects(startup, /stopped/);
    await pendingReceiver.stop();
    await stopped;

    assert.throws(() => mqttDoorbellTopic('owner/foreign', 'device'), /identity/);
    console.log('PASS MQTT shadow doorbells: observation-only receipt, Broadcast execution, identifier-only results, sanitized persistence, concurrent result cleanup, mutual TLS, telemetry, duplicates, validation, reconnect and shutdown');
} finally {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    for (const channel of channels) await channel.stopMqttTransport();
    await pendingReceiver?.stop();
    await publisher?.endAsync(true);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
    https.request = originalRequest;
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalGetId;
    syncBuiltinESMExports();
}
