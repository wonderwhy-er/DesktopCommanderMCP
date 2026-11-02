#!/usr/bin/env node

/**
 * Transport events before the telemetry address is known (src/utils/capture.ts).
 * A remote device sets DC_TELEMETRY_URL from the server's answer, and transport
 * events go only there. An event that arrives before that is held, not dropped:
 * every 5 seconds the device looks again, and sends what it holds as soon as the
 * address is set. The queue holds at most 100 events (the oldest go first) and an
 * event for at most 10 minutes, so a server that never names an address costs a
 * bounded amount of memory, and the retry stops once the queue is empty. Events go
 * out one at a time, in the order they came, so a slow one is never overtaken.
 *
 * https.request is replaced, as in test-transport-telemetry.js, so nothing leaves
 * this machine. The clock and the retry timer are Node's fake timers, except in
 * the last case, which runs a real process to see that a held event doesn't keep
 * it from exiting.
 *
 * Runs as part of `npm test`, or alone:
 *   node test/run-all-tests.js test-transport-telemetry-queue.js
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { configManager } from '../dist/config-manager.js';
import { observeTransport } from '../dist/remote-device/transport-telemetry.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const ADDRESS = 'https://telemetry.example.test/collect';
const RETRY_MS = 5000;
const QUEUE_LIMIT = 100;
const HOLD_MS = 10 * 60 * 1000;

/** Call ids of the events sent, in order */
const sent = [];

/** https.request: each event's call id is kept, and the request is answered with 204 */
function recordingRequest(url, options, onResponse) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = (body) => { sent.push(JSON.parse(body).events[0].params.call_id); };
  request.end = () => {
    const response = new EventEmitter();
    response.statusCode = 204;
    response.resume = () => {};
    onResponse(response);
    queueMicrotask(() => response.emit('end'));
  };
  return request;
}

/** Observes one transport event, as the device does when a call arrives */
function observe(callId) {
  observeTransport({
    stage: 'received',
    payload: { call_id: callId, device_id: 'device-1', user_id: 'user-1' },
    deviceId: 'device-1',
    userId: 'user-1',
    transport: 'broadcast',
  });
}

/** Lets the asynchronous sends finish; the fake timers don't touch setImmediate */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Moves the fake clock forward, firing the retry timer on the way */
async function advance(ms) {
  mock.timers.tick(ms);
  await settle();
}

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const cases = [
  {
    name: 'an event before the address is set is sent within 5 seconds of the address being set',
    run: async () => {
      observe('call-early');
      await advance(RETRY_MS - 1);
      assert.deepEqual(sent, [], 'nothing is sent without an address');
      process.env.DC_TELEMETRY_URL = ADDRESS;
      await advance(1);
      assert.deepEqual(sent, ['call-early']);
      await advance(RETRY_MS * 3);
      assert.deepEqual(sent, ['call-early'], 'sent once');
    },
  },
  {
    name: 'the device looks again every 5 seconds until the address is set',
    run: async () => {
      observe('call-late');
      await advance(RETRY_MS * 4);
      assert.deepEqual(sent, []);
      process.env.DC_TELEMETRY_URL = ADDRESS;
      await advance(RETRY_MS);
      assert.deepEqual(sent, ['call-late']);
    },
  },
  {
    name: 'events held together are sent in the order they came',
    run: async () => {
      observe('call-1');
      await advance(1000);
      observe('call-2');
      process.env.DC_TELEMETRY_URL = ADDRESS;
      await advance(RETRY_MS);
      assert.deepEqual(sent, ['call-1', 'call-2']);
    },
  },
  {
    name: `at most ${QUEUE_LIMIT} events are held: the oldest go first`,
    run: async () => {
      for (let i = 0; i < QUEUE_LIMIT + 50; i++) observe(`call-${i}`);
      process.env.DC_TELEMETRY_URL = ADDRESS;
      await advance(RETRY_MS);
      assert.equal(sent.length, QUEUE_LIMIT);
      assert.equal(sent[0], 'call-50');
      assert.equal(sent[QUEUE_LIMIT - 1], `call-${QUEUE_LIMIT + 49}`);
    },
  },
  {
    name: 'an event is held for at most 10 minutes',
    run: async () => {
      observe('call-old');
      await advance(HOLD_MS + RETRY_MS);
      observe('call-new');
      process.env.DC_TELEMETRY_URL = ADDRESS;
      await advance(RETRY_MS);
      assert.deepEqual(sent, ['call-new']);
    },
  },
  {
    name: 'with the address set, an event is sent at once',
    run: async () => {
      process.env.DC_TELEMETRY_URL = ADDRESS;
      observe('call-now');
      await settle();
      assert.deepEqual(sent, ['call-now']);
    },
  },
  {
    name: 'nothing is sent twice',
    run: async () => {
      observe('call-a');
      observe('call-b');
      observe('call-c');
      await advance(RETRY_MS * 2);
      process.env.DC_TELEMETRY_URL = ADDRESS;
      await advance(RETRY_MS);
      observe('call-d');
      await advance(RETRY_MS * 3);
      assert.deepEqual(sent, ['call-a', 'call-b', 'call-c', 'call-d']);
    },
  },
  {
    name: 'a slow first event is sent before the later ones, which wait for it',
    run: async () => {
      process.env.DC_TELEMETRY_URL = ADDRESS;
      // The first event's lookup of the known paths doesn't answer until the test lets it
      let letFirstGo;
      const firstHeld = new Promise((resolve) => { letFirstGo = resolve; });
      let firstLookup = true;
      configManager.getValue = async (key) => {
        if (key === 'allowedDirectories' && firstLookup) {
          firstLookup = false;
          await firstHeld;
        }
        return key === 'telemetryEnabled' ? true : undefined;
      };
      observe('call-slow');
      observe('call-fast-1');
      observe('call-fast-2');
      await settle();
      assert.deepEqual(sent, [], 'no later event goes ahead of the first');
      letFirstGo();
      await settle();
      assert.deepEqual(sent, ['call-slow', 'call-fast-1', 'call-fast-2']);
    },
  },
  {
    name: 'a held event does not keep the process from exiting',
    real: true,
    run: async () => {
      const home = createTempDir('dc-transport-queue-test-');
      const transport = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'remote-device', 'transport-telemetry.js')).href;
      const script = `process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0'; delete process.env.DC_TELEMETRY_URL;
        const { observeTransport } = await import(${JSON.stringify(transport)});
        observeTransport({ stage: 'operation_start', callId: 'call-exit', deviceId: 'device-1', toolName: 'read_file', operation: 'result_write' });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', env: { ...process.env, HOME: home, USERPROFILE: home } });
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code === 0 && signal === null)));
      const gaveUp = new Promise((resolve) => setTimeout(() => resolve(false), 3000));
      const ended = await Promise.race([exited, gaveUp]);
      if (!ended) child.kill();
      assert.equal(ended, true, 'the process failed, or is still running 3 seconds after the event with the retry timer pending');
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
    setEnv('DESKTOP_COMMANDER_DISABLE_TELEMETRY', '0');
    configManager.getValue = async (key) => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = recordingRequest;
    syncBuiltinESMExports();

    for (const { name, run, real } of cases) {
      sent.length = 0;
      delete process.env.DC_TELEMETRY_URL;
      if (!real) mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      try {
        await run();
        console.log(`✅ PASS  ${name}`);
      } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${name}\n     ${error.message.split('\n')[0]}`);
      } finally {
        configManager.getValue = async (key) => key === 'telemetryEnabled' ? true : undefined;
        // Whatever the case left held is sent or aged out before the next case
        process.env.DC_TELEMETRY_URL = ADDRESS;
        if (!real) await advance(HOLD_MS * 2);
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
  console.log(`\n${failures ? '🔴' : '✅'} transport events before the address: ${failures} failing test(s).`);
  return failures === 0;
}

runIfMain(import.meta.url, runTests);
