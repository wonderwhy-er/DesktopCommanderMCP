#!/usr/bin/env node

/**
 * Opted-out transport events must never be replayed after telemetry is enabled.
 * Network requests and the retry clock are replaced, as in the queue tests.
 * Run after building: node test/run-all-tests.js test-transport-telemetry-opt-out.js
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { configManager } from '../dist/config-manager.js';
import { observeTransport } from '../dist/remote-device/transport-telemetry.js';
import { runIfMain } from './helpers/run-if-main.js';

const ADDRESS = 'https://telemetry.example.test/collect';
const RETRY_MS = 5000;
const HOLD_MS = 10 * 60 * 1000;
const sent = [];

function recordingRequest(url, options, onResponse) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = body => sent.push(JSON.parse(body).events[0].params.call_id);
  request.end = () => {
    const response = new EventEmitter();
    response.statusCode = 204;
    response.resume = () => {};
    onResponse(response);
    queueMicrotask(() => response.emit('end'));
  };
  return request;
}

function observe(callId) {
  assert.ok(observeTransport({
    stage: 'received',
    payload: { call_id: callId, device_id: 'device-1', user_id: 'user-1' },
    deviceId: 'device-1',
    userId: 'user-1',
    transport: 'broadcast',
  }), 'the test event must be a valid transport observation');
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const cases = [
  {
    name: 'an event recorded while disabled is dropped before a later enable and address',
    run: async () => {
      configManager.getValue = async key => key === 'telemetryEnabled' ? false : undefined;
      observe('call-disabled');
      await settle();
      assert.deepEqual(sent, []);

      configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
      observe('call-enabled-first');
      await settle();
      process.env.DC_TELEMETRY_URL = ADDRESS;
      mock.timers.tick(RETRY_MS);
      await settle();
      observe('call-enabled-second');
      await settle();
      assert.deepEqual(sent, ['call-enabled-first', 'call-enabled-second'],
        'only events recorded while enabled may be sent, in arrival order');
    },
  },
  {
    name: 'a slow consent lookup cannot let a later enabled event overtake the first',
    run: async () => {
      process.env.DC_TELEMETRY_URL = ADDRESS;
      let releaseFirst;
      const firstConsent = new Promise(resolve => { releaseFirst = resolve; });
      let first = true;
      configManager.getValue = async key => {
        if (key !== 'telemetryEnabled') return undefined;
        if (!first) return true;
        first = false;
        return await firstConsent;
      };
      try {
        observe('call-slow-consent');
        await settle();
        observe('call-fast-consent');
        await settle();
        assert.deepEqual(sent, [], 'later events must wait for the first consent lookup');
        releaseFirst(true);
        await settle();
        assert.deepEqual(sent, ['call-slow-consent', 'call-fast-consent']);
      } finally {
        releaseFirst(true);
        await settle();
      }
    },
  },
];

export default async function runTests() {
  const original = {
    request: https.request,
    getValue: configManager.getValue,
    getOrCreateClientId: configManager.getOrCreateClientId,
    disableTelemetry: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY,
    telemetryUrl: process.env.DC_TELEMETRY_URL,
  };
  let failures = 0;
  try {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = recordingRequest;
    syncBuiltinESMExports();
    for (const { name, run } of cases) {
      sent.length = 0;
      delete process.env.DC_TELEMETRY_URL;
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      try {
        await run();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}\n${error.stack}`);
      } finally {
        // Drain or expire held events so no state leaks into the next case.
        configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
        process.env.DC_TELEMETRY_URL = ADDRESS;
        mock.timers.tick(HOLD_MS * 2);
        await settle();
        mock.timers.reset();
      }
    }
  } finally {
    https.request = original.request;
    syncBuiltinESMExports();
    configManager.getValue = original.getValue;
    configManager.getOrCreateClientId = original.getOrCreateClientId;
    setEnv('DESKTOP_COMMANDER_DISABLE_TELEMETRY', original.disableTelemetry);
    setEnv('DC_TELEMETRY_URL', original.telemetryUrl);
  }
  console.log(`Transport telemetry opt-out: ${failures} failing test(s).`);
  return failures === 0;
}

runIfMain(import.meta.url, runTests);
