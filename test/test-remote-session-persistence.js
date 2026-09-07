import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPDevice } from '../dist/remote-device/device.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

class FakeAuth {
  listeners = [];
  getSessionCalls = 0;
  session = { access_token: 'access-0', refresh_token: 'refresh-0' };

  onAuthStateChange(callback) {
    this.listeners.push(callback);
    return { data: { subscription: { unsubscribe() {} } } };
  }

  async setSession(session) {
    this.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    };
    return { data: { session: this.session }, error: null };
  }

  async getUser() {
    return { data: { user: { id: 'user-1', email: 'test@example.com' } }, error: null };
  }

  async getSession() {
    this.getSessionCalls++;
    return { data: { session: this.session }, error: null };
  }

  emit(event, session) {
    for (const callback of this.listeners) callback(event, session);
  }
}

class FakeRealtime {
  setAuthCalls = [];

  setAuth(token) {
    this.setAuthCalls.push(token);
  }
}

class FakeClient {
  auth = new FakeAuth();
  realtime = new FakeRealtime();
}

function makeDevice(configPath, persistSession = true) {
  const device = Object.create(MCPDevice.prototype);
  device.configPath = configPath;
  device.deviceId = 'device-1';
  device.persistSession = persistSession;
  device.configWriteChain = Promise.resolve();
  device.configWriteSequence = 0;
  device.sessionPersistenceEnabled = false;
  return device;
}

async function readConfig(configPath) {
  return JSON.parse(await fs.readFile(configPath, 'utf8'));
}

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function largeToken(prefix, index) {
  return `${prefix}-${index}-` + 'x'.repeat(32 * 1024);
}

async function testRemoteChannelObserverUsesExactRotatedSnapshot() {
  const channel = new RemoteChannel();
  const client = new FakeClient();
  channel.client = client;
  const seen = [];
  channel.onSessionRotated((session) => seen.push({ ...session }));

  await channel.setSession({ access_token: 'access-0', refresh_token: 'refresh-0' });
  const getSessionCallsBeforeRefresh = client.auth.getSessionCalls;
  const rotated = { access_token: 'access-1', refresh_token: 'refresh-1' };
  client.auth.session = rotated;
  client.auth.emit('TOKEN_REFRESHED', rotated);

  assert.deepEqual(seen, [rotated]);
  assert.equal(client.auth.getSessionCalls, getSessionCallsBeforeRefresh,
    'rotation observer must not re-enter auth state to recover the session');
  assert.equal(client.realtime.setAuthCalls.at(-1), 'access-1');
}

async function testRefreshWithoutFreshRefreshTokenDoesNotPersistFallback() {
  const channel = new RemoteChannel();
  const client = new FakeClient();
  channel.client = client;
  const seen = [];
  channel.onSessionRotated((session) => seen.push(session));

  await channel.setSession({ access_token: 'access-0', refresh_token: 'refresh-0' });
  channel.lastKnownSession = { access_token: 'access-0', refresh_token: 'refresh-0' };
  client.auth.emit('TOKEN_REFRESHED', { access_token: 'access-only' });

  assert.deepEqual(seen, []);
  assert.equal(client.realtime.setAuthCalls.at(-1), 'access-only',
    'realtime JWT should still update even when persistence cannot safely rotate');
  assert.equal(channel.lastKnownSession.refresh_token, 'refresh-0',
    'the previous refresh token may remain an in-memory fallback but must not be persisted');
}

async function testRemoteChannelTracksAndWaitsForInFlightRefresh() {
  const channel = new RemoteChannel();
  const client = new FakeClient();
  channel.client = client;
  let releaseRefresh;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRefresh = resolve; });
  client.auth.refreshSession = async () => {
    markStarted();
    await gate;
    return { data: { session: client.auth.session }, error: null };
  };

  const refresh = channel.refreshTokenNow();
  await started;
  assert.equal(await channel.waitForTokenRefresh(20), false,
    'bounded wait must report a refresh that is still in flight');
  releaseRefresh();
  assert.equal(await channel.waitForTokenRefresh(200), true,
    'bounded wait must observe the tracked refresh settling');
  await refresh;
}

async function testRefreshFailureClearsInFlightTrackerAndAllowsRetry() {
  const channel = new RemoteChannel();
  const client = new FakeClient();
  channel.client = client;
  let calls = 0;
  client.auth.refreshSession = async () => {
    calls++;
    if (calls === 1) throw new Error('synthetic refresh failure');
    return { data: { session: client.auth.session }, error: null };
  };

  await channel.refreshTokenNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.tokenRefreshInFlight, null,
    'a failed refresh must clear the in-flight tracker');

  await channel.refreshTokenNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, 'a cleared tracker must allow the next refresh to run');
  assert.equal(channel.tokenRefreshInFlight, null);
}

async function testInFlightRefreshPersistsBeforeShutdownDisarmsObserver() {
  await withTempDir('dc-session-shutdown-refresh-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const channel = new RemoteChannel();
    const client = new FakeClient();
    channel.client = client;
    await channel.setSession({ access_token: 'initial-a', refresh_token: 'initial-r' });

    const device = makeDevice(configPath, true);
    device.remoteChannel = channel;
    device.isShuttingDown = false;
    device.desktop = { async shutdown() {} };
    channel.unsubscribe = async () => {};
    channel.setOffline = async () => {};
    device.enableSessionPersistence();

    let releaseRefresh;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { releaseRefresh = resolve; });
    client.auth.refreshSession = async () => {
      markStarted();
      await gate;
      const rotated = { access_token: 'rotated-a', refresh_token: 'rotated-r' };
      client.auth.session = rotated;
      client.auth.emit('TOKEN_REFRESHED', rotated);
      return { data: { session: rotated }, error: null };
    };

    const refresh = channel.refreshTokenNow();
    await started;
    setTimeout(() => releaseRefresh(), 30);
    await device.shutdown();
    await refresh;

    const config = await readConfig(configPath);
    assert.equal(config.deviceId, 'device-1');
    assert.equal(config.session.access_token, 'rotated-a');
    assert.equal(config.session.refresh_token, 'rotated-r');
    assert.equal(device.sessionPersistenceEnabled, false,
      'persistence observer must be disarmed after the rotated snapshot is drained');
  });
}

async function testDeviceObserverPersistsLatestRotationAtomically() {
  await withTempDir('dc-session-persist-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const device = makeDevice(configPath, true);
    let observer = null;
    device.remoteChannel = { onSessionRotated(fn) { observer = fn; } };
    device.enableSessionPersistence();
    assert.equal(typeof observer, 'function');

    await device.queuePersistedSession({
      access_token: largeToken('seed-access', 0),
      refresh_token: largeToken('seed-refresh', 0),
    });

    let stopReader = false;
    const readFailures = [];
    const reader = (async () => {
      while (!stopReader) {
        try {
          const parsed = await readConfig(configPath);
          assert.equal(parsed.deviceId, 'device-1');
          assert.equal(typeof parsed.session?.access_token, 'string');
          assert.equal(typeof parsed.session?.refresh_token, 'string');
        } catch (error) {
          readFailures.push(error);
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const writes = [];
    for (let i = 0; i < 100; i++) {
      writes.push(observer({
        access_token: largeToken('access', i),
        refresh_token: largeToken('refresh', i),
      }));
    }
    await Promise.all(writes);
    stopReader = true;
    await reader;

    assert.deepEqual(readFailures, [], 'concurrent readers must never observe invalid JSON');
    const config = await readConfig(configPath);
    assert.equal(config.session.access_token, largeToken('access', 99));
    assert.equal(config.session.refresh_token, largeToken('refresh', 99));
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'successful writes must not leave token-bearing temp files');
  });
}

async function testIncompleteRotationCannotOverwriteValidCredentials() {
  await withTempDir('dc-session-incomplete-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const device = makeDevice(configPath, true);
    await device.queuePersistedSession({
      access_token: 'good-access',
      refresh_token: 'good-refresh',
    });
    const before = await fs.readFile(configPath, 'utf8');

    await device.queuePersistedSession({ access_token: 'new-access', refresh_token: null });
    await device.configWriteChain;

    const after = await fs.readFile(configPath, 'utf8');
    assert.equal(after, before,
      'missing refresh token must preserve the last complete persisted session');
  });
}

async function testMissingDeviceIdCannotPersistCompleteSession() {
  await withTempDir('dc-session-no-id-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const device = makeDevice(configPath, true);
    device.deviceId = undefined;

    await device.queuePersistedSession({
      access_token: 'access',
      refresh_token: 'refresh',
    });
    await device.configWriteChain;

    await assert.rejects(fs.access(configPath),
      'complete tokens without a device id must not be persisted');
  });
}
async function testCurrentSessionMissingPreservesExistingCredentials() {
  await withTempDir('dc-session-current-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const device = makeDevice(configPath, true);
    await device.queuePersistedSession({
      access_token: 'good-access',
      refresh_token: 'good-refresh',
    });
    const before = await fs.readFile(configPath, 'utf8');
    device.remoteChannel = {
      async getSession() { return { data: { session: null }, error: null }; },
    };

    await device.savePersistedConfig();
    const after = await fs.readFile(configPath, 'utf8');
    assert.equal(after, before,
      'missing current session must not erase valid persisted credentials');
  });
}

async function testIncompleteFirstSessionStillPersistsDeviceIdentity() {
  await withTempDir('dc-session-identity-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const device = makeDevice(configPath, true);
    device.remoteChannel = {
      async getSession() {
        return { data: { session: { access_token: 'access-only', refresh_token: null } } };
      },
    };

    await device.savePersistedConfig();
    const config = await readConfig(configPath);
    assert.equal(config.deviceId, 'device-1');
    assert.equal(config.session, null,
      'an incomplete first session must not persist unusable credentials');
  });
}

async function testPersistenceOptOutSavesIdentityOnlyAndIgnoresRotations() {
  await withTempDir('dc-session-optout-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const device = makeDevice(configPath, false);
    let observer = 'unset';
    device.remoteChannel = {
      onSessionRotated(fn) { observer = fn; },
      async getSession() {
        return { data: { session: { access_token: 'access', refresh_token: 'refresh' } } };
      },
    };

    device.enableSessionPersistence();
    assert.equal(observer, 'unset');
    await device.savePersistedConfig();
    const config = await readConfig(configPath);
    assert.equal(config.deviceId, 'device-1');
    assert.equal(config.session, null);

    await device.queuePersistedSession({ access_token: 'new-access', refresh_token: 'new-refresh' });
    const after = await readConfig(configPath);
    assert.equal(after.session, null, 'opt-out must ignore token rotations');
  });
}

async function testQueuedWriteFailureIsObservable() {
  const device = makeDevice('unused', true);
  const synthetic = Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' });
  device.writePersistedConfigSnapshot = async () => { throw synthetic; };

  await assert.rejects(
    device.queuePersistedConfig({
      deviceId: 'device-1',
      session: { access_token: 'access', refresh_token: 'refresh' },
    }),
    /synthetic EPERM/,
  );
  await device.configWriteChain;
}

async function testStartupValidatesRestoredDeviceBeforeArmingPersistence() {
  const events = [];
  const device = makeDevice('unused', true);
  device.baseServerUrl = 'https://example.invalid';
  device.deviceId = 'device-1';
  device.desktop = {
    async initialize() { events.push('desktop-init'); },
    onDisconnect() {},
    async listClientTools() { return []; },
  };
  device.remoteChannel = {
    user: { email: 'test@example.com' },
    initialize() { events.push('channel-init'); },
    async setSession() { events.push('set-session'); return { error: null }; },
    async registerDevice() { events.push('register'); },
    startHeartbeat() { events.push('heartbeat'); },
  };
  device.fetchSupabaseConfig = async () => ({ supabaseUrl: 'u', anonKey: 'k' });
  device.loadPersistedConfig = async () => {
    events.push('load');
    return { access_token: 'access', refresh_token: 'refresh' };
  };
  device.findPersistedDeviceWithRetry = async () => {
    events.push('validate-restored-device');
    return { id: 'device-1' };
  };
  device.removeStalePersistedConfigTemps = async () => { events.push('cleanup-temps'); };
  device.savePersistedConfig = async () => { events.push('save'); };
  device.enableSessionPersistence = () => { events.push('arm'); };

  await device.start();

  assert.ok(events.indexOf('validate-restored-device') >= 0);
  assert.ok(events.indexOf('cleanup-temps') > events.indexOf('validate-restored-device'),
    'stale token temp cleanup must happen only after restored-device validation');
  assert.ok(events.indexOf('save') > events.indexOf('cleanup-temps'),
    'validated startup temp cleanup must finish before saving credentials');
  assert.ok(events.indexOf('arm') > events.indexOf('save'),
    'rotation persistence must arm only after the validated session is saved');
}

async function testShutdownWaitsRefreshThenDrainsBeforeDisarmingObserver() {
  const events = [];
  const device = makeDevice('unused', true);
  device.isShuttingDown = false;
  device.sessionPersistenceEnabled = true;
  device.remoteChannel = {
    onSessionRotated(fn) { events.push(fn === null ? 'disarm' : 'arm'); },
    stopHeartbeat() { events.push('stop-heartbeat'); },
    async waitForTokenRefresh() { events.push('wait-refresh'); return true; },
    async unsubscribe() { events.push('unsubscribe'); },
    async setOffline() { events.push('offline'); },
  };
  device.desktop = { async shutdown() { events.push('desktop-shutdown'); } };
  device.flushPersistedConfigWrites = async () => { events.push('flush'); return true; };

  await device.shutdown();

  assert.ok(events.indexOf('stop-heartbeat') >= 0);
  assert.ok(events.indexOf('wait-refresh') > events.indexOf('stop-heartbeat'),
    'already-running refresh must be awaited only after future ticks are stopped');
  assert.ok(events.indexOf('flush') > events.indexOf('wait-refresh'),
    'persistence drain must include writes enqueued by the settled refresh');
  assert.ok(events.indexOf('disarm') > events.indexOf('flush'),
    'observer must remain armed until the in-flight refresh and its write are drained');
}

async function testStaleTempIsCleanedBeforePersistenceArms() {
  await withTempDir('dc-session-temp-', async (dir) => {
    const configPath = path.join(dir, 'device.json');
    const stale = `${configPath}.tmp-2147483647`;
    await fs.writeFile(stale, '{"refresh_token":"synthetic"}', 'utf8');
    const device = makeDevice(configPath, true);

    await device.removeStalePersistedConfigTemps();
    await assert.rejects(fs.access(stale));
  });
}

async function testShutdownDrainIsBounded() {
  const device = makeDevice('unused', true);
  device.configWriteChain = new Promise(() => {});
  const start = performance.now();
  const drained = await device.flushPersistedConfigWrites(30);
  const elapsed = performance.now() - start;
  assert.equal(drained, false, 'a timed-out drain must be observable by its caller');
  assert.ok(elapsed >= 20 && elapsed < 1000,
    `bounded drain should return near its timeout, got ${elapsed.toFixed(1)}ms`);
}

async function testDrainDeadlineIgnoresWallClockJump() {
  const device = makeDevice('unused', true);
  device.configWriteChain = new Promise(() => {});
  const realDateNow = Date.now;
  let calls = 0;
  Date.now = () => realDateNow() + (calls++ === 0 ? 0 : 10 * 60 * 1000);
  try {
    const start = performance.now();
    const drained = await device.flushPersistedConfigWrites(30);
    const elapsed = performance.now() - start;
    assert.equal(drained, false);
    assert.ok(elapsed >= 20 && elapsed < 1000,
      `wall-clock jump must not short-circuit monotonic drain deadline, got ${elapsed.toFixed(1)}ms`);
  } finally {
    Date.now = realDateNow;
  }
}

const tests = [
  testRemoteChannelObserverUsesExactRotatedSnapshot,
  testRefreshWithoutFreshRefreshTokenDoesNotPersistFallback,
  testRemoteChannelTracksAndWaitsForInFlightRefresh,
  testRefreshFailureClearsInFlightTrackerAndAllowsRetry,
  testInFlightRefreshPersistsBeforeShutdownDisarmsObserver,
  testDeviceObserverPersistsLatestRotationAtomically,
  testIncompleteRotationCannotOverwriteValidCredentials,
  testMissingDeviceIdCannotPersistCompleteSession,
  testCurrentSessionMissingPreservesExistingCredentials,
  testIncompleteFirstSessionStillPersistsDeviceIdentity,
  testPersistenceOptOutSavesIdentityOnlyAndIgnoresRotations,
  testQueuedWriteFailureIsObservable,
  testStartupValidatesRestoredDeviceBeforeArmingPersistence,
  testShutdownWaitsRefreshThenDrainsBeforeDisarmingObserver,
  testStaleTempIsCleanedBeforePersistenceArms,
  testShutdownDrainIsBounded,
  testDrainDeadlineIgnoresWallClockJump,
];

let failures = 0;
for (const test of tests) {
  try {
    await test();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${test.name}`);
    console.error(error);
  }
}

if (failures) process.exit(1);
console.log(`PASS ${tests.length}/${tests.length} remote session persistence tests`);
