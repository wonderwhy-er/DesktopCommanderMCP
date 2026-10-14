#!/usr/bin/env node
import assert from 'node:assert/strict';
import { getMqttBrokerUrl } from '../dist/remote-device/mqtt/config.js';
import { createMqttConfig } from '../dist/remote-device/mqtt/mqtt-transport.js';

const defaultBroker = 'mqtts://a1vw7p0stdnykd-ats.iot.eu-west-1.amazonaws.com:8883';
const originalBroker = process.env.MQTT_BROKER_URL;
const flagNames = ['IS_MQTT_RESULT_PAYLOAD_ENABLED', 'IS_MQTT_EXECUTION_ENABLED'];
const originalFlags = flagNames.map(name => process.env[name]);
try {
    delete process.env.MQTT_BROKER_URL;
    assert.equal(getMqttBrokerUrl(), defaultBroker);
    process.env.MQTT_BROKER_URL = '';
    assert.equal(getMqttBrokerUrl(), defaultBroker);
    process.env.MQTT_BROKER_URL = 'mqtts://custom.example.test:8883';
    assert.equal(getMqttBrokerUrl(), process.env.MQTT_BROKER_URL);
    for (const [index, flag] of [undefined, '', 'false', 'TRUE', 'true'].entries()) {
        for (const name of flagNames) {
            if (flag === undefined) delete process.env[name];
            else process.env[name] = flag;
        }
        // A fresh module evaluates the startup constants for each environment.
        const flags = await import(`../dist/remote-device/mqtt/config.js?flags=${index}`);
        for (const name of flagNames) assert.equal(flags[name], flag === 'true', `${name}=${flag}`);
    }
} finally {
    if (originalBroker === undefined) delete process.env.MQTT_BROKER_URL;
    else process.env.MQTT_BROKER_URL = originalBroker;
    flagNames.forEach((name, index) => {
        if (originalFlags[index] === undefined) delete process.env[name];
        else process.env[name] = originalFlags[index];
    });
}

const credentials = { url: defaultBroker, cert: 'fixture-cert', key: 'fixture-key' };
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
console.log('PASS MQTT config: default broker, environment overrides, false-by-default flags, mandatory TLS and enrolled credentials');
