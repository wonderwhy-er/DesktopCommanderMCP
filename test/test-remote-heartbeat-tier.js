/**
 * Regression test: the device's last_seen heartbeat must stay in step with the
 * SERVER-SIDE offline-sweep tier that judges it.
 *
 * The server tiers its sweep on the CAPABILITY FLAG, not the app version:
 *   - no transport_broadcast_v1  -> legacy tier,  DEVICE_OFFLINE_TIMEOUT_MS         = 45s
 *   - transport_broadcast_v1     -> capable tier, DEVICE_OFFLINE_TIMEOUT_CAPABLE_MS = 15min
 *
 * A new-build device only sets the flag AFTER a successful presence track(), so
 * between registration and that moment — and permanently, if presence can never
 * be proven (migration 008 not applied, an authz hiccup, exhausted track()
 * retries) — it is judged by the 45s rule. Heartbeating on the slow capable
 * cadence in that state means the sweep marks it offline ~45s after it registers
 * and dispatch then throws "No devices available" forever, even though its
 * INDEPENDENT legacy postgres_changes channel is joined and could run every call.
 *
 * Two invariants, both regressions found in review 2026-07-26:
 *   1. cadence follows the tier (fast while legacy, slow only once capable), and
 *      re-arms the moment the tier changes.
 *   2. the heartbeat write is gated on being reachable by ANY transport, not on
 *      the private channel specifically — gating on the private channel starves
 *      last_seen for exactly the devices the legacy channel is meant to rescue.
 *
 * Standalone: node test/test-remote-heartbeat-tier.js (needs npm run build).
 */
import assert from 'node:assert';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

// The server-side thresholds this device must stay inside. HAND-COPIED from
// remote-dc-mcp/src/server/constants.ts — the two repos ship independently, so
// NOTHING enforces this copy: lowering DEVICE_OFFLINE_TIMEOUT_CAPABLE_MS on the
// server will NOT fail this test. When you change either threshold, change it
// here too. (PUBLISH.md's release gate repeats this pairing for the same reason.)
// What this test does guarantee is the DEVICE half: that its cadence, whatever
// tier it is in, fits inside the threshold recorded below.
const SERVER_LEGACY_OFFLINE_TIMEOUT_MS = 45 * 1000;
const SERVER_CAPABLE_OFFLINE_TIMEOUT_MS = 15 * 60 * 1000;

function makeChannel(state) {
  return { state };
}

/**
 * Minimal client that records mcp_devices writes.
 *
 * `removeChannel` / `realtime.disconnect` are REQUIRED, not decorative:
 * recreateChannel() calls both, and without them it dies on a TypeError before
 * reaching anything the recreate tests stub — which made those tests pass for
 * the wrong reason (caught in review round 8).
 */
function makeFakeClient() {
  const writes = [];
  return {
    writes,
    removeChannel: () => Promise.resolve('ok'),
    realtime: { disconnect: () => Promise.resolve() },
    from() {
      const chain = {
        update: (payload) => {
          writes.push(payload);
          return chain;
        },
        select: () => chain,
        eq: () => Promise.resolve({ error: null }),
      };
      return chain;
    },
  };
}

function makeRemoteChannel() {
  const rc = new RemoteChannel();
  const client = makeFakeClient();
  rc.client = client; // private at TS level, plain property at runtime
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.deviceId = 'device-1';
  rc.deviceName = 'test-device';
  rc.onToolCall = () => {};
  return { rc, client };
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

async function main() {
  // 1. A device that has NOT proven the transport must heartbeat fast enough to
  //    survive the server's 45s legacy sweep.
  await test('legacy tier heartbeats inside the server 45s sweep threshold', async () => {
    const { rc } = makeRemoteChannel();
    rc.transportCapableWritten = null; // never written = legacy tier
    const cadence = rc.heartbeatIntervalMs();
    assert.ok(
      cadence * 2 < SERVER_LEGACY_OFFLINE_TIMEOUT_MS,
      `legacy cadence ${cadence}ms must allow >=2 writes inside the ` +
        `${SERVER_LEGACY_OFFLINE_TIMEOUT_MS}ms sweep window`
    );

    rc.transportCapableWritten = false; // capability explicitly withdrawn
    assert.strictEqual(
      rc.heartbeatIntervalMs(),
      cadence,
      'a withdrawn capability must use the same fast legacy cadence'
    );
  });

  // 2. Once the transport is proven, presence carries liveness and the durable
  //    write drops to bookkeeping cadence — but must still beat the 65min tier.
  await test('capable tier heartbeats inside the server capable sweep threshold', async () => {
    const { rc } = makeRemoteChannel();
    rc.transportCapableWritten = true;
    const cadence = rc.heartbeatIntervalMs();
    assert.ok(
      cadence * 2 < SERVER_CAPABLE_OFFLINE_TIMEOUT_MS,
      `capable cadence ${cadence}ms must allow >=2 writes inside the ` +
        `${SERVER_CAPABLE_OFFLINE_TIMEOUT_MS}ms sweep window`
    );
    assert.ok(
      cadence > SERVER_LEGACY_OFFLINE_TIMEOUT_MS,
      'capable cadence should be the slow bookkeeping one, not the legacy rate'
    );
  });

  // 3. Withdrawing the capability must re-arm the timer immediately. Before the
  //    fix the cadence was a fixed setInterval chosen once at startup, so a
  //    device dropping to the legacy tier kept writing every 30 min and got
  //    swept offline 45s later.
  await test('withdrawing the capability re-arms the heartbeat at the fast cadence', async () => {
    const { rc } = makeRemoteChannel();
    rc.transportCapableWritten = true;
    rc.channel = makeChannel('joined');
    rc.startHeartbeat('device-1');
    try {
      const armed = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms) => {
        armed.push(ms);
        return realSetTimeout(() => {}, 0); // never actually fire
      };
      try {
        await rc.setTransportCapable(false);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }

      assert.ok(armed.length > 0, 'withdrawing the capability must re-arm the heartbeat timer');
      assert.ok(
        armed[armed.length - 1] * 2 < SERVER_LEGACY_OFFLINE_TIMEOUT_MS,
        `re-armed cadence ${armed[armed.length - 1]}ms must fit the 45s legacy sweep`
      );
    } finally {
      rc.stopHeartbeat();
    }
  });

  // 4. THE BLACKOUT CASE. Private channel dead (008 missing / authz failure),
  //    legacy channel joined and delivering. The device is genuinely usable, so
  //    it MUST keep last_seen fresh or the sweep makes it undispatchable.
  await test('heartbeat writes when only the legacy channel is joined', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = null; // private channel never joined
    rc.legacyChannel = makeChannel('joined'); // the safety net is up
    await rc.updateHeartbeat('device-1');
    assert.strictEqual(
      client.writes.length,
      1,
      'a device reachable only via the legacy channel must still write last_seen'
    );
    assert.ok(client.writes[0].last_seen, 'write should bump last_seen');
    assert.strictEqual(client.writes[0].status, 'online', 'write should assert online');
  });

  // 5. ...but a genuinely deaf device must still go silent, so the server's
  //    staleness sweep can age its row out and correct a stale 'online'.
  await test('heartbeat stays silent when no transport is joined', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('errored');
    rc.legacyChannel = makeChannel('closed');
    await rc.updateHeartbeat('device-1');
    assert.strictEqual(
      client.writes.length,
      0,
      'a deaf device must NOT refresh last_seen — the sweep has to be able to age it out'
    );
  });

  // 6. Private channel healthy is of course still reachable.
  await test('heartbeat writes when the private channel is joined', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('joined');
    rc.legacyChannel = null;
    await rc.updateHeartbeat('device-1');
    assert.strictEqual(client.writes.length, 1, 'private channel joined = reachable');
  });

  // 7. THE OSCILLATION CASE. `status` is transport-agnostic — the server's
  //    resolveTargetDevice filters on it — so a private-channel failure must
  //    NOT write 'offline' while the legacy channel is still delivering.
  //    realtime-js re-fires CHANNEL_ERROR on every failed rejoin, so the old
  //    unconditional write left the row flipping offline/online against the
  //    heartbeat and failed ~half of all dispatches.
  await test('private-channel failure keeps status online while legacy is joined', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('errored'); // private join keeps failing
    rc.legacyChannel = makeChannel('joined'); // safety net delivering fine

    rc.syncReachabilityStatus();
    await rc.statusWriteChain;

    assert.strictEqual(client.writes.length, 1, 'one status write');
    assert.strictEqual(
      client.writes[0].status,
      'online',
      'a device still reachable via the legacy channel must stay online'
    );
  });

  // 8. ...but when NO transport is up the device must go offline.
  await test('status goes offline when no transport is joined', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('errored');
    rc.legacyChannel = makeChannel('closed');

    rc.syncReachabilityStatus();
    await rc.statusWriteChain;

    assert.strictEqual(client.writes[0].status, 'offline', 'genuinely deaf device goes offline');
  });

  // 9. Status writes must land in the order they were issued: a teardown's
  //    'offline' must not overtake the subsequent join's 'online'.
  await test('concurrent status writes stay ordered', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('joined');

    rc.queueStatusWrite('offline'); // teardown
    rc.queueStatusWrite('online'); // immediate re-join
    await rc.statusWriteChain;

    assert.strictEqual(client.writes.length, 2, 'both writes issued');
    assert.deepStrictEqual(
      client.writes.map((w) => w.status),
      ['offline', 'online'],
      'writes must apply in issue order so the join wins'
    );
  });

  // 10. Once teardown starts, setOffline()'s durable write owns `status`. A
  //     reachability write queued after that point would be flushed only after
  //     setOffline's blocking spawnSync had already written 'offline', leaving a
  //     shut-down device marked online until the sweep aged it out.
  await test('status writes are suppressed once teardown has started', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('joined');
    rc.legacyChannel = makeChannel('joined');

    rc.shuttingDown = true;
    rc.syncReachabilityStatus();
    rc.queueStatusWrite('online');
    await rc.statusWriteChain;

    assert.strictEqual(
      client.writes.length,
      0,
      'no status write may be issued after teardown starts'
    );
  });

  // 11. unsubscribe() must be bounded: on a half-open socket the leave push only
  //     settles via realtime-js's 10s timeout, which blows device.ts's 5s
  //     force-exit and skips setOffline() entirely.
  await test('unsubscribe is bounded and still clears the channel', async () => {
    const { rc } = makeRemoteChannel();
    let cleared = false;
    rc.legacyChannel = null;
    rc.channel = {
      state: 'joined',
      untrack: () => new Promise(() => {}), // never settles
      unsubscribe: () => new Promise(() => {}), // never settles (half-open)
    };
    // Keep the bound short so the test doesn't wait on real timers.
    rc.sleep = () => Promise.resolve();

    await rc.unsubscribe();
    cleared = rc.channel === null;
    assert.ok(cleared, 'unsubscribe must give up on a wedged leave push and move on');
    assert.strictEqual(rc.shuttingDown, true, 'teardown flag set');
  });

  // 12. THE OVERLAY BLACKOUT. For a FLAGGED device the server treats absent
  //     Presence as authoritative offline and applies that overlay before
  //     selection, so it outranks `status` entirely. A device that keeps the flag
  //     while unable to join the private channel is therefore undispatchable no
  //     matter how healthy its legacy channel is. Until this fix the flag could
  //     only be cleared from trackPresenceInner, which is unreachable unless the
  //     channel is already 'joined' — so such a device never recovered without a
  //     process restart.
  await test('sustained recreate failure withdraws the transport capability', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.transportCapableWritten = true; // previously proven and advertised
    rc.legacyChannel = makeChannel('joined');
    rc.sleep = () => Promise.resolve(); // skip the jittered backoff
    // A channel that can never be rebuilt (008 dropped / RLS denies the join).
    const order = [];
    rc.createChannel = () => {
      order.push('private');
      return Promise.reject(new Error('Unauthorized'));
    };
    rc.createLegacyChannel = () => {
      order.push('legacy');
    };
    rc.channel = makeChannel('errored');

    for (let i = 0; i < 3; i++) {
      await rc.recreateChannel();
    }

    // The recreate must genuinely have reached createChannel — not died earlier
    // on a missing client method — and must rebuild the legacy safety net FIRST
    // and unconditionally, so a private-channel outage never leaves the fallback
    // dead (the round-5 invariant, previously uncovered).
    assert.deepStrictEqual(
      order.slice(0, 2),
      ['legacy', 'private'],
      `legacy net must be rebuilt before the private channel: ${JSON.stringify(order)}`
    );
    assert.strictEqual(
      order.filter((o) => o === 'legacy').length,
      3,
      'the legacy net must be rebuilt on EVERY recreate attempt'
    );

    assert.strictEqual(
      rc.transportCapableWritten,
      false,
      'the capability must be withdrawn after sustained private-channel failure'
    );
    const capWrite = client.writes.find((w) => w.capabilities);
    assert.ok(capWrite, 'a capabilities write should have been issued');
    assert.strictEqual(
      capWrite.capabilities.transport_broadcast_v1,
      undefined,
      'the withdrawn payload must not carry the flag'
    );
    assert.strictEqual(
      capWrite.capabilities.app_version !== undefined,
      true,
      'app_version must survive the whole-column overwrite'
    );
  });

  // 13. A transient failure must NOT flap the capability — realtime-js re-fires
  //     CHANNEL_ERROR on every rejoin, so withdrawing eagerly would churn the DB
  //     and bounce the device between tiers.
  await test('a single recreate failure does not withdraw the capability', async () => {
    const { rc } = makeRemoteChannel();
    rc.transportCapableWritten = true;
    rc.legacyChannel = makeChannel('joined');
    rc.sleep = () => Promise.resolve();
    rc.createChannel = () => Promise.reject(new Error('transient'));
    rc.createLegacyChannel = () => {};
    rc.channel = makeChannel('errored');

    await rc.recreateChannel();

    assert.strictEqual(
      rc.transportCapableWritten,
      true,
      'one blip must not withdraw the capability'
    );
  });

  // 14. The heartbeat asserts status:'online', so it must respect the shutdown
  //     gate too — otherwise a tick landing after setOffline()'s subprocess write
  //     leaves an exited process marked online with a fresh last_seen.
  await test('heartbeat is suppressed once shutting down', async () => {
    const { rc, client } = makeRemoteChannel();
    rc.channel = makeChannel('joined');
    rc.shuttingDown = true;
    await rc.updateHeartbeat('device-1');
    assert.strictEqual(client.writes.length, 0, 'no heartbeat write during shutdown');
  });

  // 15. The withdrawal runs in recreateChannel()'s catch, which
  //     RECREATE_TIMEOUT_MS does not cover. A hanging capabilities PATCH must not
  //     pin isRecreatingChannel=true, or the 10s connection watchdog is silently
  //     disabled and the device can never recover.
  await test('a hanging capability withdrawal cannot pin the recreate guard', async () => {
    const { rc } = makeRemoteChannel();
    rc.transportCapableWritten = true;
    rc.legacyChannel = makeChannel('joined');
    rc.sleep = () => Promise.resolve();
    rc.createChannel = () => Promise.reject(new Error('Unauthorized'));
    rc.createLegacyChannel = () => {};
    rc.channel = makeChannel('errored');
    // A capabilities write that never settles.
    rc.setTransportCapable = () => new Promise(() => {});
    // Keep the bound short so the test doesn't wait 5s of real time.
    const realWithTimeout = rc.withTimeout.bind(rc);
    rc.withTimeout = (op, _ms, name) => realWithTimeout(op, 20, name);

    for (let i = 0; i < 3; i++) {
      await rc.recreateChannel();
    }

    assert.strictEqual(
      rc.isRecreatingChannel,
      false,
      'the re-entrancy guard must be released even when the withdrawal hangs'
    );
  });

  // 16. setOffline() must not be blocked by auth.getSession(). It takes a lock
  //     with a 10s acquire timeout and refreshes when the token is merely within
  //     ~90s of expiry, POSTing /token with its own ~30s retry budget — so on a
  //     just-woken machine it can outlast device.ts's 5s force-exit, and then
  //     spawnSync never runs and the durable offline write is lost entirely.
  await test('setOffline does not hang when getSession stalls', async () => {
    const { rc } = makeRemoteChannel();
    rc.client.auth = { getSession: () => new Promise(() => {}) }; // never settles
    rc.lastKnownSession = { access_token: 'cached-at', refresh_token: 'cached-rt' };
    // Missing supabase config makes setOffline return right after the session
    // step, so this test isolates the session fetch and spawns no subprocess.
    rc.client.supabaseUrl = undefined;
    rc.client.supabaseKey = undefined;

    // The real assertion: it must SETTLE. Without the bound on getSession the
    // await below never returns and this test times out.
    let settled = false;
    await Promise.race([
      rc.setOffline('device-1').then(() => {
        settled = true;
      }),
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    assert.strictEqual(
      settled,
      true,
      'setOffline must settle on a stalled getSession rather than block the shutdown path'
    );
  });

  // 17. stopHeartbeat must not leave a timer able to re-arm itself.
  await test('stopHeartbeat halts the self-rescheduling timer', async () => {
    const { rc } = makeRemoteChannel();
    rc.channel = makeChannel('joined');
    rc.startHeartbeat('device-1');
    rc.stopHeartbeat();
    assert.strictEqual(rc.heartbeatInterval, null, 'timer handle cleared');
    assert.strictEqual(rc.heartbeatDeviceId, null, 'device id cleared so re-arm is a no-op');
    rc.scheduleHeartbeat(); // must be inert after stop
    assert.strictEqual(rc.heartbeatInterval, null, 'scheduleHeartbeat after stop must not re-arm');
  });

  console.log(`\n${failures ? '🔴' : '✅'} remote heartbeat tier: ${failures} failing test(s).`);
  process.exit(failures ? 1 : 0);
}

main();
