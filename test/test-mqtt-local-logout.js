#!/usr/bin/env node
// Real credential writes and cross-process CLI logout; only enrollment HTTP is mocked.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import forge from 'node-forge';
import lockfile from 'proper-lockfile';
import { MCPDevice } from '../dist/remote-device/device.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { enrollMqttDevice } from '../dist/remote-device/mqtt/mqtt-enrollment.js';
import { createTestEnv, isTestHome } from './helpers/test-env.js';
import { deviceConfigPath, runLogout, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const brokerUrl = 'mqtts://broker.example.test:8883';
const profile = { serverUrl: 'https://mcp.example.test', userId: 'user-1', deviceId: 'device-1', accessToken: 'synthetic-token' };
const session = { access_token: 'synthetic-token', refresh_token: 'synthetic-refresh' };
const ca = generateKeyPairSync('rsa', { modulusLength: 2048 });
const caKey = forge.pki.privateKeyFromPem(ca.privateKey.export({ format: 'pem', type: 'pkcs1' }));

function issue(request) {
  const csr = forge.pki.certificationRequestFromPem(JSON.parse(request.body).csr);
  assert.ok(csr.verify());
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = csr.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject(csr.subject.attributes);
  certificate.setIssuer([{ name: 'commonName', value: 'Logout test CA' }]);
  certificate.setExtensions([{ name: 'basicConstraints', cA: false }]);
  certificate.sign(caKey, forge.md.sha256.create());
  return Response.json({ certificate_pem: forge.pki.certificateToPem(certificate), certificate_id: 'a'.repeat(64), broker_url: brokerUrl });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function assertRemoved(home) {
  const config = deviceConfigPath(home);
  for (const file of [config, path.join(path.dirname(config), '.mqtt', 'identity.json'), path.join(path.dirname(config), '.mqtt', 'certificate.json')]) {
    assert.ok(!fs.existsSync(file), `logout left ${file}`);
  }
}

async function runTests() {
  if (!isTestHome()) return skip('Run through node test/run-all-tests.js test/test-mqtt-local-logout.js');
  const originalBroker = process.env.MQTT_BROKER_URL;
  process.env.MQTT_BROKER_URL = brokerUrl;
  async function test(name, run) {
    const fixture = createTestEnv();
    const standIn = await startRemoteStandIn();
    fixture.env.MCP_SERVER_URL = standIn.url;
    mock.method(os, 'homedir', () => fixture.home);
    try {
      await run({ ...fixture, standIn });
      console.log(`✅ ${name}`);
    } finally {
      mock.restoreAll();
      await standIn.close();
      fixture.cleanup();
    }
  }

  try {
    await test('logout waits for enrollment and removes its private key and certificate', async ({ env, home, standIn }) => {
      writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
      const reached = deferred();
      const resume = deferred();
      mock.method(globalThis, 'fetch', async (url, request) => {
        assert.equal(url.pathname, '/device/mqtt/enroll');
        reached.resolve();
        await resume.promise;
        return issue(request);
      });
      const enrollment = enrollMqttDevice(profile);
      await reached.promise;
      let ended = false;
      const logout = runLogout(env).then((result) => { ended = true; return result; });
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(ended, false, 'logout must wait until enrollment releases the MQTT lock');
      } finally {
        resume.resolve();
        await enrollment;
        const result = await logout;
        assert.equal(result.code, 0, result.output);
      }
      assertRemoved(home);
      const previous = await enrollment;
      const next = new RemoteChannel({ serverUrl: profile.serverUrl });
      next._user = { id: profile.userId };
      next.deviceId = profile.deviceId;
      next.getSession = async () => ({ data: { session } });
      const fresh = await next.prepareMqttConfig(() => {});
      assert.ok(fresh.options.key !== previous.options.key, 'a login after logout generates a new private key');
      assert.ok(fresh.options.cert !== previous.options.cert, 'a login after logout gets a new certificate');
    });

    await test('enrollment delayed before its lock cannot recreate credentials after logout', async ({ env, home }) => {
      const reached = deferred();
      const resume = deferred();
      const originalLock = lockfile.lock;
      mock.method(lockfile, 'lock', async (...args) => {
        reached.resolve();
        await resume.promise;
        return originalLock(...args);
      });
      mock.method(globalThis, 'fetch', async () => { assert.fail('cancelled enrollment must not contact the backend'); });
      const channel = new RemoteChannel({ serverUrl: profile.serverUrl });
      channel._user = { id: profile.userId };
      channel.deviceId = profile.deviceId;
      channel.getSession = async () => ({ data: { session } });
      const enrollment = assert.rejects(channel.prepareMqttConfig(() => {}), /Local credentials were removed/);
      await reached.promise;
      try {
        const result = await runLogout(env);
        assert.equal(result.code, 0, result.output);
      } finally {
        resume.resolve();
        await enrollment;
      }
      assertRemoved(home);
    });

    await test('an old connector cannot enroll or save after logout; a new login can', async ({ env, home }) => {
      const oldDevice = new MCPDevice();
      oldDevice.deviceId = profile.deviceId;
      const channel = oldDevice.remoteChannel;
      channel._user = { id: profile.userId };
      channel.deviceId = profile.deviceId;
      channel.getSession = async () => {
        const result = await runLogout(env);
        assert.equal(result.code, 0, result.output);
        return { data: { session } };
      };
      const fetch = mock.method(globalThis, 'fetch', async (_url, request) => issue(request));
      await assert.rejects(channel.prepareMqttConfig(() => {}), /Local credentials were removed/);
      channel.getSession = async () => ({ data: { session } });
      await assert.rejects(channel.prepareMqttConfig(() => {}), /Local credentials were removed/);
      await oldDevice.savePersistedConfig(session);
      assertRemoved(home);
      assert.equal(fetch.mock.callCount(), 0);

      const newDevice = new MCPDevice();
      newDevice.deviceId = profile.deviceId;
      await newDevice.savePersistedConfig(session);
      const newChannel = new RemoteChannel({ serverUrl: profile.serverUrl });
      newChannel._user = { id: profile.userId };
      newChannel.deviceId = profile.deviceId;
      newChannel.getSession = async () => ({ data: { session } });
      await newChannel.prepareMqttConfig(() => {});
      assert.equal(fetch.mock.callCount(), 1, 'new login can enroll normally');
      const config = deviceConfigPath(home);
      assert.ok(fs.existsSync(config));
      assert.ok(fs.existsSync(path.join(path.dirname(config), '.mqtt', 'certificate.json')));
      await oldDevice.savePersistedConfig({ access_token: 'old', refresh_token: 'old' });
      assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).session, session);
    });
  } finally {
    if (originalBroker === undefined) delete process.env.MQTT_BROKER_URL;
    else process.env.MQTT_BROKER_URL = originalBroker;
  }
  return true;
}

runIfMain(import.meta.url, runTests);
