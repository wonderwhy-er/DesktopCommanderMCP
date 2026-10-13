#!/usr/bin/env node
import assert from 'node:assert/strict';
import { getMqttBrokerUrl, MQTT_BROKER_URLS } from '../dist/remote-device/config.js';
import { createMqttConfig } from '../dist/remote-device/mqtt-transport.js';

assert.equal(getMqttBrokerUrl('https://staging-mcp.desktopcommander.app'), MQTT_BROKER_URLS.staging);
assert.throws(() => getMqttBrokerUrl('https://mcp.desktopcommander.app'), /Production MQTT broker URL is not configured/);
for (const server of ['https://unknown.example.test', 'https://staging-mcp.desktopcommander.app.example.test',
    'https://localhost:3007', 'https://mcp.localhost.localdomain:3007', 'https://127.0.0.1:3007', 'https://[::1]:3007']) {
    assert.throws(() => getMqttBrokerUrl(server), /not configured/);
}

// Exercise production selection with a test-only endpoint until its real value is supplied.
const production = MQTT_BROKER_URLS.production;
try {
    MQTT_BROKER_URLS.production = 'mqtts://production-test.iot.eu-west-1.amazonaws.com:8883';
    assert.equal(getMqttBrokerUrl('https://mcp.desktopcommander.app'), MQTT_BROKER_URLS.production);
    assert.equal(getMqttBrokerUrl('https://staging-mcp.desktopcommander.app'), MQTT_BROKER_URLS.staging);
} finally {
    MQTT_BROKER_URLS.production = production;
}

const credentials = { url: MQTT_BROKER_URLS.staging, cert: 'fixture-cert', key: 'fixture-key' };
const config = createMqttConfig(credentials);
assert.equal(config.url, credentials.url);
assert.equal(config.options.cert, credentials.cert);
assert.equal(config.options.key, credentials.key);
assert.equal(config.options.rejectUnauthorized, true);
assert.equal(config.options.ca, undefined, 'broker verification uses the system trust store');
for (const url of ['mqtt://127.0.0.1:1883', 'mqtt://public.example.test', 'wss://example.test']) {
    assert.throws(() => createMqttConfig({ ...credentials, url }), /must use mqtts/);
}
for (const url of ['invalid', 'mqtts://user:secret@example.test', 'mqtts://example.test/path',
    'mqtts://example.test?secret=yes', 'mqtts://example.test#fragment']) {
    assert.throws(() => createMqttConfig({ ...credentials, url }), /valid URL|credentials, paths, or query/);
}
for (const patch of [{ cert: '' }, { key: '' }]) {
    assert.throws(() => createMqttConfig({ ...credentials, ...patch }), /enrolled device/);
}
console.log('PASS MQTT config: staging/production selection, unknown hosts, mandatory TLS and enrolled credentials');
