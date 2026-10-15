#!/usr/bin/env node

/**
 * Where telemetry goes (src/utils/capture.ts). A remote device sets
 * DC_TELEMETRY_URL to the address the Remote MCP server names, and events go
 * there instead of the built-in proxy. A send that fails is retried on the
 * built-in proxy's second address only when DC_TELEMETRY_URL is not set, so
 * events meant for another address never end up in production.
 *
 * The address is used as given: http or https by its protocol, with its port
 * and query.
 *
 * https.request is replaced, as in test-transport-telemetry.js, so nothing
 * leaves this machine; an http address is sent to a local http server. Every
 * send fails, so a retry shows when there is one.
 *
 * Runs as part of `npm test`, or alone:
 *   node test/run-all-tests.js test-telemetry-url.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { configManager } from '../dist/config-manager.js';
import { capture } from '../dist/utils/capture.js';
import { runIfMain } from './helpers/run-if-main.js';

const BUILT_IN = 'https://telemetry.desktopcommander.app/mp/collect';
const FALLBACK = 'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/mp/collect';
const OTHER = 'https://telemetry.example.test/collect';
const PORT_AND_QUERY = 'https://telemetry.example.test:8443/collect?key=x';

/** An event reaches its last request within this; far above a send that never leaves the process */
const SEND_DEADLINE_MS = 5000;

/** DC_TELEMETRY_URL, and where one event is sent, in order, when every send fails; `local` is the local http server */
const cases = (local) => [
  { name: 'no DC_TELEMETRY_URL: the built-in address, then its fallback', url: undefined, sentTo: [BUILT_IN, FALLBACK] },
  { name: 'a DC_TELEMETRY_URL: that address, and no retry on production', url: OTHER, sentTo: [OTHER] },
  { name: 'a DC_TELEMETRY_URL that names the built-in address: that address, and no retry on its fallback', url: BUILT_IN, sentTo: [BUILT_IN] },
  { name: 'an https DC_TELEMETRY_URL keeps its port and query', url: PORT_AND_QUERY, sentTo: [PORT_AND_QUERY] },
  { name: 'an http DC_TELEMETRY_URL is sent over http, with its path and query', url: `${local}/collect?x=1`, sentTo: [`${local}/collect?x=1`] },
];

/** Every request, as its full address */
const requests = [];
/** Called after each answer */
let answered = () => {};

/** https.request: each request is kept and answered with a server error */
function failingRequest(url, options, onResponse) {
  requests.push(String(url));
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => {};
  request.end = () => {
    const response = new EventEmitter();
    response.statusCode = 500;
    response.resume = () => {};
    onResponse(response);
    queueMicrotask(() => {
      response.emit('end');
      answered();
    });
  };
  return request;
}

/** A local http server: each request is kept and answered with a server error */
async function startLocalServer() {
  const server = http.createServer((request, response) => {
    requests.push(`http://${request.headers.host}${request.url}`);
    request.resume();
    request.on('end', () => {
      response.writeHead(500).end();
      answered();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** Sends one event and returns where it went: the requests up to `count` answers, and any that follow them at once */
async function sendEvent(count) {
  requests.length = 0;
  let timer;
  await new Promise((resolve) => {
    answered = () => { if (requests.length >= count) resolve(); };
    timer = setTimeout(resolve, SEND_DEADLINE_MS);
    void capture('telemetry_url_test');
  });
  clearTimeout(timer);
  // A retry starts as soon as the answer before it ends
  await new Promise((resolve) => setImmediate(resolve));
  return [...requests];
}

function setEnv(name, value) {
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
  const server = await startLocalServer();
  let failures = 0;
  try {
    setEnv('DESKTOP_COMMANDER_DISABLE_TELEMETRY', '0');
    configManager.getValue = async (key) => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = failingRequest;
    syncBuiltinESMExports();

    for (const { name, url, sentTo } of cases(`http://127.0.0.1:${server.address().port}`)) {
      setEnv('DC_TELEMETRY_URL', url);
      try {
        const sent = await sendEvent(sentTo.length);
        assert.deepEqual(sent, sentTo, `sent to ${JSON.stringify(sent)}`);
        console.log(`✅ PASS  ${name}`);
      } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${name}\n     ${error.message.split('\n')[0]}`);
      }
    }
  } finally {
    server.closeAllConnections();
    server.close();
    https.request = original.request;
    syncBuiltinESMExports();
    configManager.getValue = original.getValue;
    configManager.getOrCreateClientId = original.getOrCreateClientId;
    setEnv('DESKTOP_COMMANDER_DISABLE_TELEMETRY', original.disableTelemetry);
    setEnv('DC_TELEMETRY_URL', original.telemetryUrl);
  }
  console.log(`\n${failures ? '🔴' : '✅'} telemetry address: ${failures} failing test(s).`);
  return failures === 0;
}

runIfMain(import.meta.url, runTests);
