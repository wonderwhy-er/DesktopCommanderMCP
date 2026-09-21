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
const ENV = { MQTT_TRANSPORT_ENABLED: 'true' };
const workspace = await mkdtemp(path.join(tmpdir(), 'mqtt-enrollment-device-'));
const caPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const caKey = forge.pki.privateKeyFromPem(caPair.privateKey.export({ format: 'pem', type: 'pkcs1' }));
let profileNumber = 0;
let certificateNumber = 0;
let passed = 0;

/** Every check gets a private profile, so failures cannot alter a user's saved session. */
function options(overrides = {}) {
  return { serverUrl: 'https://pilot.example.test', profilePath: path.join(workspace, `profile-${++profileNumber}.json`), userId: USER_ID, deviceId: DEVICE_ID, accessToken: 'synthetic-test-token', ...overrides };
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
  return { certificate_pem: forge.pki.certificateToPem(certificate), certificate_id: certificateNumber.toString(16).padStart(64, '0'), broker_url: 'mqtts://test-ats.iot.eu-west-1.amazonaws.com:8883' };
}

/** Scope the global fetch seam and environment even when a deliberately invalid request fails. */
async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(env, run) {
  const names = new Set([...Object.keys(process.env).filter((name) => name.startsWith('MQTT_')), ...Object.keys(env)]);
  const before = Object.fromEntries([...names].map((name) => [name, process.env[name]]));
  for (const name of names) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  try { return await run(); }
  finally { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } }
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
      assert.equal(url.href, 'https://pilot.example.test/device/mqtt/enroll');
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
      const first = await enrollMqttDevice(profile, ENV);
      const second = await enrollMqttDevice(profile, ENV);
      assert.equal(calls, 1, 'a process restart uses the persisted successful enrollment');
      const saved = await cache(profile);
      const csr = forge.pki.certificationRequestFromPem(sent.csr);
      assert.ok(csr.verify());
      const csrPublicKey = createPublicKey(forge.pki.publicKeyToPem(csr.publicKey));
      assert.ok(csrPublicKey.equals(createPublicKey(saved.identity.private_key)));
      assert.ok(new X509Certificate(saved.certificate.certificate_pem).checkPrivateKey(createPrivateKey(saved.identity.private_key)));
      assert.deepEqual([saved.identity.backend_origin, saved.identity.user_id, saved.identity.device_id], ['https://pilot.example.test', USER_ID, DEVICE_ID]);
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
        await assert.rejects(enrollMqttDevice(profile, ENV), (error) => /restart/.test(error.message) && !/PRIVATE_/.test(error.message));
        assert.equal(calls, 1);
        await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
      });
    }
  });

  await check('an explicit manual restart after failed enrollment retains the original private key', async () => {
    const profile = options();
    await withFetch(async () => { throw new Error('injected'); }, async () => { await assert.rejects(enrollMqttDevice(profile, ENV)); });
    const original = await readFile(`${profile.profilePath}.mqtt/identity.json`, 'utf8');
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(profile, ENV); });
    assert.equal(await readFile(`${profile.profilePath}.mqtt/identity.json`, 'utf8'), original);
  });

  await check('identity changes and corrupt key/certificate caches fail without re-enrolling', async () => {
    const base = options();
    await withFetch(async (_url, request) => Response.json(issue(JSON.parse(request.body).csr)), async () => { await enrollMqttDevice(base, ENV); });
    const saved = await cache(base);
    await withFetch(async () => { throw new Error('must not POST'); }, async () => {
      for (const patch of [{ serverUrl: 'https://another.example.test' }, { userId: 'another-user' }, { deviceId: 'another-device' }]) {
        await assert.rejects(enrollMqttDevice({ ...base, ...patch }, ENV), /different backend, user, or device/);
      }
      for (const [file, value] of [['identity.json', '{'], ['identity.json', JSON.stringify({ ...saved.identity, private_key: 'invalid' })], ['certificate.json', '{'], ['certificate.json', JSON.stringify({ ...saved.certificate, certificate_id: 'invalid' })]]) {
        const profile = options();
        const folder = `${profile.profilePath}.mqtt`;
        await mkdir(folder, { mode: 0o700 });
        await writeFile(path.join(folder, 'identity.json'), JSON.stringify(saved.identity), { mode: 0o600 });
        await writeFile(path.join(folder, 'certificate.json'), JSON.stringify(saved.certificate), { mode: 0o600 });
        await writeFile(path.join(folder, file), value);
        await assert.rejects(enrollMqttDevice(profile, ENV), /cache|private key|certificate/);
      }
    });
  });

  await check('mismatched key, expired/future certificate, invalid response and unsafe broker URL cannot be saved', async () => {
    const alternate = options();
    let otherCertificate;
    await withFetch(async (_url, request) => { otherCertificate = issue(JSON.parse(request.body).csr); return Response.json(otherCertificate); }, async () => { await enrollMqttDevice(alternate, ENV); });
    for (const responseFor of [() => otherCertificate, (csr) => issue(csr, { expired: true }), (csr) => issue(csr, { future: true }), () => ({}), (csr) => ({ ...issue(csr), broker_url: 'mqtt://example.test' }), (csr) => ({ ...issue(csr), broker_url: 'mqtts://user:password@example.test:8883' })]) {
      const profile = options();
      let calls = 0;
      await withFetch(async (_url, request) => { calls++; return Response.json(responseFor(JSON.parse(request.body).csr)); }, async () => {
        await assert.rejects(enrollMqttDevice(profile, ENV), /certificate/);
        assert.equal(calls, 1);
        await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
      });
    }
  });

  await check('HTTPS is required except explicitly allowed loopback and URLs cannot redirect or carry credentials', async () => {
    let calls = 0;
    await withFetch(async (_url, request) => { calls++; return Response.json(issue(JSON.parse(request.body).csr)); }, async () => {
      for (const serverUrl of ['http://public.example.test', 'http://localhost:3007', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?secret=yes']) {
        await assert.rejects(enrollMqttDevice(options({ serverUrl }), ENV), /HTTPS|MCP_SERVER_URL/);
      }
      assert.equal(calls, 0);
      await enrollMqttDevice(options({ serverUrl: 'http://127.0.0.1:3007' }), { ...ENV, MQTT_ALLOW_INSECURE_LOCAL: 'true' });
      assert.equal(calls, 1);
    });
  });

  await check('the local MCP hostname is opt-in and lookalike HTTP hosts never receive the bearer token', async () => {
    let calls = 0;
    const serverUrl = 'http://mcp.localhost.localdomain:3007';
    await withFetch(async (url, request) => {
      calls++;
      assert.equal(url.href, `${serverUrl}/device/mqtt/enroll`);
      return Response.json(issue(JSON.parse(request.body).csr));
    }, async () => {
      for (const flag of [undefined, 'false']) {
        await assert.rejects(enrollMqttDevice(options({ serverUrl }), { ...ENV, MQTT_ALLOW_INSECURE_LOCAL: flag }), /HTTPS/);
      }
      const localEnv = { ...ENV, MQTT_ALLOW_INSECURE_LOCAL: 'true' };
      for (const hostname of ['mcp.localhost.localdomain.example.test', 'other.localdomain']) {
        await assert.rejects(enrollMqttDevice(options({ serverUrl: `http://${hostname}:3007` }), localEnv), /HTTPS/);
      }
      assert.equal(calls, 0);
      await enrollMqttDevice(options({ serverUrl }), localEnv);
      assert.equal(calls, 1);
    });
  });

  await check('session invalidation during enrollment blocks saving credentials and starting either transport', async () => {
    const profile = options();
    let channel;
    await withEnv(ENV, async () => {
      channel = new RemoteChannel({ serverUrl: profile.serverUrl, profilePath: profile.profilePath });
    });
    let transportStarts = 0;
    Object.assign(channel, {
      client: {}, _user: { id: USER_ID },
      findDevice: async () => ({ id: DEVICE_ID, capabilities: {} }), updateDevice: async () => {},
      getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
      createChannel: async () => { transportStarts++; }, startMqttTransport: async () => { transportStarts++; },
    });
    await withEnv(ENV, async () => {
      await withFetch(async (_url, request) => {
        const issued = issue(JSON.parse(request.body).csr);
        channel.authGeneration++;
        return Response.json(issued);
      }, async () => { await assert.rejects(channel.registerDevice({}, DEVICE_ID, 'QA device', () => {}), /session changed/); });
    });
    assert.equal(transportStarts, 0);
    assert.equal(channel.mqttReceiver, null);
    await assert.rejects(stat(`${profile.profilePath}.mqtt/certificate.json`), { code: 'ENOENT' });
  });

  await check('MQTT startup enrolls with the old flag omitted or false and restart reuses its cache', async () => {
    for (const oldFlag of [undefined, 'false']) {
      const profile = options();
      let calls = 0;
      let transportStarts = 0;
      // Keep registration and credential preparation real; transport sockets are covered separately.
      const makeChannel = () => {
        const channel = new RemoteChannel({ serverUrl: profile.serverUrl, profilePath: profile.profilePath });
        Object.assign(channel, {
          client: {}, _user: { id: USER_ID },
          findDevice: async () => ({ id: DEVICE_ID, capabilities: {} }), updateDevice: async () => {},
          getSession: async () => ({ data: { session: { access_token: profile.accessToken } }, error: null }),
          createChannel: async () => {},
          startMqttTransport: async (config) => {
            assert.equal(config.url, 'mqtts://test-ats.iot.eu-west-1.amazonaws.com:8883');
            assert.ok(config.options.cert);
            assert.ok(config.options.key);
            transportStarts++;
          },
        });
        return channel;
      };
      await withEnv({ ...ENV, MQTT_ENROLLMENT_ENABLED: oldFlag }, async () => {
        await withFetch(async (_url, request) => {
          calls++;
          return Response.json(issue(JSON.parse(request.body).csr));
        }, async () => {
          for (let startup = 0; startup < 2; startup++) {
            const channel = makeChannel();
            await channel.registerDevice({}, DEVICE_ID, 'QA device', () => {});
            assert.equal(channel.mqttConfig.userId, USER_ID);
            assert.equal(channel.mqttConfig.deviceId, DEVICE_ID);
          }
        });
      });
      assert.equal(calls, 1, 'a second startup uses the certificate cache');
      assert.equal(transportStarts, 2);
    }
  });

  await check('disabled MQTT needs no enrollment and enabled recovery requires prepared credentials', async () => {
    let calls = 0;
    const messages = [];
    const originalLog = console.log;
    console.log = (...args) => messages.push(args);
    try {
    await withFetch(async () => { calls++; throw new Error('must not POST'); }, async () => {
      for (const enabled of [undefined, 'false']) {
        await withEnv({ MQTT_TRANSPORT_ENABLED: enabled }, async () => {
          const channel = new RemoteChannel();
          assert.equal(await channel.prepareMqttConfig(() => {}), null);
          await channel.startMqttTransport();
          assert.equal(channel.mqttReceiver, null);
        });
      }
      for (const oldFlag of [undefined, 'false']) {
        await withEnv({ ...ENV, MQTT_ENROLLMENT_ENABLED: oldFlag }, async () => {
          const channel = new RemoteChannel();
          await assert.rejects(channel.prepareMqttConfig(() => {}), /authenticated connector backend and profile/);
          await assert.rejects(channel.startMqttTransport(), /enrollment has not completed/);
          assert.equal(channel.mqttReceiver, null);
        });
      }
    });
    assert.equal(calls, 0);
    assert.deepEqual(messages, [
      ['[MQTT] Disabled; set MQTT_TRANSPORT_ENABLED=true to enable'],
      ['[MQTT] Disabled; set MQTT_TRANSPORT_ENABLED=true to enable'],
      ['[MQTT] Enabled; preparing device credentials'],
      ['[MQTT] Enabled; preparing device credentials'],
    ], 'preparation logs report the chosen state without claiming readiness or exposing credentials');
    } finally { console.log = originalLog; }
  });
  console.log(`MQTT enrollment device: ${passed} checks passed`);
} finally { await rm(workspace, { recursive: true, force: true }); }
