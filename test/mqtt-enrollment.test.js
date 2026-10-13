#!/usr/bin/env node
// Real key generation, CSR signatures, X509 validation and private filesystem storage.
// The HTTP response is a controlled seam here; the server suite covers the actual route.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import forge from 'node-forge';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { enrollMqttDevice } = await import('../dist/remote-device/mqtt-enrollment.js');
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const originalFlag = process.env.MQTT_TRANSPORT_ENABLED;
process.env.MQTT_TRANSPORT_ENABLED = 'true';
const workspace = await mkdtemp(path.join(tmpdir(), 'mqtt-enrollment-device-'));
const caPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const caKey = forge.pki.privateKeyFromPem(caPair.privateKey.export({ format: 'pem', type: 'pkcs1' }));
let profileNumber = 0;
let certificateNumber = 0;
let passed = 0;

/** Every check gets a private profile, so failures cannot alter a user's saved session. */
function options(overrides = {}) {
  return { serverUrl: 'https://staging-mcp.desktopcommander.app', profilePath: path.join(workspace, `profile-${++profileNumber}.json`), userId: USER_ID, deviceId: DEVICE_ID, accessToken: 'synthetic-test-token', ...overrides };
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
  return { certificate_pem: forge.pki.certificateToPem(certificate), certificate_id: certificateNumber.toString(16).padStart(64, '0'), broker_url: 'mqtts://a1vw7p0stdnykd-ats.iot.eu-west-3.amazonaws.com:8883' };
}

/** Scope the global fetch seam even when a deliberately invalid request fails. */
async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}

/** Read only our throwaway credentials; private material is compared without printing it. */
async function cache(profile) {
  const folder = `${profile.profilePath}.mqtt`;
  return { folder, identity: JSON.parse(await readFile(path.join(folder, 'identity.json'), 'utf8')), certificate: JSON.parse(await readFile(path.join(folder, 'certificate.json'), 'utf8')) };
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
      const saved = await cache(profile);
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

  await check('network refusal and HTTP errors make exactly one attempt and never cache a certificate', async () => {
    for (const failure of [() => { throw new Error('PRIVATE_NETWORK_DETAIL'); }, () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 403 }), () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 502 })]) {
      const profile = options();
      let calls = 0;
      await withFetch(async () => { calls++; return failure(); }, async () => {
        await assert.rejects(enrollMqttDevice(profile), (error) => /restart/.test(error.message) && !/PRIVATE_/.test(error.message));
        assert.equal(calls, 1);
        await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
      });
    }
  });

  await check('an explicit manual restart after failed enrollment retains the original private key', async () => {
    const profile = options();
    await withFetch(async () => { throw new Error('injected'); }, async () => { await assert.rejects(enrollMqttDevice(profile)); });
    const original = await readFile(`${profile.profilePath}.mqtt/identity.json`, 'utf8');
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile); });
    assert.equal(await readFile(`${profile.profilePath}.mqtt/identity.json`, 'utf8'), original);
  });

  await check('identity changes and corrupt key/certificate caches fail without re-enrolling', async () => {
    const base = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(base); });
    const saved = await cache(base);
    await withFetch(async () => { throw new Error('must not POST'); }, async () => {
      for (const patch of [{ serverUrl: 'https://staging-mcp.desktopcommander.app:8443' }, { userId: 'another-user' }, { deviceId: 'another-device' }]) {
        await assert.rejects(enrollMqttDevice({ ...base, ...patch }), /different backend, user, or device/);
      }
      for (const [file, value] of [['identity.json', '{'], ['identity.json', JSON.stringify({ ...saved.identity, private_key: 'invalid' })], ['certificate.json', '{'], ['certificate.json', JSON.stringify({ ...saved.certificate, certificate_id: 'invalid' })]]) {
        const profile = options();
        const folder = `${profile.profilePath}.mqtt`;
        await mkdir(folder, { mode: 0o700 });
        await writeFile(path.join(folder, 'identity.json'), JSON.stringify(saved.identity), { mode: 0o600 });
        await writeFile(path.join(folder, 'certificate.json'), JSON.stringify(saved.certificate), { mode: 0o600 });
        await writeFile(path.join(folder, file), value);
        await assert.rejects(enrollMqttDevice(profile), /cache|private key|certificate/);
      }
    });
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
        await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
      });
    }
  });

  await check('enrollment always requires HTTPS and URLs cannot redirect or carry credentials', async () => {
    let calls = 0;
    await withFetch(async (_url, request) => { calls++; return Response.json(issue(JSON.parse(request.body).csr)); }, async () => {
      for (const serverUrl of ['http://public.example.test', 'http://localhost:3007', 'http://127.0.0.1:3007',
        'http://[::1]:3007', 'http://mcp.localhost.localdomain:3007', 'http://mcp.localhost.localdomain.example.test',
        'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?secret=yes', 'https://example.test#fragment']) {
        await assert.rejects(enrollMqttDevice(options({ serverUrl })), /HTTPS|MCP_SERVER_URL/);
      }
      assert.equal(calls, 0);
    });
  });

  await check('registration enrolls once, reuses credentials, and preserves the Presence channel', async () => {
    const profile = options();
    let requests = 0;
    await withFetch(async (_url, request) => {
      requests++;
      return Response.json(issue(JSON.parse(request.body).csr));
    }, async () => {
      for (let startup = 0; startup < 2; startup++) {
        const order = [];
        const channel = new RemoteChannel(profile);
        Object.assign(channel, {
          _user: { id: USER_ID }, client: {},
          findDevice: async () => ({ id: DEVICE_ID }), updateDevice: async () => ({ error: null }),
          getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
          startMqttTransport: async config => { assert.ok(config.options.cert); order.push('mqtt'); },
          createChannel: async () => { order.push('broadcast'); },
        });
        await channel.registerDevice({}, DEVICE_ID, 'test', () => {});
        assert.deepEqual(order, ['mqtt', 'broadcast']);
      }
    });
    assert.equal(requests, 1);
  });

  await check('disabled MQTT skips enrollment; enabled MQTT enrollment failure stops startup', async () => {
    for (const flag of [undefined, 'false', 'TRUE', 'true']) {
      if (flag === undefined) delete process.env.MQTT_TRANSPORT_ENABLED;
      else process.env.MQTT_TRANSPORT_ENABLED = flag;
      const profile = options();
      const channel = new RemoteChannel(profile);
      let broadcastStarts = 0;
      let requests = 0;
      Object.assign(channel, {
        _user: { id: USER_ID }, client: {},
        findDevice: async () => ({ id: DEVICE_ID }), updateDevice: async () => ({ error: null }),
        getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
        createChannel: async () => { broadcastStarts++; },
      });
      await withFetch(async () => {
        requests++;
        throw new Error('synthetic outage');
      }, async () => {
        const startup = channel.registerDevice({}, DEVICE_ID, 'test', () => {});
        if (flag === 'true') await assert.rejects(startup, /request failed/);
        else await startup;
      });
      assert.equal(requests, flag === 'true' ? 1 : 0);
      assert.equal(broadcastStarts, flag === 'true' ? 0 : 1);
      assert.equal(channel.mqttReceiver, null);
    }
  });

  await check('MQTT connection failure stops startup and cleans up the receiver', async () => {
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
    await assert.rejects(channel.registerDevice({}, DEVICE_ID, 'test', () => {}), /connection failure/);
    assert.equal(stopped, 1);
    assert.equal(channel.mqttReceiver, null);
    assert.equal(broadcastStarts, 0);
  });

  await check('shutdown during enrollment prevents credentials from being saved or a listener from starting', async () => {
    const profile = options();
    const channel = new RemoteChannel(profile);
    let starts = 0;
    Object.assign(channel, {
      _user: { id: USER_ID }, client: {},
      findDevice: async () => ({ id: DEVICE_ID }), updateDevice: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
      startMqttTransport: async () => { starts++; }, createChannel: async () => { starts++; },
    });
    await withFetch(async (_url, request) => {
      const certificate = issue(JSON.parse(request.body).csr);
      await channel.unsubscribe();
      return Response.json(certificate);
    }, async () => {
      await assert.rejects(channel.registerDevice({}, DEVICE_ID, 'test', () => {}), /session changed/);
    });
    assert.equal(starts, 0);
    await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
  });

  await check('enrollment cannot redirect a device to a different broker', async () => {
    const profile = options();
    await withFetch(async (_url, request) => Response.json({
      ...issue(JSON.parse(request.body).csr), broker_url: 'mqtts://another.iot.eu-west-1.amazonaws.com:8883',
    }), async () => {
      await assert.rejects(enrollMqttDevice(profile), /configured broker/);
    });
    await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
  });

  console.log(`MQTT enrollment device: ${passed} checks passed`);
} finally {
  await rm(workspace, { recursive: true, force: true });
  if (originalFlag === undefined) delete process.env.MQTT_TRANSPORT_ENABLED;
  else process.env.MQTT_TRANSPORT_ENABLED = originalFlag;
}
