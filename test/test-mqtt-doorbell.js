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
const { rolloutManager } = await import('../dist/remote-device/rollouts.js');
rolloutManager.update({ IS_MQTT_EXECUTION_ENABLED: true });
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
    IS_MQTT_EXECUTION_ENABLED: true });

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
            let transportFilter;
            let update;
            let selected = false;
            let claimed = false;
            const query = {
                update(value) { update = value; return query; },
                select() { selected = true; return query; },
                eq(key, value) { filters[key] = value; return query; },
                or(value) {
                    assert.ok(['metadata->>transport.eq.mqtt_v1', 'metadata->>transport.is.null,metadata->>transport.neq.mqtt_v1'].includes(value));
                    transportFilter = value;
                    return query;
                },
                gt(key, value) { assert.equal(key, 'timeout_at'); assert.equal(value, 'now'); return query; },
                order() { return query; },
                limit(value) { assert.equal(value, 100); return query; },
                abortSignal() { return query; },
                maybeSingle() { return query; },
                then(resolve, reject) {
                    return Promise.resolve().then(() => {
                        if (table === 'mcp_devices') { capabilities.push(update.capabilities); return { error: null }; }
                        assert.equal(table, 'mcp_remote_calls');
                        operations.push({ filters, update, transportFilter });
                        if (!update && !filters.id) {
                            return { data: [...rows.values()].filter(row => row.device_id === filters.device_id &&
                                row.status === 'pending' && Date.parse(row.timeout_at) > Date.now()), error: null };
                        }
                        const row = rows.get(filters.id);
                        const matchesTransport = !transportFilter || (transportFilter === 'metadata->>transport.eq.mqtt_v1'
                            ? row?.metadata?.transport === 'mqtt_v1' : row?.metadata?.transport !== 'mqtt_v1');
                        if (update?.status === 'executing') {
                            assert.equal(filters.device_id, 'device');
                            assert.equal(filters.status, 'pending');
                            claimed = !!row && matchesTransport && row.status === 'pending' && row.device_id === filters.device_id && Date.parse(row.timeout_at) > Date.now();
                            if (claimed) Object.assign(row, update);
                            return { data: claimed ? [{ ...row }] : [], error: null };
                        }
                        if (row && update) Object.assign(row, update);
                        return { data: selected && matchesTransport ? row : null, error: null };
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
    const add = (id, transport = 'mqtt_v1') => rows.set(id, { id, device_id: 'device', user_id: 'owner', status: 'pending',
        timeout_at: new Date(Date.now() + 60_000).toISOString(), tool_name: 'read_file', tool_args: { id }, metadata: transport ? { transport } : {} });
    return { channel, rows, operations, capabilities, executed, add };
}

try {
    const f = fixture();
    await f.channel.setTransportCapable(true);
    assert.equal(f.channel.isReachable(), true, 'Broadcast readiness cannot depend on cached MQTT execution');
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
    assert.equal(f.operations.length, before + 1, 'Broadcast checks the stored transport in its claim');
    assert.equal(f.rows.get('mqtt-execution').status, 'pending', 'Broadcast cannot claim an MQTT-selected call');
    const executionsBefore = f.executed.length;
    await Promise.all([send(bell('mqtt-execution')), send(bell('mqtt-execution'))]);
    await until(() => f.rows.get('mqtt-execution').status === 'completed');
    await until(() => events.some(e => e.name === 'received' && e.params.call_id === 'mqtt-execution' && e.params.transport === 'mqtt'));
    await until(() => events.some(e => e.name === 'received' && e.params.call_id === 'mqtt-execution' && e.params.transport === 'broadcast'));
    assert.equal(f.executed.length, executionsBefore + 1, 'duplicate MQTT packets execute once');
    const claims = f.operations.filter(op => op.update?.status === 'executing' && op.filters.id === 'mqtt-execution');
    assert.ok(claims.length >= 1);
    await until(() => resultPackets.length === 1);
    assert.deepEqual(resultPackets[0], { body: { call_id: 'mqtt-execution' }, qos: 1, retain: false });

    for (const cached of [undefined, false, true]) {
        rolloutManager.update(cached === undefined ? {} : { IS_MQTT_EXECUTION_ENABLED: cached });
        const id = `cache-${cached}`;
        f.add(id);
        await send(bell(id));
        await until(() => f.rows.get(id).status === 'completed');

        const shadowId = `shadow-${cached}`;
        f.add(shadowId, 'broadcast_v1');
        const beforeShadow = f.operations.length;
        await send({ ...bell(shadowId), IS_MQTT_EXECUTION_ENABLED: false });
        await until(() => events.some(event => event.params.call_id === shadowId));
        const receipt = events.find(event => event.params.call_id === shadowId && event.name === 'received').params;
        assert.equal(receipt.IS_MQTT_EXECUTION_ENABLED, false, 'shadow receipt preserves an explicit false');
        assert.equal(f.operations.length, beforeShadow, 'false packet is observed without a database claim');
        await send(bell(shadowId));
        await until(() => f.operations.length > beforeShadow);
        assert.equal(f.rows.get(shadowId).status, 'pending', 'a forged true packet cannot claim a Broadcast row');
        await f.channel.onBroadcastDoorbell(bell(shadowId));
        await until(() => f.rows.get(shadowId).status === 'completed');
    }
    for (const fields of [{}, { IS_MQTT_EXECUTION_ENABLED: true }]) {
        const id = `legacy-mqtt-${Object.keys(fields).join('-') || 'none'}`;
        f.add(id);
        const payload = bell(id);
        delete payload.IS_MQTT_EXECUTION_ENABLED;
        Object.assign(payload, fields);
        await send(payload);
        await until(() => f.rows.get(id).status === 'completed');
        await until(() => events.some(event => event.params.call_id === id && event.name === 'received'));
        const receipt = events.find(event => event.params.call_id === id && event.name === 'received').params;
        assert.equal(receipt.IS_MQTT_EXECUTION_ENABLED, fields.IS_MQTT_EXECUTION_ENABLED, 'legacy receipt omits an unknown flag');
    }
    f.add('legacy-broadcast', null);
    await f.channel.onBroadcastDoorbell(bell('legacy-broadcast'));
    await until(() => f.rows.get('legacy-broadcast').status === 'completed');

    for (const source of ['legacy', 'recovery', 'broadcast']) {
        const id = `result-${source}`;
        f.add(id, source === 'broadcast' ? 'broadcast_v1' : 'mqtt_v1');
        f.rows.get(id).metadata.origin_instance = 'backend';
        if (source === 'legacy') {
            const payload = bell(id);
            delete payload.IS_MQTT_EXECUTION_ENABLED;
            await send(payload);
        } else if (source === 'recovery') {
            await f.channel.recoverPendingCalls();
        } else {
            await f.channel.onBroadcastDoorbell(bell(id));
        }
        await until(() => resultPackets.some(packet => packet.body.call_id === id));
        const body = resultPackets.find(packet => packet.body.call_id === id).body;
        assert.deepEqual(body, { call_id: id });
        await until(() => events.some(event => event.params.call_id === id && event.name === 'mqtt_result_publish'));
        for (const stage of ['device_call_received', 'tool_call_completed', 'mqtt_result_send_attempt', 'mqtt_result_publish']) {
            const event = events.find(event => event.params.call_id === id && event.name === stage);
            assert.ok(event, `missing ${stage}`);
            assert.equal(event.params.IS_MQTT_EXECUTION_ENABLED, source !== 'broadcast');
        }
    }

    // Retry telemetry retains the call's execution mode after the device cache changes.
    const originalPublish = f.channel.mqttReceiver.publishResult.bind(f.channel.mqttReceiver);
    const originalSleep = f.channel.sleep;
    try {
        const id = 'telemetry-retry';
        f.add(id);
        f.rows.get(id).metadata.origin_instance = 'backend';
        let attempts = 0;
        f.channel.mqttReceiver.publishResult = async (...args) => {
            if (args[0] === id && ++attempts === 1) throw Error('synthetic publish failure');
            return originalPublish(...args);
        };
        f.channel.sleep = async () => { rolloutManager.update({ IS_MQTT_EXECUTION_ENABLED: false }); };
        await send(bell(id));
        await until(() => events.some(event => event.params.call_id === id && event.name === 'mqtt_result_publish'));
        const retryEvents = events.filter(event => event.params.call_id === id && event.name.startsWith('mqtt_result_'));
        assert.deepEqual(retryEvents.map(event => event.name), ['mqtt_result_send_attempt', 'mqtt_result_publish_failed', 'mqtt_result_send_attempt', 'mqtt_result_publish']);
        for (const event of retryEvents) assert.equal(event.params.IS_MQTT_EXECUTION_ENABLED, true);
    } finally {
        f.channel.mqttReceiver.publishResult = originalPublish;
        f.channel.sleep = originalSleep;
    }

    for (const [id, status, result, error] of [
        ['mqtt-sanitized', 'completed', { content: [{ type: 'text', text: 'a\u0000b' }] }, null],
        ['mqtt-failure', 'failed', null, 'bad\u0000message'],
    ]) {
        f.add(id);
        await f.channel.updateCallResult(id, status, result, error, 'backend', { IS_MQTT_EXECUTION_ENABLED: true });
        await until(() => resultPackets.some(packet => packet.body.call_id === id));
        const expected = status === 'completed'
            ? { status, result: { content: [{ type: 'text', text: 'ab' }] } }
            : { status, error_message: 'badmessage' };
        assert.deepEqual(resultPackets.find(packet => packet.body.call_id === id).body, { call_id: id });
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
    receiver.onMalformed = () => malformed++;
    const valid = bell('malformed');
    const invalid = ['{', { ...valid, user_id: 'foreign' }, { ...valid, device_id: 'foreign' },
        { ...valid, call_id: '../bad' }, { ...valid, extra: 'tool_args' }, { ...valid, expires_at: 'yesterday' },
        { ...valid, notification_id: 'malformed:mqtt:1' }, { ...valid, attempt_number: 1 },
        { ...valid, notification_id: 'malformed:mqtt:1', attempt_number: 1 },
        { ...valid, IS_MQTT_EXECUTION_ENABLED: undefined, notification_id: 'malformed:mqtt:1', attempt_number: 1 },
        { ...valid, IS_MQTT_EXECUTION_ENABLED: 'true' },
        { ...valid, IS_MQTT_EXECUTION_ENABLED: null }, 'x'.repeat(1025)];
    for (const payload of invalid) await send(payload);
    await until(() => malformed === invalid.length);
    assert.equal(f.operations.length, readsBeforeExpiry);
    // Retained replay is not an instruction, even if its envelope otherwise validates.
    receiver.client.emit('message', topic, Buffer.from(JSON.stringify(valid)), { retain: true });
    assert.equal(malformed, invalid.length + 1);

    // Two identical result doorbells must each discard their own packet on disconnect.
    const brokerClient = broker.clients[receiver.client.options.clientId];
    const originalWrite = brokerClient.conn.write;
    brokerClient.conn.write = () => true;
    receiver.client.options.reconnectPeriod = 20;
    try {
        await Promise.all([
            assert.rejects(receiver.publishResult('same-call', 'backend'), /disconnected/),
            assert.rejects(receiver.publishResult('same-call', 'backend'), /disconnected/),
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
    assert.equal(f.channel.isReachable(), true, 'an MQTT outage does not withdraw healthy Broadcast');
    f.add('missed-while-disconnected');
    const disconnectedOperations = f.operations.length;
    await f.channel.onBroadcastDoorbell(bell('missed-while-disconnected'));
    assert.equal(f.operations.length, disconnectedOperations + 1);
    assert.equal(f.rows.get('missed-while-disconnected').status, 'pending', 'an MQTT outage cannot switch the stored transport');
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
        const query = { update: () => query, eq: () => query, or: () => query, gt: () => query,
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
    console.log('PASS MQTT doorbells: execution, identifier-only results, sanitized persistence, concurrent result cleanup, mutual TLS, telemetry, duplicates, validation, reconnect and shutdown');
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
