#!/usr/bin/env node

/**
 * A telemetry send has a 3-second absolute deadline, even while its response
 * keeps sending data. A stalled send must release the transport FIFO and allow
 * the built-in proxy fallback. HTTP and time are fake; no network is used.
 *
 * Run after building, or through the normal isolated test runner:
 *   node test/run-all-tests.js test-telemetry-send-deadline.js
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { configManager } from '../dist/config-manager.js';
import { capture } from '../dist/utils/capture.js';
import { observeTransport } from '../dist/remote-device/transport-telemetry.js';
import { runIfMain } from './helpers/run-if-main.js';

const ADDRESS = 'https://telemetry.example.test/collect';
const BUILT_IN = 'https://telemetry.desktopcommander.app/mp/collect';
const FALLBACK = 'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/mp/collect';
const DEADLINE_MS = 3000;
const requests = [];
let mode;

/** Model socket inactivity separately: each chunk resets this timeout. */
function fakeRequest(url, options, onResponse) {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.statusCode = 200;
  response.resume = () => {};
  const record = { url: String(url), request, response, payload: null, destroys: 0 };
  requests.push(record);
  let idleTimer;
  let idleMs;
  let onIdle;
  const clearIdle = () => { clearTimeout(idleTimer); };
  const resetIdle = () => {
    clearIdle();
    if (onIdle) idleTimer = setTimeout(onIdle, idleMs);
  };
  request.setTimeout = (ms, callback) => {
    idleMs = ms;
    onIdle = callback;
    resetIdle();
    return request;
  };
  request.destroy = () => {
    record.destroys++;
    clearIdle();
    // destroy() without an error need not emit 'error'; the deadline itself
    // must settle the send rather than relying on an error from this fake.
    return request;
  };
  request.write = (body) => { record.payload = JSON.parse(body); };
  response.on('data', resetIdle);
  response.on('end', clearIdle);
  request.on('error', clearIdle);
  request.end = () => {
    const first = requests.length === 1;
    if (first && mode === 'no-response') return;
    if (first && mode === 'request-error') {
      queueMicrotask(() => request.emit('error', new Error('offline')));
      return;
    }
    onResponse(response);
    if (!(first && mode === 'trickle')) queueMicrotask(() => response.emit('end'));
  };
  return request;
}

function observe(callId) {
  observeTransport({
    stage: 'received',
    payload: { call_id: callId, device_id: 'device-1', user_id: 'user-1' },
    deviceId: 'device-1',
    userId: 'user-1',
    transport: 'broadcast',
  });
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms) {
  mock.timers.tick(ms);
  await settle();
}

function callIds() {
  return requests.map(({ payload }) => payload.events[0].params.call_id);
}

const cases = [
  {
    name: 'trickling response reaches its deadline and releases the transport FIFO',
    mode: 'trickle',
    run: async () => {
      observe('call-trickle');
      observe('call-next');
      await settle();
      assert.deepEqual(callIds(), ['call-trickle']);
      // Less than the 3-second inactivity limit between every chunk.
      for (let i = 0; i < 2; i++) {
        await advance(1000);
        requests[0].response.emit('data', Buffer.from('.'));
      }
      await advance(999);
      assert.deepEqual(callIds(), ['call-trickle'], 'FIFO waits before the deadline');
      await advance(1);
      assert.equal(requests[0].destroys, 1, 'the absolute deadline must destroy the trickling request');
      assert.deepEqual(callIds(), ['call-trickle', 'call-next'], 'the next queued event must drain at the deadline');
      assert.ok(requests.every(({ url }) => url === ADDRESS), 'remote transport stays on its configured endpoint');
      assert.equal(requests[1].payload.user_id, 'user-1');
      assert.equal(requests[1].payload.telemetry_type, 'transport');
    },
  },
  {
    name: 'deadline also releases the FIFO when no response headers arrive',
    mode: 'no-response',
    run: async () => {
      observe('call-silent');
      observe('call-next');
      await settle();
      await advance(DEADLINE_MS);
      assert.equal(requests[0].destroys, 1);
      assert.deepEqual(callIds(), ['call-silent', 'call-next']);
    },
  },
  {
    name: 'a trickling built-in proxy is a failed send and starts its fallback at the deadline',
    mode: 'trickle',
    run: async () => {
      delete process.env.DC_TELEMETRY_URL;
      await capture('telemetry_deadline_test');
      await settle();
      assert.deepEqual(requests.map(({ url }) => url), [BUILT_IN]);
      await advance(1000);
      requests[0].response.emit('data', Buffer.from('.'));
      await advance(1000);
      requests[0].response.emit('data', Buffer.from('.'));
      await advance(1000);
      assert.deepEqual(requests.map(({ url }) => url), [BUILT_IN, FALLBACK], 'deadline must settle false so fallback starts');
      assert.equal(requests[0].destroys, 1);
    },
  },
  ...['complete', 'request-error'].map((mode) => ({
    name: `a ${mode === 'complete' ? 'completed response' : 'request error'} cancels the send deadline`,
    mode,
    run: async () => {
      observe('call-first');
      observe('call-next');
      await settle();
      assert.deepEqual(callIds(), ['call-first', 'call-next']);
      await advance(DEADLINE_MS * 2);
      assert.deepEqual(requests.map(({ destroys }) => destroys), [0, 0], 'settled requests must not be destroyed later');
      assert.deepEqual(callIds(), ['call-first', 'call-next'], 'settled sends must not retry');
    },
  })),
];

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
    configManager.getValue = async (key) => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = fakeRequest;
    syncBuiltinESMExports();
    for (const testCase of cases) {
      requests.length = 0;
      mode = testCase.mode;
      process.env.DC_TELEMETRY_URL = ADDRESS;
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      try {
        await testCase.run();
        console.log(`✅ PASS  ${testCase.name}`);
      } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${testCase.name}\n     ${error.message.split('\n')[0]}`);
      } finally {
        // Release a pre-fix stalled send so it cannot leak into the next case.
        // Each release can synchronously start another request after an await.
        for (let i = 0; i < requests.length; i++) {
          requests[i].response.emit('end');
          await settle();
        }
        mock.timers.reset();
      }
    }
  } finally {
    https.request = original.request;
    syncBuiltinESMExports();
    configManager.getValue = original.getValue;
    configManager.getOrCreateClientId = original.getOrCreateClientId;
    restoreEnv('DESKTOP_COMMANDER_DISABLE_TELEMETRY', original.disableTelemetry);
    restoreEnv('DC_TELEMETRY_URL', original.telemetryUrl);
  }
  console.log(`\n${failures ? '🔴' : '✅'} telemetry send deadline: ${failures} failing test(s).`);
  return failures === 0;
}

runIfMain(import.meta.url, runTests);
