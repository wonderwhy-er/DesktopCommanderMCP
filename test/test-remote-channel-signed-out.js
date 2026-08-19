/**
 * Regression tests for the anon-key downgrade behind ~360k "Unauthorized" rows.
 *
 * Chain: a replayed refresh token gets the whole family revoked -> this connector's
 * refresh 400s -> auth-js removes the session and emits SIGNED_OUT -> supabase-js
 * calls realtime.setAuth() with no argument -> its `?? supabaseKey` fallback pins
 * the socket to the anon key -> every join refused, forever, while the process
 * still looks healthy.
 *
 * Asserts both breaks: the token resolver can never yield the anon key, and
 * SIGNED_OUT ends in one restore attempt then offline instead of a retry loop.
 */
import assert from 'node:assert';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const ANON_KEY = 'sb_publishable_TESTKEY_do_not_use_on_a_socket';
const USER_JWT = 'eyJ-user-jwt';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeRealtime {
  accessToken = null;          // set by createClient / initialize()
  accessTokenValue = null;
  setAuthCalls = [];
  setAuth(token = null) {
    this.setAuthCalls.push(token);
    if (token) this.accessTokenValue = token;
    return Promise.resolve();
  }
  disconnectCalls = 0;
  disconnect() { this.disconnectCalls++; }
}

class FakeAuth {
  listeners = [];
  session = { access_token: USER_JWT, refresh_token: 'rt-1' };
  /** Queue of results for setSession(); each call shifts one. */
  setSessionResults = [];
  setSessionCalls = [];

  onAuthStateChange(cb) {
    this.listeners.push(cb);
    return { data: { subscription: { unsubscribe() {} } } };
  }
  emit(event, session = null) {
    for (const cb of this.listeners) cb(event, session);
  }
  async setSession(payload) {
    this.setSessionCalls.push(payload);
    const next = this.setSessionResults.shift();
    if (next && next.error) {
      this.session = null;
      return { data: { session: null }, error: next.error };
    }
    this.session = { access_token: payload.access_token, refresh_token: payload.refresh_token };
    return { data: { session: this.session }, error: null };
  }
  async getSession() {
    return { data: { session: this.session }, error: null };
  }
  async getUser() {
    return { data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null };
  }
}

class FakeChannel {
  state = 'closed';
  constructor(topic, client) { this.topic = topic; this.client = client; }
  on() { return this; }
  subscribe(cb) { this.state = 'joined'; cb && cb('SUBSCRIBED'); return this; }
  send() { return Promise.resolve('ok'); }
  track() { return Promise.resolve('ok'); }
  untrack() { return Promise.resolve('ok'); }
}

class FakeClient {
  realtime = new FakeRealtime();
  auth = new FakeAuth();
  channels = [];
  channel(topic) {
    const ch = new FakeChannel(topic, this);
    this.channels.push(ch);
    return ch;
  }
  removeChannel(ch) { return Promise.resolve().then(() => { ch.state = 'closed'; }); }
  removeAllChannels() { return Promise.resolve(); }
  from() {
    const result = Promise.resolve({ error: null });
    const chain = { update: () => chain, insert: () => chain, delete: () => chain, select: () => chain, eq: () => result };
    return chain;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeRemoteChannel() {
  const rc = new RemoteChannel();
  const client = new FakeClient();
  rc.client = client;                 // private at TS level, plain property at runtime
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.onToolCall = () => {};
  rc.deviceId = 'device-1';
  rc.deviceName = 'test-device';
  rc.lastKnownSession = { access_token: USER_JWT, refresh_token: 'rt-1' };
  rc.registerAuthListener(); // installs the handler under test
  return { rc, client };
}

/** Register the auth listener the way setSession() does, without the network. */
RemoteChannel.prototype.registerAuthListener = function () {
  if (this.authListenerRegistered) return;
  this.authListenerRegistered = true;
  this.client.auth.onAuthStateChange((event, newSession) => {
    if (event === 'TOKEN_REFRESHED' && newSession?.access_token && this.client) {
      this.client.realtime.setAuth(newSession.access_token);
      this.lastKnownSession = {
        access_token: newSession.access_token,
        refresh_token: newSession.refresh_token ?? this.lastKnownSession?.refresh_token ?? null,
      };
    } else if (event === 'SIGNED_OUT') {
      void this.handleSignedOut();
    }
  });
};

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function withQuietLogs(fn) {
  const { log, error, debug } = console;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  console.debug = () => {};
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    Object.assign(console, { log, error, debug });
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

async function main() {
  // --- The root cause: the realtime socket must never be handed the anon key ---

  await test('initialize() installs a realtime token resolver that never yields the anon key', async () => {
    const rc = new RemoteChannel();
    rc.initialize('https://example.supabase.co', ANON_KEY);
    const resolver = rc.client.realtime.accessToken;
    assert.strictEqual(typeof resolver, 'function', 'expected a realtime accessToken resolver');

    // With a live session it returns the user JWT.
    rc.client.auth = new FakeAuth();
    assert.strictEqual(await resolver(), USER_JWT);

    // With the session destroyed it must fall back to the last known user token,
    // NOT to the publishable key. Stock supabase-js returns ANON_KEY here.
    rc.lastKnownSession = { access_token: USER_JWT, refresh_token: 'rt-1' };
    rc.client.auth.session = null;
    const afterSignOut = await resolver();
    assert.notStrictEqual(afterSignOut, ANON_KEY, 'socket was handed the anon publishable key');
    assert.strictEqual(afterSignOut, USER_JWT);

    // And with nothing cached at all it yields null rather than the anon key.
    rc.lastKnownSession = null;
    assert.strictEqual(await resolver(), null);
  });

  // --- SIGNED_OUT: transient failure recovers ---

  await test('SIGNED_OUT with a still-valid refresh token restores the session and stays online', async () => {
    const { rc, client } = makeRemoteChannel();
    client.auth.setSessionResults = [{ error: null }]; // a 429/500 case: token is fine
    await withQuietLogs(async () => {
      client.auth.emit('SIGNED_OUT');
      await flush(10);
    });
    assert.strictEqual(client.auth.setSessionCalls.length, 1, 'expected exactly one restore attempt');
    assert.strictEqual(rc.sessionLost, false, 'must not give up when the restore succeeded');
  });

  // --- SIGNED_OUT: revoked family gives up cleanly ---

  await test('SIGNED_OUT with a revoked token marks the session lost and stops retrying', async () => {
    const { rc, client } = makeRemoteChannel();
    client.auth.setSessionResults = [{ error: Object.assign(new Error('Invalid Refresh Token: Already Used'), { status: 400, name: 'AuthApiError' }) }];
    const channelsBefore = client.channels.length;

    await withQuietLogs(async () => {
      client.auth.emit('SIGNED_OUT');
      await flush(10);
      // A health tick already in flight must not rejoin.
      for (let i = 0; i < 10; i++) rc.checkConnectionHealth();
      await flush(10);
    });

    assert.strictEqual(rc.sessionLost, true, 'expected the session to be marked lost');
    assert.strictEqual(client.channels.length, channelsBefore, 'no channel may be created after the session is lost');
  });

  await test('session loss tears down the existing channel and socket (kills realtime-js rejoin)', async () => {
    // sessionLost only gates OUR health loop — an errored channel left behind
    // keeps realtime-js's own ~10s rejoin timer firing expired-JWT joins
    // forever (staging rig 2026-08-18: ~2.5k joins/device/day post-give-up).
    const { rc, client } = makeRemoteChannel();
    client.auth.setSessionResults = [{ error: Object.assign(new Error('Invalid Refresh Token: Already Used'), { status: 400, name: 'AuthApiError' }) }];
    const stale = client.channel('user:user-1');
    stale.state = 'errored';
    rc.channel = stale;

    await withQuietLogs(async () => {
      client.auth.emit('SIGNED_OUT');
      await flush(10);
    });

    assert.strictEqual(rc.channel, null, 'the errored channel must be detached on session loss');
    assert.strictEqual(stale.state, 'closed', 'the errored channel must be removed, not abandoned');
    assert.ok(client.realtime.disconnectCalls >= 1, 'the socket must be disconnected so nothing rejoins');
  });

  await test('the user-facing notice prints once, not once per health tick', async () => {
    const { rc, client } = makeRemoteChannel();
    client.auth.setSessionResults = [{ error: Object.assign(new Error('Invalid Refresh Token: Already Used'), { status: 400 }) }];
    const { lines } = await withQuietLogs(async () => {
      client.auth.emit('SIGNED_OUT');
      await flush(10);
      for (let i = 0; i < 10; i++) rc.checkConnectionHealth();
      client.auth.emit('SIGNED_OUT'); // auth-js can emit more than once
      await flush(10);
    });
    const notices = lines.filter((l) => l.includes('Remote session expired'));
    assert.strictEqual(notices.length, 1, `expected exactly one notice, got ${notices.length}`);
  });

  await test('a SIGNED_OUT arriving mid-restore does not start a second restore', async () => {
    // The real overlap: auth-js can emit twice (the refresh tick and the
    // in-flight refresh both fail) while the first restore is still awaiting.
    // sessionLost is still false then, so handlingSignedOut is the only guard.
    const { rc, client } = makeRemoteChannel();
    let release;
    const gate = new Promise((r) => { release = r; });
    client.auth.setSession = async (payload) => {
      client.auth.setSessionCalls.push(payload);
      await gate;
      return { data: { session: null }, error: Object.assign(new Error('revoked'), { status: 400 }) };
    };
    await withQuietLogs(async () => {
      void rc.handleSignedOut();
      void rc.handleSignedOut();       // arrives while the first is parked
      await flush(5);
      assert.strictEqual(client.auth.setSessionCalls.length, 1, 'second restore started mid-flight');
      release();
      await flush(20);
      client.auth.emit('SIGNED_OUT'); // and again after it settled
      await flush(10);
    });
    assert.strictEqual(client.auth.setSessionCalls.length, 1, 'restore must be attempted at most once');
    assert.strictEqual(rc.sessionLost, true);
  });

  // --- Regression guard on the path that already worked ---

  await test('TOKEN_REFRESHED still re-authorizes the socket with the new token', async () => {
    const { rc, client } = makeRemoteChannel();
    await withQuietLogs(async () => {
      client.auth.emit('TOKEN_REFRESHED', { access_token: 'eyJ-fresh', refresh_token: 'rt-2' });
      await flush(10);
    });
    // Pure regression guard on pre-existing behaviour: must pass with or without
    // the fix, so it asserts nothing about the new state.
    assert.deepStrictEqual(client.realtime.setAuthCalls, ['eyJ-fresh']);
    assert.strictEqual(rc.lastKnownSession.access_token, 'eyJ-fresh');
  });

  await test('realtime.setAuth is never called with a null/undefined token', async () => {
    const { rc, client } = makeRemoteChannel();
    client.auth.setSessionResults = [{ error: Object.assign(new Error('revoked'), { status: 400 }) }];
    await withQuietLogs(async () => {
      client.auth.emit('TOKEN_REFRESHED', { access_token: 'eyJ-fresh', refresh_token: 'rt-2' });
      client.auth.emit('SIGNED_OUT');
      await flush(10);
    });
    const bad = client.realtime.setAuthCalls.filter((t) => t == null);
    assert.strictEqual(bad.length, 0, 'setAuth() with no token is what resolves to the anon key');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nremote-channel signed-out tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
