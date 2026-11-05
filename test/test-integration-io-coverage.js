/** Focused observable controls for timeout recovery, termination and config rendering. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { App } from '@modelcontextprotocol/ext-apps';
import { configManager } from '../dist/config-manager.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { validatePath, LOOKUPS_PER_FOLDER } from '../dist/tools/filesystem.js';
import { killProcess } from '../dist/tools/process.js';
import { captureTransport } from '../dist/utils/capture.js';
import { bootstrapConfigEditorApp } from '../dist/ui/config-editor/src/app.js';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';
import { waitUntil } from './helpers/wait.js';

const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
};

async function lookupRecovery() {
  const originalRealpath = fs.realpath;
  const originalConfig = configManager.getConfig;
  const directory = createTempDir('dc-lookup-recovery-');
  const file = path.join(directory, 'same.txt');
  await fs.writeFile(file, 'available after recovery');
  configManager.getConfig = async () => ({ allowedDirectories: [] });
  let held = [];
  let target = file;
  fs.realpath = async (given, ...args) => {
    if (String(given) !== target) return originalRealpath.call(fs, given, ...args);
    await new Promise(resolve => held.push(resolve));
    return originalRealpath.call(fs, given, ...args);
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const repeated = [validatePath(file), validatePath(file)].map(promise => promise.catch(error => error));
    await settle();
    assert.equal(held.length, 2, 'both lookups reached the same path before its timeout');
    mock.timers.tick(10_001);
    const failed = await Promise.all(repeated);
    assert.ok(failed.every(error => error instanceof Error && error.message.includes("isn't responding")));
    held.splice(0).forEach(resolve => resolve());
    fs.realpath = originalRealpath;
    mock.timers.reset();
    await waitUntil(() => validatePath(file).then(() => true, () => false), 2000, 'both held file operations finish');
    assert.equal(await validatePath(file), await originalRealpath(file), 'the repeated hung mark clears after both return');

    // Roots are never hung-path marks. Their full lookup line must still reject new work and recover.
    target = path.parse(directory).root;
    mock.timers.enable({ apis: ['setTimeout'] });
    fs.realpath = async (given, ...args) => {
      if (String(given) !== target) return originalRealpath.call(fs, given, ...args);
      await new Promise(resolve => held.push(resolve));
      return originalRealpath.call(fs, given, ...args);
    };
    const roots = Array.from({ length: LOOKUPS_PER_FOLDER }, () => validatePath(target).catch(error => error));
    await settle();
    assert.equal(held.length, LOOKUPS_PER_FOLDER);
    mock.timers.tick(10_001);
    assert.ok((await Promise.all(roots)).every(error => error instanceof Error));
    await assert.rejects(validatePath(target), /isn't responding/);
    assert.equal(held.length, LOOKUPS_PER_FOLDER, 'a full hung root line starts no additional disk lookup');
    held.splice(0).forEach(resolve => resolve());
    fs.realpath = originalRealpath;
    mock.timers.reset();
    await waitUntil(() => validatePath(target).then(() => true, () => false), 2000, 'the held root operations finish');
    assert.equal(await validatePath(target), await originalRealpath(target), 'root lookups work after the held operations finish');
  } finally {
    held.splice(0).forEach(resolve => resolve());
    await settle();
    mock.timers.reset();
    fs.realpath = originalRealpath;
    configManager.getConfig = originalConfig;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function terminationOutcome() {
  const original = terminalManager.forceTerminate;
  const requested = [];
  try {
    terminalManager.forceTerminate = async pid => { requested.push(pid); return 'failed'; };
    const failed = await killProcess({ pid: 123456 });
    assert.equal(failed.isError, true, 'failed tree termination must not claim success');
    assert.match(failed.content[0].text, /123456/);
    terminalManager.forceTerminate = async pid => { requested.push(pid); return 'terminated'; };
    const ended = await killProcess({ pid: 123457 });
    assert.equal(ended.isError, undefined);
    assert.equal(ended.content[0].text, 'Successfully terminated process 123457');
    assert.deepEqual(requested, [123456, 123457], 'kill_process delegates the exact PID to session termination');
  } finally {
    terminalManager.forceTerminate = original;
  }
}

async function transportRecovery() {
  const original = {
    request: https.request, getValue: configManager.getValue, client: configManager.getOrCreateClientId,
    disabled: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY, address: process.env.DC_TELEMETRY_URL,
  };
  const sent = [];
  let idleFirst = true;
  let destroyed = 0;
  https.request = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = () => { destroyed++; return request; };
    request.setTimeout = (ms, callback) => {
      if (idleFirst) { idleFirst = false; queueMicrotask(callback); }
      return request;
    };
    request.write = body => { sent.push(JSON.parse(body).events[0].params.call_id); };
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
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    process.env.DC_TELEMETRY_URL = 'https://telemetry.example.test/collect';
    configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'test-installation';
    captureTransport('received', { call_id: 'idle-timeout' }, 'user-test');
    captureTransport('received', { call_id: 'after-idle' }, 'user-test');
    await settle();
    assert.equal(destroyed, 1, 'socket inactivity destroys the request and releases the queue');
    assert.deepEqual(sent, ['idle-timeout', 'after-idle']);

    let consentReads = 0;
    configManager.getValue = async key => {
      if (key !== 'telemetryEnabled') return undefined;
      if (++consentReads === 2) throw new Error('send-time consent lookup failed');
      return true;
    };
    captureTransport('received', { call_id: 'send-error' }, 'user-test');
    await settle();
    captureTransport('received', { call_id: 'after-error' }, 'user-test');
    await settle();
    assert.deepEqual(sent, ['idle-timeout', 'after-idle', 'after-error'], 'a failed send does not block the next event');

    configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
    delete process.env.DC_TELEMETRY_URL;
    captureTransport('received', { call_id: 'held-before-address' }, 'user-test');
    await settle();
    process.env.DC_TELEMETRY_URL = 'https://telemetry.example.test/collect';
    captureTransport('received', { call_id: 'wakes-queue' }, 'user-test');
    await settle();
    assert.deepEqual(sent.slice(-2), ['held-before-address', 'wakes-queue']);
    const before = sent.length;
    mock.timers.tick(10_000);
    await settle();
    assert.equal(sent.length, before, 'the emptied queue leaves no duplicate retry delivery');

    // The clock can cross the holding deadline between inspecting the head and exiting a drain with no address.
    delete process.env.DC_TELEMETRY_URL;
    const clock = Date.now;
    let clockReads = 0;
    try {
      Date.now = () => ++clockReads === 1 ? 0 : clockReads === 2 ? 600_000 : 600_001;
      captureTransport('received', { call_id: 'expires-during-drain' }, 'user-test');
      await settle();
    } finally {
      Date.now = clock;
    }
    process.env.DC_TELEMETRY_URL = 'https://telemetry.example.test/collect';
    captureTransport('received', { call_id: 'fresh-after-expiry' }, 'user-test');
    await settle();
    assert.equal(sent.includes('expires-during-drain'), false, 'an event that expires as the drain exits is discarded');
    assert.equal(sent.at(-1), 'fresh-after-expiry', 'expiry leaves the queue able to send a fresh event');
  } finally {
    mock.timers.reset();
    https.request = original.request;
    syncBuiltinESMExports();
    configManager.getValue = original.getValue;
    configManager.getOrCreateClientId = original.client;
    for (const [key, value] of [['DESKTOP_COMMANDER_DISABLE_TELEMETRY', original.disabled], ['DC_TELEMETRY_URL', original.address]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function booleanRendering() {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map(['window', 'document', 'ResizeObserver', 'mcp'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const connect = App.prototype.connect;
  const context = App.prototype.getHostContext;
  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    dom.window.mcp = { callTool: async () => ({ structuredContent: { entries: [
      { key: 'telemetryEnabled', value: true, valueType: 'boolean', editable: true },
      { key: 'toolCallAuditLogEnabled', value: false, valueType: 'boolean', editable: true },
    ] } }) };
    globalThis.mcp = dom.window.mcp;
    App.prototype.connect = async () => {};
    App.prototype.getHostContext = () => ({});
    bootstrapConfigEditorApp();
    await waitUntil(() => dom.window.document.querySelectorAll('input[type="checkbox"]').length === 2,
      2000, 'both boolean controls render');
    assert.deepEqual([...dom.window.document.querySelectorAll('input[type="checkbox"]')].map(input => input.checked), [true, false]);
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  } finally {
    App.prototype.connect = connect;
    App.prototype.getHostContext = context;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

export default async function run() {
  for (const [name, check] of Object.entries({ lookupRecovery, terminationOutcome, transportRecovery, booleanRendering })) {
    await check();
    console.log(`PASS integration IO: ${name}`);
  }
}

runIfMain(import.meta.url, run);
