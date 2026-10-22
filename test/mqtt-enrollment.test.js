#!/usr/bin/env node
// Real key generation, CSR signatures, X509 validation and private filesystem storage.
// The HTTP response is a controlled seam here; the server suite covers the actual route.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import forge from 'node-forge';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { rolloutManager } = await import('../dist/remote-device/rollouts.js');
const originalRollouts = rolloutManager.getAll();
rolloutManager.update({ IS_MQTT_EXECUTION_ENABLED: true });
const { enrollMqttDevice } = await import('../dist/remote-device/mqtt/mqtt-enrollment.js');
const { getRemoteDeviceConfigDirectory } = await import('../dist/remote-device/remote-utils.js');
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const SKIPPED_REVOCATION_WARNING = '[MQTT] Previous credentials cannot be identified on this backend; continuing with fresh enrollment. The old certificate may remain active.';
const FAILED_REVOCATION_WARNING = '[MQTT] Previous certificate revocation failed; continuing with fresh enrollment. The old certificate may remain active.';
const originalBroker = process.env.MQTT_BROKER_URL;
const originalDcEnv = process.env.DC_ENV;
delete process.env.MQTT_BROKER_URL;
delete process.env.DC_ENV;
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mqtt-enrollment-device-'));
let testHome = workspace;
mock.method(os, 'homedir', () => testHome);
const caPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const caKey = forge.pki.privateKeyFromPem(caPair.privateKey.export({ format: 'pem', type: 'pkcs1' }));
let profileNumber = 0;
let certificateNumber = 0;
let passed = 0;

/** Each fixture selects a temporary home without adding storage options to production code. */
function options(overrides = {}) {
  testHome = path.join(workspace, `profile-${++profileNumber}`);
  return { serverUrl: 'https://staging-mcp.desktopcommander.app', userId: USER_ID, deviceId: DEVICE_ID, accessToken: 'synthetic-test-token', ...overrides };
}

/** Sign the real CSR public key with an ephemeral CA, independently of the device private key. */
function issue(csrPem, patch = {}) {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  assert.ok(csr.verify(), 'CSR proves private-key possession');
  assert.equal(csr.publicKey.n.bitLength(), 2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = csr.publicKey;
  certificate.serialNumber = (++certificateNumber).toString(16).padStart(2, '0');
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject(csr.subject.attributes);
  certificate.setIssuer([{ name: 'commonName', value: 'Local enrollment QA CA' }]);
  certificate.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }, { name: 'extKeyUsage', clientAuth: true }]);
  if (patch.expired) certificate.validity.notAfter = new Date(Date.now() - 1_000);
  if (patch.future) certificate.validity.notBefore = new Date(Date.now() + 60_000);
  certificate.sign(caKey, forge.md.sha256.create());
  return { certificate_pem: forge.pki.certificateToPem(certificate), certificate_id: certificateNumber.toString(16).padStart(64, '0'), broker_url: 'mqtts://a1vw7p0stdnykd-ats.iot.eu-west-1.amazonaws.com:8883' };
}

/** Scope the global fetch seam even when a deliberately invalid request fails. */
async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withWarnings(run) {
  const messages = [];
  const warning = mock.method(console, 'warn', (...args) => messages.push(args));
  try { return await run(messages); } finally { warning.mock.restore(); }
}

/** Read only our throwaway credentials; private material is compared without printing it. */
const mqttFolder = () => path.join(getRemoteDeviceConfigDirectory(), '.mqtt');
async function cache() {
  const folder = mqttFolder();
  return { folder, identity: JSON.parse(await readFile(path.join(folder, 'identity.json'), 'utf8')), certificate: JSON.parse(await readFile(path.join(folder, 'certificate.json'), 'utf8')) };
}
function revoked(url, request, profile, previousDeviceId = DEVICE_ID) {
  assert.equal(url.href, `${profile.serverUrl}/device/mqtt/revoke`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, `Bearer ${profile.accessToken}`);
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.body), { device_id: profile.deviceId, previous_device_id: previousDeviceId });
  return Response.json({ revoked: true });
}
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

try {
  await check('local RSA key signs CSR, request contains no key, and restart reuses private credentials without POST', async () => {
    const profile = options();
    let calls = 0;
    let sent;
    await withFetch(async (url, request) => {
      calls++;
      assert.equal(url.href, 'https://staging-mcp.desktopcommander.app/device/mqtt/enroll');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.Authorization, 'Bearer synthetic-test-token');
      assert.equal(request.redirect, 'error');
      assert.ok(request.signal instanceof AbortSignal);
      sent = JSON.parse(request.body);
      assert.deepEqual(Object.keys(sent).sort(), ['csr', 'device_id']);
      assert.equal(sent.device_id, DEVICE_ID);
      assert.ok(!request.body.includes('PRIVATE KEY'));
      return Response.json(issue(sent.csr));
    }, async () => {
      const first = await enrollMqttDevice(profile);
      const second = await enrollMqttDevice(profile);
      assert.equal(calls, 1, 'a process restart uses the persisted successful enrollment');
      const saved = await cache();
      assert.equal(saved.folder, path.join(testHome, '.desktop-commander-device', '.mqtt'));
      const csr = forge.pki.certificationRequestFromPem(sent.csr);
      assert.ok(csr.verify());
      const csrPublicKey = createPublicKey(forge.pki.publicKeyToPem(csr.publicKey));
      assert.ok(csrPublicKey.equals(createPublicKey(saved.identity.private_key)));
      assert.ok(new X509Certificate(saved.certificate.certificate_pem).checkPrivateKey(createPrivateKey(saved.identity.private_key)));
      assert.deepEqual([saved.identity.backend_origin, saved.identity.user_id, saved.identity.device_id], ['https://staging-mcp.desktopcommander.app', USER_ID, DEVICE_ID]);
      assert.equal((await stat(saved.folder)).mode & 0o777, 0o700);
      for (const file of ['identity.json', 'certificate.json']) assert.equal((await stat(path.join(saved.folder, file))).mode & 0o777, 0o600);
      assert.equal(first.options.key.toString(), saved.identity.private_key);
      assert.equal(first.options.cert.toString(), second.options.cert.toString());
      assert.equal(first.options.rejectUnauthorized, true);
      assert.equal(first.url, saved.certificate.broker_url);
    });
  });

  await check('production, staging and development keep separate credentials and reuse their own cache', async () => {
    const profile = options();
    const snapshots = new Map();
    const keys = new Set();
    let calls = 0;
    try {
      await withFetch(async (_url, request) => {
        calls++;
        return Response.json(issue(JSON.parse(request.body).csr));
      }, async () => {
        for (const [dcEnv, suffix, serverUrl] of [
          [undefined, '', 'https://mcp.desktopcommander.app'],
          ['staging', '-staging', 'https://staging-mcp.desktopcommander.app'],
          ['development', '-dev', 'http://mcp.localhost:3007'],
          ['development', '-dev', 'http://mcp.localhost:3007'],
          ['staging', '-staging', 'https://staging-mcp.desktopcommander.app'],
          ['production', '', 'https://mcp.desktopcommander.app'],
          [undefined, '', 'https://mcp.desktopcommander.app'],
        ]) {
          if (dcEnv === undefined) delete process.env.DC_ENV;
          else process.env.DC_ENV = dcEnv;

          const config = await enrollMqttDevice({ ...profile, serverUrl });
          const folder = path.join(testHome, `.desktop-commander-device${suffix}`, '.mqtt');
          const identityText = await readFile(path.join(folder, 'identity.json'), 'utf8');
          const certificateText = await readFile(path.join(folder, 'certificate.json'), 'utf8');
          assert.equal(JSON.parse(identityText).backend_origin, serverUrl);
          assert.equal(JSON.parse(identityText).private_key, config.options.key.toString());
          if (snapshots.has(suffix)) {
            assert.deepEqual([identityText, certificateText], snapshots.get(suffix));
          } else {
            snapshots.set(suffix, [identityText, certificateText]);
            keys.add(config.options.key.toString());
          }
          assert.equal(calls, snapshots.size, 'switching back reuses credentials without enrolling again');
        }
      });
      assert.equal(calls, 3);
      assert.equal(keys.size, 3, 'each environment keeps its own private key');
    } finally {
      delete process.env.DC_ENV;
    }
  });

  await check('broker override works with a custom HTTPS backend', async () => {
    process.env.MQTT_BROKER_URL = 'mqtts://custom.example.test:8883';
    try {
      await withFetch(async (_url, request) => Response.json({
        ...issue(JSON.parse(request.body).csr), broker_url: process.env.MQTT_BROKER_URL,
      }), async () => {
        const config = await enrollMqttDevice(options({ serverUrl: 'https://custom-mcp.example.test' }));
        assert.equal(config.url, process.env.MQTT_BROKER_URL);
      });
    } finally {
      delete process.env.MQTT_BROKER_URL;
    }
  });

  await check('network refusal and HTTP errors make exactly one attempt and never cache a certificate', async () => {
    for (const failure of [() => { throw new Error('PRIVATE_NETWORK_DETAIL'); }, () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 403 }), () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 502 })]) {
      const profile = options();
      let calls = 0;
      await withFetch(async () => { calls++; return failure(); }, async () => {
        await assert.rejects(enrollMqttDevice(profile), (error) => /restart/.test(error.message) && !/PRIVATE_/.test(error.message));
        assert.equal(calls, 1);
        await assert.rejects(stat(path.join(mqttFolder(), 'certificate.json')), { code: 'ENOENT' });
      });
    }
  });

  await check('an explicit manual restart after failed enrollment retains the original private key', async () => {
    const profile = options();
    await withFetch(async () => { throw new Error('injected'); }, async () => { await assert.rejects(enrollMqttDevice(profile)); });
    const original = await readFile(path.join(mqttFolder(), 'identity.json'), 'utf8');
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
    assert.equal(await readFile(path.join(mqttFolder(), 'identity.json'), 'utf8'), original);
  });

  await check('a changed device gets a new key and certificate, then reuses them on restart', async () => {
    for (const enrolled of [true, false]) {
      const profile = options();
      await withFetch(async (_url, request) => enrolled
        ? Response.json(issue(JSON.parse(request.body).csr))
        : new Response(null, { status: 503 }), async () => {
        if (enrolled) await enrollMqttDevice(profile);
        else await assert.rejects(enrollMqttDevice(profile), /HTTP 503/);
      });
      const folder = mqttFolder();
      const previous = JSON.parse(await readFile(path.join(folder, 'identity.json'), 'utf8'));
      const previousCertificate = enrolled ? await readFile(path.join(folder, 'certificate.json'), 'utf8') : null;
      const replacement = { ...profile, deviceId: 'replacement-device' };
      const requests = [];
      await withFetch(async (url, request) => {
        requests.push(url.pathname);
        if (url.pathname === '/device/mqtt/revoke') {
          assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'identity.json'), 'utf8')), previous);
          if (enrolled) assert.equal(await readFile(path.join(folder, 'certificate.json'), 'utf8'), previousCertificate);
          return revoked(url, request, replacement);
        }
        assert.equal(url.pathname, '/device/mqtt/enroll');
        const body = JSON.parse(request.body);
        assert.equal(body.device_id, replacement.deviceId);
        const csr = forge.pki.certificationRequestFromPem(body.csr);
        assert.equal(csr.subject.getField('CN').value, `dc-device-${replacement.deviceId}`);
        await assert.rejects(stat(path.join(folder, 'certificate.json')), { code: 'ENOENT' });
        return Response.json(issue(body.csr));
      }, async () => {
        const config = await enrollMqttDevice(replacement);
        const saved = await cache();
        assert.equal(saved.identity.device_id, replacement.deviceId);
        assert.notEqual(saved.identity.private_key, previous.private_key);
        assert.notEqual(JSON.stringify(saved.certificate), previousCertificate);
        assert.ok(new X509Certificate(saved.certificate.certificate_pem).checkPrivateKey(createPrivateKey(saved.identity.private_key)));
        assert.equal(config.options.key.toString(), saved.identity.private_key);
        for (const file of ['identity.json', 'certificate.json']) assert.equal((await stat(path.join(folder, file))).mode & 0o777, 0o600);
        const restarted = await enrollMqttDevice(replacement);
        assert.equal(restarted.options.key.toString(), config.options.key.toString());
        assert.equal(restarted.options.cert.toString(), config.options.cert.toString());
      });
      assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll']);
    }
  });

  await check('cached backend changes and unsafe old device IDs reset locally without sending credentials to an untrusted target', async () => {
    for (const identityPatch of [
      { backend_origin: 'https://untrusted.example.test' },
      { backend_origin: 'https://staging-mcp.desktopcommander.app:8443' },
      { backend_origin: 'https://user:PRIVATE_PASSWORD@untrusted.example.test/PRIVATE_PATH' },
      { backend_origin: undefined },
      { device_id: '../PRIVATE_UNSAFE_DEVICE' },
      { device_id: undefined },
      { device_id: null },
      { device_id: 'x'.repeat(119) },
    ]) {
      const profile = options();
      await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
      const saved = await cache();
      await writeFile(path.join(saved.folder, 'identity.json'), JSON.stringify({ ...saved.identity, ...identityPatch }));
      const requests = [];
      await withWarnings(async warnings => {
        await withFetch(async (url, request) => {
          requests.push(url.href);
          assert.equal(url.href, `${profile.serverUrl}/device/mqtt/enroll`);
          assert.equal(request.headers.Authorization, `Bearer ${profile.accessToken}`);
          assert.equal(JSON.parse(request.body).device_id, profile.deviceId);
          await assert.rejects(stat(path.join(saved.folder, 'certificate.json')), { code: 'ENOENT' });
          return Response.json(issue(JSON.parse(request.body).csr));
        }, async () => {
          await enrollMqttDevice(profile);
          const fresh = await cache();
          assert.equal(fresh.identity.backend_origin, profile.serverUrl);
          assert.equal(fresh.identity.device_id, profile.deviceId);
          assert.notEqual(fresh.identity.private_key, saved.identity.private_key);
          assert.ok(new X509Certificate(fresh.certificate.certificate_pem).checkPrivateKey(createPrivateKey(fresh.identity.private_key)));
          await enrollMqttDevice(profile);
        });
        assert.deepEqual(warnings, [[SKIPPED_REVOCATION_WARNING]]);
      });
      assert.deepEqual(requests, [`${profile.serverUrl}/device/mqtt/enroll`]);
    }
  });

  await check('unreadable identity and certificate caches fail without revocation or enrollment', async () => {
    const base = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(base); });
    const saved = await cache();
    let requests = 0;
    await withFetch(async () => { requests++; throw new Error('must not POST'); }, async () => {
      for (const [file, value] of [['identity.json', '{'],
        ['certificate.json', '{'],
        ['certificate.json', JSON.stringify({ ...saved.certificate, certificate_pem: 'invalid' })],
        ['certificate.json', JSON.stringify({ ...saved.certificate, certificate_id: 'invalid' })]]) {
        const profile = options();
        const folder = mqttFolder();
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(path.join(folder, 'identity.json'), JSON.stringify(saved.identity), { mode: 0o600 });
        await writeFile(path.join(folder, 'certificate.json'), JSON.stringify(saved.certificate), { mode: 0o600 });
        await writeFile(path.join(folder, file), value);
        const identityText = await readFile(path.join(folder, 'identity.json'), 'utf8');
        const certificateText = await readFile(path.join(folder, 'certificate.json'), 'utf8');
        await assert.rejects(enrollMqttDevice(profile), /cache|certificate/);
        assert.equal(await readFile(path.join(folder, 'identity.json'), 'utf8'), identityText);
        assert.equal(await readFile(path.join(folder, 'certificate.json'), 'utf8'), certificateText);
      }
    });
    assert.equal(requests, 0);
  });

  await check('changed identities and unusable or mismatched keys attempt revocation before replacement and restart reuses the fresh pair', async () => {
    const ecKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    const shortKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    const differentKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    for (const [name, identityPatch, optionPatch] of [
      ['different user', {}, { userId: 'another-user', accessToken: 'new-user-token' }],
      ['maximum-length old device ID', { device_id: 'x'.repeat(118) }, {}],
      ['missing key', { private_key: undefined }, {}],
      ['non-string key', { private_key: 42 }, {}],
      ['invalid key', { private_key: 'invalid' }, {}],
      ['non-RSA key', { private_key: ecKey }, {}],
      ['wrong-size RSA key', { private_key: shortKey }, {}],
      ['mismatched valid key', { private_key: differentKey }, {}],
    ]) {
      const profile = options();
      await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
      const original = await cache();
      const identityFile = path.join(original.folder, 'identity.json');
      const certificateFile = path.join(original.folder, 'certificate.json');
      await writeFile(identityFile, JSON.stringify({ ...original.identity, ...identityPatch }));
      const identityText = await readFile(identityFile, 'utf8');
      const certificateText = await readFile(certificateFile, 'utf8');
      const replacement = { ...profile, ...optionPatch };
      const requests = [];
      let revocationRequest;
      await withWarnings(async warnings => {
        await withFetch(async (url, request) => {
          requests.push(url.pathname);
          if (url.pathname === '/device/mqtt/revoke') {
            revocationRequest = [url, request];
            assert.equal(await readFile(identityFile, 'utf8'), identityText, name);
            assert.equal(await readFile(certificateFile, 'utf8'), certificateText, name);
            const response = revoked(url, request, replacement, JSON.parse(identityText).device_id);
            return name === 'different user' ? new Response(null, { status: 403 }) : response;
          }
          assert.equal(url.pathname, '/device/mqtt/enroll');
          await assert.rejects(stat(certificateFile), { code: 'ENOENT' });
          const fresh = JSON.parse(await readFile(identityFile, 'utf8'));
          assert.equal(fresh.user_id, replacement.userId, name);
          assert.notEqual(fresh.private_key, original.identity.private_key, name);
          assert.notEqual(fresh.private_key, JSON.parse(identityText).private_key, name);
          return Response.json(issue(JSON.parse(request.body).csr));
        }, async () => {
          await enrollMqttDevice(replacement);
          const fresh = await cache();
          assert.ok(new X509Certificate(fresh.certificate.certificate_pem).checkPrivateKey(createPrivateKey(fresh.identity.private_key)), name);
          await enrollMqttDevice(replacement);
        });
        assert.deepEqual(warnings, name === 'different user' ? [[FAILED_REVOCATION_WARNING]] : []);
      });
      assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll'], name);
      revoked(...revocationRequest, replacement, JSON.parse(identityText).device_id);
    }
  });

  await check('failed or unconfirmed revocation warns without private details and continues with a fresh key and certificate', async () => {
    for (const failure of [() => { throw new Error('PRIVATE_PROVIDER_DETAIL'); },
      () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 403 }),
      () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 502 }), () => Response.json({ revoked: false }),
      () => Response.json({}), () => new Response('invalid JSON')]) {
      const profile = options();
      await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
      const saved = await cache();
      const replacement = { ...profile, deviceId: 'replacement-device' };
      const requests = [];
      let revocationRequest;
      await withWarnings(async warnings => {
        await withFetch(async (url, request) => {
          requests.push(url.pathname);
          if (url.pathname === '/device/mqtt/revoke') {
            revocationRequest = [url, request];
            assert.deepEqual(await cache(), saved);
            revoked(url, request, replacement);
            return failure();
          }
          assert.equal(url.href, `${replacement.serverUrl}/device/mqtt/enroll`);
          await assert.rejects(stat(path.join(saved.folder, 'certificate.json')), { code: 'ENOENT' });
          return Response.json(issue(JSON.parse(request.body).csr));
        }, async () => {
          await enrollMqttDevice(replacement);
          const fresh = await cache();
          assert.equal(fresh.identity.device_id, replacement.deviceId);
          assert.notEqual(fresh.identity.private_key, saved.identity.private_key);
          assert.ok(new X509Certificate(fresh.certificate.certificate_pem).checkPrivateKey(createPrivateKey(fresh.identity.private_key)));
          await enrollMqttDevice(replacement);
        });
        assert.deepEqual(warnings, [[FAILED_REVOCATION_WARNING]]);
      });
      assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll']);
      revoked(...revocationRequest, replacement);
    }
  });

  await check('a session change during successful or failed revocation preserves cached credentials without fresh enrollment', async () => {
    for (const refused of [false, true]) {
      const profile = options();
      await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
      const saved = await cache();
      const identityText = await readFile(path.join(saved.folder, 'identity.json'), 'utf8');
      const certificateText = await readFile(path.join(saved.folder, 'certificate.json'), 'utf8');
      let active = true;
      const replacement = { ...profile, deviceId: 'replacement-device', assertSessionStillActive() { if (!active) throw new Error('session changed'); } };
      const requests = [];
      let revocationRequest;
      await withWarnings(async warnings => {
        await withFetch(async (url, request) => {
          requests.push(url.pathname);
          revocationRequest = [url, request];
          active = false;
          const response = revoked(url, request, replacement);
          return refused ? new Response(null, { status: 403 }) : response;
        }, async () => {
          await assert.rejects(enrollMqttDevice(replacement), /session changed/);
        });
        assert.deepEqual(warnings, refused ? [[FAILED_REVOCATION_WARNING]] : []);
      });
      assert.deepEqual(requests, ['/device/mqtt/revoke']);
      revoked(...revocationRequest, replacement);
      assert.equal(await readFile(path.join(saved.folder, 'identity.json'), 'utf8'), identityText);
      assert.equal(await readFile(path.join(saved.folder, 'certificate.json'), 'utf8'), certificateText);
    }
  });

  await check('a failed replacement enrollment keeps its new key for the next attempt', async () => {
    const profile = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
    const previous = await cache();
    const replacement = { ...profile, deviceId: 'replacement-device' };
    const requests = [];
    await withFetch(async (url, request) => {
      requests.push(url.pathname);
      if (url.pathname === '/device/mqtt/revoke') return revoked(url, request, replacement);
      assert.equal(url.pathname, '/device/mqtt/enroll');
      return new Response(null, { status: 503 });
    }, async () => {
      await assert.rejects(enrollMqttDevice(replacement), /HTTP 503/);
    });
    assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll']);
    const identityText = await readFile(path.join(mqttFolder(), 'identity.json'), 'utf8');
    assert.equal(JSON.parse(identityText).device_id, replacement.deviceId);
    assert.notEqual(JSON.parse(identityText).private_key, previous.identity.private_key);
    await assert.rejects(stat(path.join(mqttFolder(), 'certificate.json')), { code: 'ENOENT' });
    await withFetch(async (url, request) => {
      assert.equal(url.pathname, '/device/mqtt/enroll');
      return Response.json(issue(JSON.parse(request.body).csr));
    }, async () => { await enrollMqttDevice(replacement); });
    assert.equal(await readFile(path.join(mqttFolder(), 'identity.json'), 'utf8'), identityText);
  });

  await check('a second startup cannot delete credentials while replacement enrollment is in progress', async () => {
    const profile = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    let finishRequest;
    const pending = new Promise(resolve => { finishRequest = resolve; });
    const requests = [];
    await withFetch(async (url, request) => {
      requests.push(url.pathname);
      if (url.pathname === '/device/mqtt/revoke') {
        const deviceId = JSON.parse(request.body).device_id;
        return revoked(url, request, { ...profile, deviceId }, deviceId === 'replacement-device' ? DEVICE_ID : 'replacement-device');
      }
      assert.equal(url.pathname, '/device/mqtt/enroll');
      const certificate = issue(JSON.parse(request.body).csr);
      requestStarted();
      await pending;
      return Response.json(certificate);
    }, async () => {
      const first = enrollMqttDevice({ ...profile, deviceId: 'replacement-device' });
      try {
        await Promise.race([started, first.then(() => assert.fail('enrollment must wait for the response'))]);
        const identityText = await readFile(path.join(mqttFolder(), 'identity.json'), 'utf8');
        await assert.rejects(enrollMqttDevice({ ...profile, deviceId: 'competing-device' }), /credentials are in use/);
        assert.equal(await readFile(path.join(mqttFolder(), 'identity.json'), 'utf8'), identityText);
        assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll']);
      } finally {
        finishRequest();
        await first;
      }
      assert.equal((await cache()).identity.device_id, 'replacement-device');
      await enrollMqttDevice({ ...profile, deviceId: 'competing-device' });
      assert.equal((await cache()).identity.device_id, 'competing-device');
      assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll', '/device/mqtt/revoke', '/device/mqtt/enroll']);
    });
  });

  await check('a failed certificate removal leaves the old key intact and allows a later retry', async () => {
    const profile = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
    const identityFile = path.join(mqttFolder(), 'identity.json');
    const certificateFile = path.join(mqttFolder(), 'certificate.json');
    const previousIdentity = await readFile(identityFile, 'utf8');
    await rm(certificateFile);
    await mkdir(certificateFile);
    const replacement = { ...profile, deviceId: 'replacement-device' };
    let revocations = 0;
    await withFetch(async (url, request) => {
      revocations++;
      assert.equal(await readFile(identityFile, 'utf8'), previousIdentity);
      return revoked(url, request, replacement);
    }, async () => {
      await assert.rejects(enrollMqttDevice(replacement), /credentials could not be reset/);
    });
    assert.equal(revocations, 1);
    assert.deepEqual(JSON.parse(await readFile(identityFile, 'utf8')), { ...JSON.parse(previousIdentity), reset_pending: true });
    await rm(certificateFile, { recursive: true });
    const requests = [];
    await withFetch(async (url, request) => {
      requests.push(url.pathname);
      if (url.pathname === '/device/mqtt/revoke') return revoked(url, request, replacement);
      assert.equal(url.pathname, '/device/mqtt/enroll');
      return Response.json(issue(JSON.parse(request.body).csr));
    }, async () => { await enrollMqttDevice(replacement); });
    assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/enroll']);
    assert.equal((await cache()).identity.device_id, replacement.deviceId);
  });

  await check('interrupted key replacement keeps its reset pending after certificate deletion and retries with a fresh key', async () => {
    const profile = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
    const previous = await cache();
    const identityFile = path.join(previous.folder, 'identity.json');
    const certificateFile = path.join(previous.folder, 'certificate.json');
    const differentKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    const mismatchedIdentity = { ...previous.identity, private_key: differentKey };
    await writeFile(identityFile, JSON.stringify(mismatchedIdentity));
    const requests = [];
    await withFetch(async (url, request) => {
      requests.push(url.pathname);
      return revoked(url, request, profile);
    }, async () => {
      await assert.rejects(enrollMqttDevice({
        ...profile,
        assertSessionStillActive() { if (!existsSync(certificateFile)) throw new Error('session changed after certificate deletion'); },
      }), /credentials could not be reset/);
    });
    assert.deepEqual(requests, ['/device/mqtt/revoke']);
    assert.deepEqual(JSON.parse(await readFile(identityFile, 'utf8')), { ...mismatchedIdentity, reset_pending: true });
    assert.equal((await stat(identityFile)).mode & 0o777, 0o600);
    await assert.rejects(stat(certificateFile), { code: 'ENOENT' });
    await withFetch(async (url, request) => {
      requests.push(url.pathname);
      if (url.pathname === '/device/mqtt/revoke') return revoked(url, request, profile);
      assert.equal(url.pathname, '/device/mqtt/enroll');
      return Response.json(issue(JSON.parse(request.body).csr));
    }, async () => { await enrollMqttDevice(profile); });
    assert.deepEqual(requests, ['/device/mqtt/revoke', '/device/mqtt/revoke', '/device/mqtt/enroll']);
    const saved = await cache();
    assert.notEqual(saved.identity.private_key, differentKey);
    assert.notEqual(saved.identity.private_key, previous.identity.private_key);
    assert.equal(saved.identity.reset_pending, undefined);
    assert.ok(new X509Certificate(saved.certificate.certificate_pem).checkPrivateKey(createPrivateKey(saved.identity.private_key)));
  });

  await check('mismatched key, expired/future certificate, invalid response and unsafe broker URL cannot be saved', async () => {
    const alternate = options();
    let otherCertificate;
    await withFetch(async (_url, request) => { otherCertificate = issue(JSON.parse(request.body).csr); return Response.json(otherCertificate); }, async () => { await enrollMqttDevice(alternate); });
    for (const responseFor of [() => otherCertificate, (csr) => issue(csr, { expired: true }), (csr) => issue(csr, { future: true }), () => ({}), (csr) => ({ ...issue(csr), broker_url: 'mqtt://example.test' }), (csr) => ({ ...issue(csr), broker_url: 'mqtts://user:password@example.test:8883' })]) {
      const profile = options();
      let calls = 0;
      await withFetch(async (_url, request) => { calls++; return Response.json(responseFor(JSON.parse(request.body).csr)); }, async () => {
        await assert.rejects(enrollMqttDevice(profile), /certificate/);
        assert.equal(calls, 1);
        await assert.rejects(stat(path.join(mqttFolder(), 'certificate.json')), { code: 'ENOENT' });
      });
    }
  });

  await check('local HTTP backends enroll while retaining broker TLS and redirect protection', async () => {
    for (const serverUrl of ['http://localhost:3007', 'http://127.0.0.1:3007', 'http://[::1]:3007', 'http://mcp.localhost:3007']) {
      let calls = 0;
      await withFetch(async (url, request) => {
        calls++;
        assert.equal(url.href, `${serverUrl}/device/mqtt/enroll`);
        assert.equal(request.redirect, 'error');
        return Response.json(issue(JSON.parse(request.body).csr));
      }, async () => {
        const config = await enrollMqttDevice(options({ serverUrl }));
        assert.equal(calls, 1);
        assert.equal(config.options.rejectUnauthorized, true);
        assert.equal(new URL(config.url).protocol, 'mqtts:');
      });
    }
  });

  await check('remote HTTP, lookalike hosts and unsafe URL fields are rejected before enrollment', async () => {
    let calls = 0;
    await withFetch(async (_url, request) => { calls++; return Response.json(issue(JSON.parse(request.body).csr)); }, async () => {
      for (const serverUrl of ['http://public.example.test', 'http://192.168.1.10:3007', 'ftp://localhost:3007',
        'http://localhost.example.test', 'http://mcp.localhost.example.test',
        'http://mcp.localhost.localdomain:3007', 'http://mcp.localhost.localdomain.example.test',
        'http://user:pass@localhost:3007', 'http://localhost:3007/path',
        'http://mcp.localhost:3007?secret=yes', 'http://127.0.0.1:3007#fragment',
        'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?secret=yes', 'https://example.test#fragment']) {
        await assert.rejects(enrollMqttDevice(options({ serverUrl })), /HTTPS|MCP_SERVER_URL/);
      }
      assert.equal(calls, 0);
    });
  });

  await check('registration re-enrolls a changed device, reuses credentials, and preserves the Presence channel', async () => {
    const profile = options();
    const requests = [];
    await withFetch(async (url, request) => {
      requests.push(url.pathname);
      if (url.pathname === '/device/mqtt/revoke') return revoked(url, request, { ...profile, deviceId: 'replacement-device' });
      assert.equal(url.pathname, '/device/mqtt/enroll');
      return Response.json(issue(JSON.parse(request.body).csr));
    }, async () => {
      for (const deviceId of [DEVICE_ID, DEVICE_ID, 'replacement-device', 'replacement-device']) {
        const order = [];
        const channel = new RemoteChannel(profile);
        Object.assign(channel, {
          _user: { id: USER_ID }, client: {},
          findDevice: async () => ({ id: deviceId }), updateDevice: async () => ({ error: null }),
          getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
          startMqttTransport: async config => { assert.ok(config.options.cert); order.push('mqtt'); },
          createChannel: async () => { order.push('broadcast'); },
        });
        const startMqtt = channel.startMqtt.bind(channel);
        let mqttStartup;
        channel.startMqtt = assertCurrent => (mqttStartup = startMqtt(assertCurrent));
        await channel.registerDevice({}, deviceId, 'test', () => {});
        assert.deepEqual(order, ['broadcast']);
        await mqttStartup;
        assert.deepEqual(order, ['broadcast', 'mqtt']);
      }
    });
    assert.deepEqual(requests, ['/device/mqtt/enroll', '/device/mqtt/revoke', '/device/mqtt/enroll']);
  });

  await check('MQTT connection failure preserves Broadcast startup and cleans up the receiver', async () => {
    const channel = new RemoteChannel(options());
    let stopped = 0;
    let broadcastStarts = 0;
    Object.assign(channel, {
      _user: { id: USER_ID }, client: {},
      findDevice: async () => ({ id: DEVICE_ID }), updateDevice: async () => ({ error: null }),
      prepareMqttConfig: async () => ({}),
      startMqttTransport: async () => {
        channel.mqttReceiver = { stop: async () => { stopped++; } };
        throw new Error('synthetic MQTT connection failure');
      },
      createChannel: async () => { broadcastStarts++; },
    });
    const startMqtt = channel.startMqtt.bind(channel);
    let mqttStartup;
    channel.startMqtt = assertCurrent => (mqttStartup = startMqtt(assertCurrent));
    await channel.registerDevice({}, DEVICE_ID, 'test', () => {});
    await assert.rejects(mqttStartup, /connection failure/);
    assert.equal(stopped, 1);
    assert.equal(channel.mqttReceiver, null);
    assert.equal(broadcastStarts, 1);
  });

  await check('transport rollout off returns enrollment 404 without blocking Broadcast despite stale execution cache', async () => {
    rolloutManager.update({ IS_MQTT_EXECUTION_ENABLED: true });
    const profile = options();
    const channel = new RemoteChannel(profile);
    let broadcasts = 0;
    Object.assign(channel, {
      _user: { id: USER_ID }, client: {},
      findDevice: async () => ({ id: DEVICE_ID }), updateDevice: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
      startMqttTransport: async () => assert.fail('refused enrollment cannot start MQTT'),
      createChannel: async () => { broadcasts++; },
    });
    const startMqtt = channel.startMqtt.bind(channel);
    let mqttStartup;
    channel.startMqtt = assertCurrent => (mqttStartup = startMqtt(assertCurrent));
    await withFetch(async () => new Response('{}', { status: 404 }), async () => {
      await channel.registerDevice({}, DEVICE_ID, 'test', () => {});
      assert.equal(broadcasts, 1);
      await assert.rejects(mqttStartup, /HTTP 404/);
    });
    assert.equal(channel.mqttReceiver, null);
  });

  await check('shutdown during enrollment prevents credentials from being saved or a listener from starting', async () => {
    const profile = options();
    const channel = new RemoteChannel(profile);
    let starts = 0;
    let broadcasts = 0;
    Object.assign(channel, {
      _user: { id: USER_ID }, client: {},
      findDevice: async () => ({ id: DEVICE_ID }), updateDevice: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
      startMqttTransport: async () => { starts++; }, createChannel: async () => { broadcasts++; },
    });
    const startMqtt = channel.startMqtt.bind(channel);
    let mqttStartup;
    channel.startMqtt = assertCurrent => (mqttStartup = startMqtt(assertCurrent));
    await withFetch(async (_url, request) => {
      const certificate = issue(JSON.parse(request.body).csr);
      await channel.unsubscribe();
      return Response.json(certificate);
    }, async () => {
      await channel.registerDevice({}, DEVICE_ID, 'test', () => {});
      await assert.rejects(mqttStartup, /session changed/);
    });
    assert.equal(starts, 0);
    assert.equal(broadcasts, 1);
    await assert.rejects(stat(path.join(mqttFolder(), 'certificate.json')), { code: 'ENOENT' });
  });

  await check('enrollment cannot redirect a device to a different broker', async () => {
    const profile = options();
    await withFetch(async (_url, request) => Response.json({
      ...issue(JSON.parse(request.body).csr), broker_url: 'mqtts://another.iot.eu-west-1.amazonaws.com:8883',
    }), async () => {
      await assert.rejects(enrollMqttDevice(profile), /configured broker/);
    });
    await assert.rejects(stat(path.join(mqttFolder(), 'certificate.json')), { code: 'ENOENT' });
  });

  console.log(`MQTT enrollment device: ${passed} checks passed`);
} finally {
  mock.restoreAll();
  await rm(workspace, { recursive: true, force: true });
  rolloutManager.update(originalRollouts);
  if (originalBroker === undefined) delete process.env.MQTT_BROKER_URL;
  else process.env.MQTT_BROKER_URL = originalBroker;
  if (originalDcEnv === undefined) delete process.env.DC_ENV;
  else process.env.DC_ENV = originalDcEnv;
}
