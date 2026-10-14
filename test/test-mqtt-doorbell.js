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
process.env.IS_MQTT_EXECUTION_ENABLED = 'true';
process.env.IS_MQTT_RESULT_PAYLOAD_ENABLED = 'true';
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { MCPDevice } = await import('../dist/remote-device/device.js');
const { MqttTransport, createMqttConfig, mqttDoorbellTopic } = await import('../dist/remote-device/mqtt/mqtt-transport.js');
const { configManager } = await import('../dist/config-manager.js');

const until = async (condition) => {
    const deadline = Date.now() + 4000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for MQTT fixture');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};
const events = [];
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
const bell = id => ({ call_id: id, user_id: 'owner', device_id: 'device', expires_at: new Date(Date.now() + 60_000).toISOString(),
    notification_id: `${id}:mqtt:1`, attempt_number: 1 });

function fixture() {
    const rows = new Map();
    const operations = [];
    const capabilities = [];
    const executed = [];
    const channel = new RemoteChannel();
    channels.push(channel);
    Object.assign(channel, {
        _user: { id: 'owner' }, deviceId: 'device', presenceTracked: true,
        channel: { state: 'joined', untrack: async () => {}, unsubscribe: async () => {} },
        transportCapableWritten: true,
        // Keep capability serialization real without status/heartbeat timers in the fixture.
        syncReachabilityStatus: () => {}, scheduleHeartbeat: () => {},
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
    const add = id => rows.set(id, { id, device_id: 'device', user_id: 'owner', status: 'pending',
        timeout_at: new Date(Date.now() + 60_000).toISOString(), tool_name: 'read_file', tool_args: { id }, metadata: {} });
    return { channel, rows, operations, capabilities, executed, add };
}

try {
    const f = fixture();
    await f.channel.setTransportCapable(true);
    assert.equal(f.channel.isReachable(), false, 'MQTT must subscribe before advertising online');
    await f.channel.startMqttTransport(config);
    assert.equal(f.channel.isReachable(), true);
    assert.equal(f.capabilities.at(-1).transport_broadcast_v1, true);
    assert.equal(f.capabilities.at(-1).transport_mqtt_v1, true);
    assert.equal(f.capabilities.at(-1).transport_mqtt_observability_v1, true);
    publisher = await connectAsync(url, tlsOptions);
    const topic = mqttDoorbellTopic('owner', 'device');
    const send = (payload, options = {}) => publisher.publishAsync(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 1, ...options });
    const resultTopic = 'dc/mqtt/v1/users/owner/devices/device/result-backend';
    const resultPackets = [];
    publisher.on('message', (topic, bytes, packet) => {
        if (topic === resultTopic) resultPackets.push({ body: JSON.parse(bytes.toString()), qos: packet.qos, retain: packet.retain });
    });
    await publisher.subscribeAsync(resultTopic, { qos: 1 });

    f.add('mqtt-execution');
    f.rows.get('mqtt-execution').metadata.origin_instance = 'backend';
    const before = f.operations.length;
    await f.channel.onBroadcastDoorbell(bell('mqtt-execution'));
    assert.equal(f.operations.length, before, 'Broadcast observes but never claims in MQTT mode');
    const executionsBefore = f.executed.length;
    await Promise.all([send(bell('mqtt-execution')), send(bell('mqtt-execution'))]);
    await until(() => f.rows.get('mqtt-execution').status === 'completed');
    await until(() => events.some(e => e.name === 'received' && e.params.call_id === 'mqtt-execution' && e.params.transport === 'mqtt'));
    await until(() => events.some(e => e.name === 'received' && e.params.call_id === 'mqtt-execution' && e.params.transport === 'broadcast'));
    assert.equal(f.executed.length, executionsBefore + 1, 'duplicate MQTT packets execute once');
    const claims = f.operations.filter(op => op.update?.status === 'executing' && op.filters.id === 'mqtt-execution');
    assert.ok(claims.length >= 1);
    await until(() => resultPackets.length === 1);
    assert.deepEqual(resultPackets[0], { body: { call_id: 'mqtt-execution', data: { status: 'completed', result: { content: [] } } }, qos: 1, retain: false });

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
        assert.deepEqual(resultPackets.find(packet => packet.body.call_id === id).body, { call_id: id, data: expected });
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(f.rows.get(id)[key], value);
    }

    f.add('expired');
    const expired = bell('expired');
    expired.expires_at = new Date(Date.now() - 1000).toISOString();
    const readsBeforeExpiry = f.operations.length;
    await send(expired);
    await until(() => events.some(e => e.params.call_id === 'expired'));
    assert.equal(f.operations.length, readsBeforeExpiry);

    const receiver = f.channel.mqttReceiver;
    const limit = 128 * 1024;
    const overhead = Buffer.byteLength(JSON.stringify({ call_id: 'size-limit', data: { status: 'completed', result: '' } }));
    const atLimit = { status: 'completed', result: 'x'.repeat(limit - overhead) };
    const sizeResultsBefore = resultPackets.length;
    await receiver.publishResult('size-limit', 'backend', atLimit);
    await receiver.publishResult('size-limit', 'backend', { ...atLimit, result: `${atLimit.result}x` });
    await receiver.publishResult('size-limit', 'backend', { status: 'completed', result: 'é'.repeat(80 * 1024) });
    await until(() => resultPackets.length === sizeResultsBefore + 3);
    assert.deepEqual(resultPackets[sizeResultsBefore].body, { call_id: 'size-limit', data: atLimit });
    for (const packet of resultPackets.slice(sizeResultsBefore + 1)) assert.deepEqual(packet.body, { call_id: 'size-limit' });

    receiver.onMalformed = () => malformed++;
    const valid = bell('malformed');
    const invalid = ['{', { ...valid, user_id: 'foreign' }, { ...valid, device_id: 'foreign' },
        { ...valid, call_id: '../bad' }, { ...valid, extra: 'tool_args' }, { ...valid, expires_at: 'yesterday' },
        { ...valid, notification_id: {} }, 'x'.repeat(1025)];
    for (const payload of invalid) await send(payload);
    await until(() => malformed === invalid.length);
    assert.equal(f.operations.length, readsBeforeExpiry);
    // Retained replay is not an instruction, even if its envelope otherwise validates.
    receiver.client.emit('message', topic, Buffer.from(JSON.stringify(valid)), { retain: true });
    assert.equal(malformed, invalid.length + 1);

    // Two identical result payloads must each discard their own packet on disconnect.
    const brokerClient = broker.clients[receiver.client.options.clientId];
    const originalWrite = brokerClient.conn.write;
    brokerClient.conn.write = () => true;
    receiver.client.options.reconnectPeriod = 20;
    try {
        await Promise.all([
            assert.rejects(receiver.publishResult('same-call', 'backend', { status: 'completed', result: null }), /disconnected/),
            assert.rejects(receiver.publishResult('same-call', 'backend', { status: 'completed', result: null }), /disconnected/),
            (async () => {
                await until(() => resultPackets.filter(packet => packet.body.call_id === 'same-call').length === 2);
                receiver.client.stream.destroy();
            })(),
        ]);
        assert.deepEqual(Object.keys(receiver.client.outgoing), [], 'no unacknowledged result is replayed after reconnect');
        assert.equal(receiver.resultPublishes, 0);
    } finally {
        brokerClient.conn.write = originalWrite;
    }
    await until(() => !f.channel.mqttReady);
    assert.equal(f.channel.isReachable(), false, 'MQTT execution is not online while its subscription is down');
    f.add('missed-while-disconnected');
    const disconnectedOperations = f.operations.length;
    await f.channel.onBroadcastDoorbell(bell('missed-while-disconnected'));
    assert.equal(f.operations.length, disconnectedOperations, 'an MQTT outage does not enable Broadcast execution');
    await until(() => f.channel.mqttReady);
    await until(() => f.capabilities.at(-1).transport_mqtt_v1 === true);
    await until(() => f.rows.get('missed-while-disconnected').status === 'completed');
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
    console.log('PASS MQTT doorbells: execution, optional sanitized result payloads, oversized fallback, concurrent result cleanup, mutual TLS, telemetry, duplicates, validation, reconnect and shutdown');
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
