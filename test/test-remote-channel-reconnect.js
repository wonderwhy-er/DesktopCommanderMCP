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
import { RemoteChannel, observeServerDate } from '../dist/remote-device/remote-channel.js';

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
  // Presence (added with the Broadcast/Presence transport): the device track()s
  // itself on SUBSCRIBED and untrack()s on a graceful unsubscribe. realtime-js
  // RESOLVES these with a status string ('ok' | 'error' | 'timed out') rather
  // than rejecting, so the fakes mirror that contract.
  track() {
    this.tracked = true;
    return Promise.resolve('ok');
  }
  untrack() {
    this.tracked = false;
    return Promise.resolve('ok');
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

  onHeartbeat(cb) {
    this._heartbeatCb = cb;
  }

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
  /** setSession()/the TOKEN_REFRESHED handler both call this to re-authorize
   * the socket with the current access token. */
  setAuth(token) {
    this.accessTokenValue = token;
  }
}

// Real, unskewed Date.now — captured at module load, before any test installs
// a Date.now mock to simulate a skewed DEVICE clock. Used only to build
// SERVER-side JWTs below: a real auth server's own clock is never the skewed
// one, only the device reading its response is, so every token FakeAuth
// "issues" must carry a genuinely true `iat`/`exp`, exactly like production.
const trueNow = Date.now;

/** Minimal base64url JWT encoder — no signature needed, FakeAuth just decodes
 * the payload segment back out. */
function makeJWT(payload) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** A fresh, genuinely-valid token exactly as the SERVER would issue it: iat/exp
 * from TRUE time, never the (possibly mocked/skewed) Date.now() the code under
 * test sees. `n` disambiguates successive refreshes for debugging. */
function freshServerToken(n = 0) {
  const iat = Math.floor(trueNow() / 1000);
  return makeJWT({ iat, exp: iat + 3600, sub: 'user-1', n });
}

/**
 * Models the subset of supabase-js's `client.auth` that remote-channel.ts
 * actually calls: setSession()/getUser()/getSession()/onAuthStateChange()
 * from RemoteChannel.setSession(), and refreshSession() for the manual-refresh
 * fix under test (see the clock-skew regression tests below).
 *
 * setSession() and getSession() mirror auth-js's OWN expiry decisions
 * (GoTrueClient.js's _setSession() and __loadSession(), confirmed by direct
 * source read) — both compare a token's claimed expiry against Date.now(),
 * NEITHER gated by autoRefreshToken. That's the exact gap autoRefreshToken:
 * false does not close, and the exact gap the clock-skew regression tests
 * below need a faithful model of to prove closed — round 1's version of this
 * fake didn't model either check, which is exactly how its test missed the
 * gap. The internal autoRefreshToken ticker itself is deliberately still NOT
 * modeled: it's disabled by the fix and orthogonal to what these two checks
 * cover (confirmed by direct source read of _autoRefreshTokenTick()).
 */
class FakeAuth {
  static EXPIRY_MARGIN_MS = 90 * 1000; // @supabase/auth-js's real EXPIRY_MARGIN_MS

  session = null;
  refreshCalls = 0;
  listeners = [];

  /** Mirrors GoTrueClient.js's _setSession() (~L1363): decides "expired" from
   * the PASSED TOKEN's own `exp` claim vs Date.now(), regardless of
   * autoRefreshToken, refreshing internally when so. */
  async setSession({ access_token, refresh_token }) {
    const { exp } = decodeJwtPayload(access_token);
    const timeNow = Date.now() / 1000;
    if (exp && exp <= timeNow) {
      return this._refresh(refresh_token);
    }
    this.session = { access_token, refresh_token, expires_at: exp };
    return { error: null };
  }
  async getUser() {
    return { data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null };
  }
  /** Mirrors GoTrueClient.js's __loadSession() (~L1201), invoked by EVERY
   * getSession() call — and so, via supabase-js's fetchWithAuth ->
   * _getAccessToken(), by every outgoing REST request. NOT gated by
   * autoRefreshToken (confirmed by direct source read) — this is the gap
   * round 1's autoRefreshToken:false missed. */
  async getSession() {
    if (this.session) {
      const hasExpired = this.session.expires_at * 1000 - Date.now() < FakeAuth.EXPIRY_MARGIN_MS;
      if (hasExpired) await this._refresh(this.session.refresh_token);
    }
    return { data: { session: this.session }, error: null };
  }
  onAuthStateChange(cb) {
    this.listeners.push(cb);
    return { data: { subscription: { unsubscribe() {} } } };
  }
  /** What the fix's fixed-cadence timer calls directly. */
  async refreshSession() {
    return this._refresh(this.session?.refresh_token ?? 'rt-0');
  }
  /**
   * Shared by every internal (setSession/getSession) and external
   * (refreshSession) refresh trigger. Mirrors real auth-js's
   * _callRefreshToken(), which notifies 'TOKEN_REFRESHED' subscribers
   * unconditionally (verified by direct source read) — that's what keeps
   * setSession()'s realtime.setAuth() re-authorization working regardless of
   * what triggered the refresh. Always issues a token with TRUE-time
   * iat/exp: a real server's clock is never the skewed one.
   */
  async _refresh(refreshToken) {
    this.refreshCalls++;
    const token = freshServerToken(this.refreshCalls);
    const { exp } = decodeJwtPayload(token);
    this.session = { access_token: token, refresh_token: refreshToken, expires_at: exp };
    for (const cb of this.listeners) cb('TOKEN_REFRESHED', this.session);
    return { data: { session: this.session }, error: null };
  }
}

class FakeClient {
  realtime = new FakeRealtime();
  auth = new FakeAuth();
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
  rc.deviceName = 'test-device';
  // recreateChannel() sleeps a jittered backoff before rebuilding so a fleet-wide
  // event doesn't stampede reconnects. These tests are about WHETHER the wedge
  // recovers, not how long it waits — stub the sleep so the suite stays
  // sub-second, but record the requested delays so the formula can be asserted
  // (see "reconnect backoff grows and stays bounded" below).
  rc.sleptMs = [];
  rc.sleep = (ms) => {
    rc.sleptMs.push(ms);
    return Promise.resolve();
  };
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
 * Advances a SIMULATED monotonic clock (performance.now — what the liveness guards
 * read) 10s per tick (the real health-check interval) so a time-bounded guard can
 * observe how long the channel has overstayed 'joining' without the test burning
 * real wall-clock. Returns whether the channel recovered.
 */
async function driveHealthChecksStuckJoining(rc, maxTicks) {
  const realPerfNow = performance.now;
  let simulated = realPerfNow.call(performance);
  performance.now = () => simulated;
  try {
    for (let i = 0; i < maxTicks; i++) {
      if (rc.channel && rc.channel.state === 'joined') return true;
      rc.checkConnectionHealth(); // -> must eventually recreate once 'joining' overstays
      await flush();
      await flush();
      simulated += 10_000; // advance one 10s health-check interval
    }
  } finally {
    performance.now = realPerfNow;
  }
  return !!(rc.channel && rc.channel.state === 'joined');
}

/**
 * The gap neither of the above cover: a half-open socket where realtime-js's own
 * heartbeat-timeout-then-close never completes (the close handshake waits on a
 * peer ack that never comes), so `channel.state` stays 'joined' forever — never
 * 'joining', never 'errored'. Nothing about this shape was previously visible to
 * checkConnectionHealth(), which short-circuits as healthy on 'joined'.
 */
async function goHalfOpenStuckJoined(rc, client) {
  await rc.createChannel(); // healthy subscribe -> 'joined', lastHeartbeatOkAt set
  assert.strictEqual(rc.channel.state, 'joined', 'precondition: channel should be joined');
  client.realtime.socketDead = true; // dead peer; channel.state is never told
}

/**
 * Drive the 10s health-check while state stays 'joined' throughout, advancing a
 * simulated monotonic clock (performance.now — what the liveness guards read)
 * past HEARTBEAT_STALE_TIMEOUT_MS (75s) without real delay. channel.state can't
 * signal recovery here (it never left 'joined'), so recovery is judged by
 * whether a fresh socket actually got forced.
 *
 * Regression guard baked in: Date.now() is pinned hours BACKWARD for the whole
 * drive — the clock-skew correction can move Date.now by exactly such an offset
 * mid-run, and staleness detection must not care (it reads performance.now).
 * Against a Date.now-based implementation this skew makes staleMs negative and
 * the recovery below never fires.
 */
async function driveHealthChecksStuckJoined(rc, client, maxTicks) {
  const realPerfNow = performance.now;
  const realDateNow = Date.now;
  let simulated = realPerfNow.call(performance);
  performance.now = () => simulated;
  Date.now = () => realDateNow() - 6 * 3600_000;
  try {
    for (let i = 0; i < maxTicks; i++) {
      if (client.realtime.rebuilds > 0) return true;
      rc.checkConnectionHealth();
      await flush();
      await flush();
      simulated += 10_000;
    }
  } finally {
    performance.now = realPerfNow;
    Date.now = realDateNow;
  }
  return client.realtime.rebuilds > 0;
}

/**
 * Intercept the real global setInterval/clearInterval so a test can (a) prove
 * startHeartbeat() actually arms a timer at a given fixed cadence rather than
 * something short/clock-driven, and (b) drive that timer by invoking the
 * captured callback directly instead of waiting on real wall-clock time (the
 * token-refresh cadence under test is 45 real minutes). Scoped to a single
 * `fn` call and always restored, mirroring the Date.now() overrides above.
 */
async function withMockedIntervals(fn) {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const registered = []; // { id, ms, cb, cleared }
  let nextId = 1;
  global.setInterval = (cb, ms) => {
    const id = nextId++;
    registered.push({ id, ms, cb, cleared: false });
    return id;
  };
  global.clearInterval = (id) => {
    const entry = registered.find((r) => r.id === id);
    if (entry) entry.cleared = true;
  };
  try {
    return await fn(registered);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
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

  // REGRESSION REPRO: a half-open socket where channel.state never leaves
  // 'joined' at all — the shape the 'joining'-wedge fix above doesn't cover,
  // since it never sees anything but 'joined'. Recovery here depends entirely
  // on the heartbeat-staleness check.
  await test('recovers when a half-open socket leaves the channel stuck at joined', async () => {
    const { rc, client } = makeRemoteChannel();
    const recovered = await withQuietLogs(async () => {
      await goHalfOpenStuckJoined(rc, client);
      return driveHealthChecksStuckJoined(rc, client, 10); // 100s simulated; 75s bound fires by tick ~8
    });
    assert.strictEqual(
      recovered,
      true,
      `channel wedged at 'joined' on a half-open socket and never recovered.\n` +
        `     attempts(recreate)=${rc.reconnectAttempt} rebuilds=${client.realtime.rebuilds}\n` +
        `     channelState=${rc.channel && rc.channel.state} socketReadyState=${client.realtime.conn.readyState}`
    );
  });

  // The fixed-cadence refresh timer (defense-in-depth alongside
  // observeServerDate) must stay capped to one refreshSession() call per tick
  // even under sustained clock skew, keep the realtime socket re-authorized,
  // and tear down cleanly on shutdown.
  await test('token refresh runs on a fixed cadence under simulated clock skew, and stops cleanly on shutdown', async () => {
    const { rc, client } = makeRemoteChannel();
    await withQuietLogs(async () => {
      await withMockedIntervals(async (registered) => {
        const realNow = Date.now;
        const SKEW_MS = 3 * 60 * 60 * 1000; // 3h fast, matches the confirmed prod device
        Date.now = () => realNow() + SKEW_MS;
        try {
          await rc.setSession({ access_token: freshServerToken(), refresh_token: 'seed-refresh' });
          // setSession() itself can cost 1-2 refreshes under this much skew
          // (its own internal _setSession() check, then the immediate
          // getSession() call remote-channel.ts makes right after) — a
          // bounded, one-time bootstrap cost, not what this test is about.
          const afterSetSession = client.auth.refreshCalls;

          rc.startHeartbeat('device-1');

          const tokenTimer = registered.find((r) => r.ms === 45 * 60 * 1000); // TOKEN_REFRESH_INTERVAL_MS
          assert.ok(
            tokenTimer,
            `expected startHeartbeat() to arm a fixed 45-minute refresh timer; registered intervals=${JSON.stringify(
              registered.map((r) => r.ms)
            )}`
          );

          // Fire it repeatedly, simulating hours of continued operation under
          // the skewed clock. Capped-by-design: exactly one refreshSession()
          // call per timer tick, never more — unlike the old ticker, which
          // under this same skew would re-fire on every ~30s AUTO_REFRESH_TICK
          // because it always finds the (skewed-relative) token "expired".
          for (let i = 1; i <= 6; i++) {
            tokenTimer.cb();
            await flush();
            await flush();
            assert.strictEqual(
              client.auth.refreshCalls,
              afterSetSession + i,
              `expected exactly ${i} refreshSession() call(s) after ${i} tick(s) on top of the ${afterSetSession} ` +
              `bootstrap refresh(es), got ${client.auth.refreshCalls} total — refresh must stay capped to one per ` +
              `fixed-interval tick, not fire unbounded`
            );
          }

          // setSession()'s TOKEN_REFRESHED handler must still re-authorize the
          // realtime socket, regardless of what triggered the refresh.
          assert.strictEqual(
            client.realtime.accessTokenValue,
            client.auth.session.access_token,
            'TOKEN_REFRESHED handler must still re-authorize the realtime socket when refresh is driven by our own timer'
          );

          rc.stopHeartbeat();
          assert.strictEqual(
            tokenTimer.cleared,
            true,
            'stopHeartbeat() must clear the token-refresh timer — a leaked timer would keep the process alive past shutdown'
          );
        } finally {
          Date.now = realNow;
        }
      });
    });
  });

  // observeServerDate reads the `Date` header every Supabase response carries
  // (the server's real clock) instead of inferring skew from a token — see
  // remote-channel.ts. A big disagreement must correct Date.now; a small one
  // must not touch it; and a resolved skew must restore the original.
  await test('observeServerDate corrects Date.now when the server disagrees by a lot', async () => {
    await withQuietLogs(async () => {
      const trueNow = Date.now;
      try {
        const serverDate = new Date(trueNow() - 3 * 60 * 60 * 1000).toUTCString(); // server 3h behind
        observeServerDate(serverDate);
        assert.notStrictEqual(Date.now, trueNow, 'expected Date.now to be patched');
        assert.ok(
          Math.abs(Date.now() - Date.parse(serverDate)) < 2000,
          `expected corrected Date.now() to track the server's stated time, off by ${Date.now() - Date.parse(serverDate)}ms`
        );
      } finally {
        observeServerDate(new Date().toUTCString()); // resolve skew -> restores Date.now
      }
    });
  });

  await test('observeServerDate leaves Date.now untouched for ordinary clock drift', () => {
    const trueNow = Date.now;
    observeServerDate(new Date(trueNow() + 30_000).toUTCString()); // 30s, well under the 5min threshold
    assert.strictEqual(Date.now, trueNow, 'a small disagreement must not patch Date.now');
  });

  await test('observeServerDate restores Date.now once skew resolves', async () => {
    await withQuietLogs(async () => {
      const trueNow = Date.now;
      observeServerDate(new Date(trueNow() - 3 * 60 * 60 * 1000).toUTCString());
      assert.notStrictEqual(Date.now, trueNow, 'precondition: should be patched');
      observeServerDate(new Date().toUTCString());
      assert.strictEqual(Date.now, trueNow, 'expected Date.now restored once the server agrees again');
    });
  });

  await test('observeServerDate ignores a missing or malformed Date header', () => {
    const trueNow = Date.now;
    observeServerDate(null);
    observeServerDate('not a date');
    assert.strictEqual(Date.now, trueNow, 'must not patch Date.now on unusable input');
  });

  // The jittered backoff exists so a fleet-wide event (server deploy, Supabase
  // blip) doesn't stampede every device into reconnecting at the same instant.
  // Assert the shape rather than exact values: it must GROW with consecutive
  // attempts and stay BOUNDED so a device can't disappear for minutes.
  await test('reconnect backoff grows with attempts and stays bounded', async () => {
    const { rc, client } = makeRemoteChannel();
    await withQuietLogs(async () => {
      await goHalfOpen(rc, client);
      // Model a PERSISTENT outage: rebuilding the socket doesn't help, so every
      // recreate fails and reconnectAttempt actually climbs. The default fake
      // heals on rebuildSocket(), which meant every recreate SUCCEEDED, the
      // counter reset to 0, and all samples came from the attempt-1
      // distribution — making a "grows" assertion a coin flip (~10% flake,
      // measured over 30 runs) and never exercising the cap at all.
      client.realtime.rebuildSocket = function () {
        this.rebuilds++;
        this.conn = { readyState: 1 };
        this.socketDead = true; // still dead after the rebuild
      };
      client.realtime.socketDead = true;
      for (let i = 0; i < 7; i++) {
        await rc.recreateChannel();
        if (rc.channel) rc.channel.state = 'errored';
      }
    });

    assert.ok(rc.sleptMs.length >= 6, `expected several backoff sleeps, got ${rc.sleptMs.length}`);
    // Formula: min(30_000, 1000 * 2**min(attempt,5)) * (0.5 + random())
    // -> hard ceiling is 30_000 * 1.5 = 45_000 ms.
    assert.ok(
      rc.sleptMs.every((ms) => ms > 0 && ms <= 45_000),
      `every backoff must be positive and <= 45s: ${JSON.stringify(rc.sleptMs)}`
    );
    // With the counter climbing, late attempts draw from a strictly higher
    // range than the first: attempt 1 tops out at 3_000, attempt 5+ starts at
    // 15_000 — so this cannot flake on jitter.
    assert.ok(
      rc.sleptMs[0] <= 3_000,
      `first backoff should be the attempt-1 range: ${rc.sleptMs[0]}`
    );
    assert.ok(
      Math.max(...rc.sleptMs.slice(-2)) >= 15_000,
      `late backoffs should reach the capped range: ${JSON.stringify(rc.sleptMs)}`
    );
  });

  console.log(
    `\n${failures ? '🔴' : '✅'} remote-channel reconnect: ${failures} failing test(s).`
  );
  process.exit(failures ? 1 : 0);
}

main();
