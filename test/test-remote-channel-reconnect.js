/**
 * Regression test: the device Realtime channel must recover after its underlying
 * WebSocket goes half-open.
 *
 * A half-open socket still reports `conn.readyState` OPEN but the peer is gone
 * (e.g. after idle / network loss / sleep), so joins sent over it never get a reply
 * and time out. The channel must detect this and re-establish a working subscription
 * rather than retrying on the dead socket indefinitely.
 *
 * The fake SupabaseClient below models the realtime-js semantics this depends on:
 *   - the socket can be half-open: `conn.readyState` stays 1 but joins TIME_OUT
 *   - `removeChannel()` removes from the registry on a microtask (deferred), and
 *     only tears the socket down once the registry is empty
 *   - `realtime.disconnect()` rebuilds a healthy socket
 *
 * Three cases:
 *   - control: when the dead socket is torn down before recreate, it recovers —
 *     proves the harness can actually observe recovery.
 *   - recovery: driving the health-check / recreate path after the socket goes
 *     half-open must end in a working subscription.
 *   - joining is treated as healthy (no recreate).
 *
 * Runs as part of `npm test` (needs `npm run build` first, which `npm test` does),
 * or standalone: `node test/test-remote-channel-reconnect.js`.
 */
import assert from 'node:assert';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

// Keep telemetry from touching the network during the test.
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

// ---------------------------------------------------------------------------
// Fakes that model realtime-js socket/channel semantics relevant to reconnection
// ---------------------------------------------------------------------------

class FakeChannel {
  state = 'joining';
  joinedOnce = false;
  rejoinTimer = { tries: 0 };
  constructor(topic, client) {
    this.topic = topic;
    this.client = client;
  }
  on() {
    return this;
  }
  subscribe(cb) {
    this.joinedOnce = true;
    // realtime invokes the subscribe callback asynchronously
    Promise.resolve().then(() => {
      if (this.client.realtime.socketDead) {
        this.state = 'errored';
        this.client.statusLog.push('TIMED_OUT');
        cb('TIMED_OUT');
      } else {
        this.state = 'joined';
        this.client.statusLog.push('SUBSCRIBED');
        cb('SUBSCRIBED');
      }
    });
    return this;
  }
  unsubscribe() {
    this.state = 'leaving';
    return Promise.resolve({ error: null });
  }
}

class FakeRealtime {
  conn = { readyState: 1 }; // 1 = OPEN; stays OPEN even when half-open/dead
  socketDead = false; // true = half-open: reads OPEN but joins TIME_OUT
  reconnectTimer = { tries: 0 };
  pendingHeartbeatRef = null;
  _heartbeatSentAt = null;
  _manuallySetToken = true;
  accessTokenValue = null;
  rebuilds = 0;

  connectionState() {
    return this.conn.readyState === 1 ? 'open' : 'closed';
  }
  isConnected() {
    return this.conn.readyState === 1;
  }
  /** Build a fresh, healthy socket (what a real disconnect()+reconnect yields). */
  rebuildSocket() {
    this.rebuilds++;
    this.conn = { readyState: 1 };
    this.socketDead = false;
  }
  /** The fix calls this to force a fresh WebSocket before re-subscribing. */
  disconnect() {
    this.rebuildSocket();
    return Promise.resolve();
  }
}

class FakeClient {
  realtime = new FakeRealtime();
  channels = [];
  statusLog = [];

  channel(topic) {
    const ch = new FakeChannel(topic, this);
    this.channels.push(ch);
    return ch;
  }

  /**
   * Mirrors realtime-js: removal is DEFERRED (await unsubscribe) and the socket
   * is only torn down once the registry is empty. The deferral is what races
   * with the synchronous new-channel push in recreateChannel().
   */
  removeChannel(ch) {
    return Promise.resolve().then(() => {
      const i = this.channels.indexOf(ch);
      if (i !== -1) this.channels.splice(i, 1);
      ch.state = 'closed';
      if (this.channels.length === 0) this.realtime.rebuildSocket();
    });
  }

  removeAllChannels() {
    return Promise.resolve().then(() => {
      this.channels.length = 0;
      this.realtime.rebuildSocket();
    });
  }

  // setOnlineStatus(): from('mcp_devices').update({...}).eq('id', deviceId)
  from() {
    const result = Promise.resolve({ error: null });
    const chain = {
      update: () => chain,
      insert: () => chain,
      delete: () => chain,
      select: () => chain,
      eq: () => result,
    };
    return chain;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeRemoteChannel() {
  const rc = new RemoteChannel();
  const client = new FakeClient();
  rc.client = client; // private at TS level; plain property at runtime
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.onToolCall = () => {};
  rc.deviceId = 'device-1';
  return { rc, client };
}

/** Bring the channel up healthy, then knock the socket into a half-open state. */
async function goHalfOpen(rc, client) {
  await rc.createChannel(); // healthy subscribe -> 'joined'
  assert.strictEqual(rc.channel.state, 'joined', 'precondition: channel should be joined');
  client.realtime.socketDead = true; // dead peer, but readyState stays 1 (OPEN)
  rc.channel.state = 'errored'; // realtime-js flips the channel to errored on a dead socket
  rc.lastChannelState = 'errored';
}

/** Simulate the periodic 10s health checks driving recreate, up to N times. */
async function driveHealthChecks(rc, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    if (rc.channel && rc.channel.state === 'joined') return true;
    rc.checkConnectionHealth(); // -> recreateChannel() when unhealthy
    await flush(); // let deferred removeChannel + subscribe callback run
    await flush();
  }
  return !!(rc.channel && rc.channel.state === 'joined');
}

/**
 * Model the WEDGE (open bug 2026-06-27): bring the channel up healthy, then make the
 * socket half-open (readyState stays OPEN) AND leave the channel parked in 'joining' —
 * which is what realtime-js does when it keeps re-attempting a join over a dead socket
 * it never tears down. This is distinct from the 'errored' path the guard already
 * handles: here the channel is stuck in a state the health-check treats as healthy.
 */
async function goHalfOpenStuckJoining(rc, client) {
  await rc.createChannel(); // healthy subscribe -> 'joined'
  assert.strictEqual(rc.channel.state, 'joined', 'precondition: channel should be joined');
  client.realtime.socketDead = true; // dead peer, but readyState stays 1 (OPEN)
  rc.channel.state = 'joining';      // realtime-js parks it rejoining on the dead socket
  rc.lastChannelState = 'joining';
}

/**
 * Drive the 10s health-check while the channel is stuck 'joining' on a half-open socket.
 * Advances a SIMULATED clock 10s per tick (the real health-check interval) so a
 * time-bounded guard can observe how long the channel has overstayed 'joining' without
 * the test burning real wall-clock. Returns whether the channel recovered.
 */
async function driveHealthChecksStuckJoining(rc, maxTicks) {
  const realNow = Date.now;
  let simulated = realNow();
  Date.now = () => simulated;
  try {
    for (let i = 0; i < maxTicks; i++) {
      if (rc.channel && rc.channel.state === 'joined') return true;
      rc.checkConnectionHealth(); // -> must eventually recreate once 'joining' overstays
      await flush();
      await flush();
      simulated += 10_000; // advance one 10s health-check interval
    }
  } finally {
    Date.now = realNow;
  }
  return !!(rc.channel && rc.channel.state === 'joined');
}

// Silence the (intentionally verbose) diagnostic logging during the drive so
// the test output stays readable; we summarise via the fake's statusLog instead.
// Must await so console is restored only after the async callbacks have fired.
async function withQuietLogs(fn) {
  const { debug, log, warn, error } = console;
  console.debug = () => {};
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
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
    await fn();
    console.log(`✅ PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(`🔴 FAIL  ${name}\n   ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function goHalfOpenThenDrive(rc, client) {
  await goHalfOpen(rc, client);
  return driveHealthChecks(rc, 8);
}

async function main() {
  // CONTROL: prove the harness CAN observe recovery — when the dead socket is
  // actually torn down (disconnect()), the next recreate re-subscribes.
  await test('control: recovers when the half-open socket is torn down before recreate', async () => {
    const { rc, client } = makeRemoteChannel();
    await withQuietLogs(async () => {
      await goHalfOpen(rc, client);
      client.realtime.disconnect(); // simulate the fix: force a fresh socket
      const recovered = await driveHealthChecks(rc, 6);
      assert.strictEqual(recovered, true, 'expected recovery after socket teardown');
    });
    assert.strictEqual(client.realtime.socketDead, false);
  });

  // After the socket goes half-open, driving the health-check / recreate path must
  // end in a re-established subscription rather than retrying on the dead socket.
  await test('channel recovers after the socket goes half-open', async () => {
    const { rc, client } = makeRemoteChannel();
    const recovered = await withQuietLogs(async () => goHalfOpenThenDrive(rc, client));

    const reusedSocket = client.realtime.rebuilds === 0;
    const readyState = client.realtime.conn.readyState;
    assert.strictEqual(
      recovered,
      true,
      `channel did not recover after the socket went half-open.\n` +
        `     attempts(recreate)=${rc.reconnectAttempt} statuses=[${client.statusLog.join(', ')}]\n` +
        `     socketReadyState=${readyState} reused=${reusedSocket} rebuilds=${client.realtime.rebuilds}`
    );
  });

  // 'joining' is transitional — the health check must treat it as healthy and NOT
  // tear the channel down mid-join (otherwise it amputates realtime-js's own rejoin).
  await test('joining is treated as healthy (no recreate)', async () => {
    const { rc, client } = makeRemoteChannel();
    await withQuietLogs(async () => {
      await rc.createChannel(); // -> joined
      const attemptsBefore = rc.reconnectAttempt;
      const rebuildsBefore = client.realtime.rebuilds;
      rc.channel.state = 'joining'; // transitional, not yet joined
      rc.checkConnectionHealth();
      await flush();
      await flush();
      assert.strictEqual(rc.reconnectAttempt, attemptsBefore, 'joining must not trigger a recreate');
      assert.strictEqual(client.realtime.rebuilds, rebuildsBefore, 'joining must not rebuild the socket');
    });
  });

  // REGRESSION REPRO (open bug 2026-06-27): a half-open socket can leave the channel
  // parked in 'joining' instead of 'errored'. The previous test proves single-tick
  // 'joining' must NOT recreate; THIS test proves 'joining' must not be healthy
  // *forever* — if it overstays while the socket reads OPEN(1) (the half-open tell),
  // the guard must force a recreate (the same path that recovers the 'errored' case),
  // or the device wedges offline until restart. EXPECTED TO FAIL until the
  // time-bounded-'joining' fix lands in checkConnectionHealth().
  await test('recovers when a half-open socket leaves the channel stuck in joining', async () => {
    const { rc, client } = makeRemoteChannel();
    const recovered = await withQuietLogs(async () => {
      await goHalfOpenStuckJoining(rc, client);
      return driveHealthChecksStuckJoining(rc, 8); // ~80s simulated; a 30s bound fires by tick ~4
    });
    assert.strictEqual(
      recovered,
      true,
      `channel wedged in 'joining' on a half-open socket and never recovered.\n` +
        `     attempts(recreate)=${rc.reconnectAttempt} rebuilds=${client.realtime.rebuilds}\n` +
        `     channelState=${rc.channel && rc.channel.state} socketReadyState=${client.realtime.conn.readyState}`
    );
  });

  console.log(
    `\n${failures ? '🔴' : '✅'} remote-channel reconnect: ${failures} failing test(s).`
  );
  process.exit(failures ? 1 : 0);
}

main();
