/**
 * Presence is best effort: it feeds the dashboard's online dot and nothing else.
 *
 * Tool calls are delivered over the joined channel and dispatched from the
 * device row, so a device is connected once the channel is joined and the row
 * says so. A failed track() must not hold that back, take a connected device
 * out of service, or keep ending its channel (2026-10-13: a Presence timeout on
 * Supabase's side ended the whole channel, and every rejoin published again).
 *
 * Runs against fake Supabase objects; no network.
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-presence-best-effort.js
 */
import assert from 'node:assert';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { runIfMain } from './helpers/run-if-main.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeChannel {
  state = 'joining';
  constructor(client) {
    this.client = client;
  }
  on() {
    return this;
  }
  subscribe(cb) {
    // Kept so a case can replay realtime-js's own rejoin on the same object.
    this.subscribeCb = cb;
    Promise.resolve().then(() => {
      this.state = 'joined';
      cb('SUBSCRIBED');
    });
    return this;
  }
  /** realtime-js resolves track() with a status string; it never rejects. */
  track() {
    this.client.onTrack?.(this);
    return Promise.resolve(this.client.trackResult);
  }
  untrack() {
    return Promise.resolve('ok');
  }
  unsubscribe() {
    this.state = 'leaving';
    return Promise.resolve({ error: null });
  }
}

class FakeClient {
  realtime = {
    conn: { readyState: 1 },
    connectionState: () => 'open',
    isConnected: () => true,
    onHeartbeat() { },
    setAuth() { },
    disconnect: () => Promise.resolve(),
  };
  channels = [];
  /** Every row write as it lands: { table, payload }. */
  writes = [];
  trackResult = 'ok';
  /** What Supabase does to the channel while track() is in flight. */
  onTrack = null;
  /** While set, a status write lands only once this promise settles. */
  holdStatusWrite = null;
  /** The 1-based 'online' status write to refuse; 0 refuses none. */
  refuseOnlineAt = 0;
  onlineWrites = 0;

  channel() {
    const ch = new FakeChannel(this);
    this.channels.push(ch);
    return ch;
  }

  removeChannel(ch) {
    this.channels = this.channels.filter((c) => c !== ch);
    ch.state = 'closed';
    return Promise.resolve();
  }

  /** A supabase-js query builder: any chain of calls, awaited once. */
  from(table) {
    const client = this;
    let payload = null;
    const chain = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const hold = payload && 'status' in payload ? client.holdStatusWrite : null;
          const refused = payload?.status === 'online' && ++client.onlineWrites === client.refuseOnlineAt;
          const settled = Promise.resolve(hold).then(() => {
            if (refused) return { data: null, error: { message: 'refused' } };
            if (payload) client.writes.push({ table, payload });
            return { data: [], error: null };
          });
          return settled.then.bind(settled);
        }
        if (prop === 'update') return (p) => { payload = p; return chain; };
        return () => chain;
      },
    });
    return chain;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeRemoteChannel() {
  const rc = new RemoteChannel();
  const client = new FakeClient();
  rc.client = client;
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.onToolCall = () => { };
  rc.deviceId = DEVICE_ID;
  rc.deviceName = 'test-device';
  rc.sleep = () => Promise.resolve();
  return { rc, client };
}

/** Bring the channel up; resolves with whether createChannel() called it ready. */
const join = (rc) => rc.createChannel().then(() => true, () => false);

/** Simulated monotonic clock, so health checks can run for minutes instantly. */
async function withClock(fn) {
  const realPerfNow = performance.now;
  let t = realPerfNow.call(performance);
  performance.now = () => t;
  try {
    return await fn({ advance: (ms) => { t += ms; }, now: () => t });
  } finally {
    performance.now = realPerfNow;
  }
}

/** One 10s health check on a channel whose socket keeps answering heartbeats. */
async function tick(rc, clock) {
  clock.advance(10_000);
  rc.lastHeartbeatOkAt = clock.now();
  rc.checkConnectionHealth();
  await flush();
  await flush();
}

/** Replay a realtime-js status on the same channel object, as its rejoin timer does. */
async function sdkStatus(ch, status, err) {
  ch.state = status === 'SUBSCRIBED' ? 'joined' : 'errored';
  ch.subscribeCb(status, err);
  await flush();
  await flush();
}

/** realtime-js notices the ended channel and rejoins it. */
async function rejoin(ch, clock) {
  await sdkStatus(ch, 'CHANNEL_ERROR', { message: 'unknown' });
  clock.advance(1_000);
  await sdkStatus(ch, 'SUBSCRIBED');
}

const landed = (client, field) =>
  client.writes.filter((w) => w.table === 'mcp_devices' && field in w.payload);
const lastStatus = (client) => landed(client, 'status').at(-1)?.payload.status;

async function withQuietLogs(fn) {
  const { debug, log, warn, error } = console;
  console.debug = () => { };
  console.log = () => { };
  console.warn = () => { };
  console.error = () => { };
  try {
    return await fn();
  } finally {
    console.debug = debug;
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

let failures = 0;
async function test(name, fn) {
  try {
    await withQuietLogs(fn);
    console.log(`✅ PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(`🔴 FAIL  ${name}\n   ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  await test('a joined channel is ready for tool calls even when presence fails', async () => {
    const { rc, client } = makeRemoteChannel();
    client.trackResult = 'timed out';

    const ready = await join(rc);
    await rc.statusWriteChain;

    assert.strictEqual(ready, true,
      'createChannel() rejected because track() failed; the joined channel can deliver tool calls');
    assert.strictEqual(lastStatus(client), 'online',
      `the row says ${lastStatus(client)}, so the server never picks this device`);
  });

  await test('presence failing never takes a connected device out of service', async () => {
    const { rc, client } = makeRemoteChannel();
    await withClock(async (clock) => {
      assert.strictEqual(await join(rc), true, 'precondition: connected with presence working');
      // Supabase drops the channel; from the rejoin on, every track() times out.
      client.trackResult = 'timed out';
      await rejoin(rc.channel, clock);
      for (let i = 0; i < 60; i++) await tick(rc, clock);
    });
    await rc.statusWriteChain;

    assert.strictEqual(rc.channel.state, 'joined', 'precondition: the channel stayed joined');
    assert.strictEqual(lastStatus(client), 'online',
      `the row says ${lastStatus(client)} for a joined device whose only failure is presence`);
  });

  await test('the heartbeat keeps a connected device online while presence fails', async () => {
    const { rc, client } = makeRemoteChannel();
    client.trackResult = 'timed out';
    await join(rc);
    const before = client.writes.length;

    await rc.updateHeartbeat();

    const heartbeats = client.writes.slice(before)
      .filter((w) => 'last_seen' in w.payload && w.payload.status === 'online');
    assert.strictEqual(heartbeats.length, 1,
      'the heartbeat was skipped, so the server sweeps a connected device offline after 15 minutes');
  });

  await test('when presence ends the channel, the rejoined channel stays connected', async () => {
    const { rc, client } = makeRemoteChannel();
    let drops = 0;
    client.trackResult = 'timed out';
    // As on 2026-10-13: the Presence timeout ends the whole channel.
    client.onTrack = (ch) => { ch.state = 'errored'; drops++; };

    await withClock(async (clock) => {
      await join(rc);
      for (let i = 0; i < 12; i++) {      // two minutes of rejoins and health checks
        if (rc.channel.state !== 'joined') await rejoin(rc.channel, clock);
        await tick(rc, clock);
      }
    });
    await rc.statusWriteChain;

    assert.strictEqual(drops, 1,
      `presence ended the channel ${drops} times in two minutes; each drop loses doorbells and reconnects`);
    assert.strictEqual(rc.channel.state, 'joined', 'the rejoined channel did not stay joined');
    assert.strictEqual(lastStatus(client), 'online',
      `the row says ${lastStatus(client)} for a rejoined channel`);
  });

  await test('a reconnect while the online write is still running ends with the row online', async () => {
    const { rc, client } = makeRemoteChannel();
    let release;
    client.holdStatusWrite = new Promise((r) => { release = r; });

    await withClock(async (clock) => {
      const joined = join(rc);
      await flush();
      await flush();
      // The channel drops and comes back before the first 'online' lands.
      await rejoin(rc.channel, clock);
      client.holdStatusWrite = null;
      release();
      await joined;
    });
    await rc.statusWriteChain;

    assert.strictEqual(rc.channel.state, 'joined', 'precondition: the channel rejoined');
    assert.strictEqual(lastStatus(client), 'online',
      `the row says ${lastStatus(client)} for a rejoined channel, so the server sends it no calls`);
  });

  await test('a rejoin whose own online write fails still ends with the row online', async () => {
    const { rc, client } = makeRemoteChannel();
    let release;
    client.holdStatusWrite = new Promise((r) => { release = r; });
    client.refuseOnlineAt = 2; // the rejoin's own 'online'

    await withClock(async (clock) => {
      const joined = join(rc);
      await flush();
      await flush();
      // The channel drops and comes back before the first 'online' lands.
      await rejoin(rc.channel, clock);
      client.holdStatusWrite = null;
      release();
      await joined;
      await rc.statusWriteChain;
      for (let i = 0; i < 12; i++) await tick(rc, clock);   // two minutes of health checks
    });
    await rc.statusWriteChain;

    assert.strictEqual(rc.channel.state, 'joined', 'precondition: the channel rejoined');
    assert.strictEqual(lastStatus(client), 'online',
      `the row says ${lastStatus(client)} for a rejoined channel, so the server sends it no calls`);
  });

  await test('a drop during the join\'s status write leaves the row offline', async () => {
    const { rc, client } = makeRemoteChannel();
    let release;
    client.holdStatusWrite = new Promise((r) => { release = r; });

    const joined = join(rc);
    await flush();
    await flush();
    // The channel drops while the join's 'online' is still in flight.
    await sdkStatus(rc.channel, 'CHANNEL_ERROR', { message: 'unknown' });
    client.holdStatusWrite = null;
    release();
    await joined;
    await rc.statusWriteChain;
    await flush();
    await rc.statusWriteChain;

    assert.strictEqual(lastStatus(client), 'offline',
      `the row says ${lastStatus(client)} for a channel that is down, so the server sends it calls it cannot receive`);
  });

  console.log(`\n${failures ? '🔴' : '✅'} remote presence best effort: ${failures} failing test(s).`);
  return !failures;
}

runIfMain(import.meta.url, main);
