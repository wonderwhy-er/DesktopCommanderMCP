#!/usr/bin/env node

/**
 * Remote transport tests (Broadcast/Presence).
 *
 * Sections:
 *   1. Exactly-once execution under dual delivery
 *   2. Doorbell routing and row fetch
 *   3. Result write ordering
 *   4. Heartbeat cadence
 *   5. Reachability and status writes
 *   6. Presence and readiness writes
 *   7. Shutdown
 *
 * Run: npm run build && node test/test-remote-transport.js
 */

import { MCPDevice } from '../dist/remote-device/device.js';
import { HEARTBEAT_INTERVAL_MS, RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { exitProcess } from '../dist/utils/exit-process.js';

// Server-side windows this device's last_seen must fit inside: the offline
// sweep (remote-dc-mcp src/server/constants.ts) and the dashboard's freshness
// window for the online dot. Hand-copied — the repos ship separately and
// nothing enforces the copy, so change both together.
const SERVER_OFFLINE_TIMEOUT_MS = 15 * 60 * 1000;
const DASHBOARD_FRESHNESS_MS = 7 * 60 * 1000;

const DEVICE_ID = 'device-1';
const OTHER_DEVICE = 'device-2';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const makeChannelState = (state) => ({ state });

// Captured before any test runs, so the fake client's write completion never
// depends on a timer a test has stubbed.
const realSetTimeout = globalThis.setTimeout;

/** MCPDevice with the network and desktop edges stubbed. */
function makeDevice({ claimResults = [] } = {}) {
  const device = new MCPDevice();
  const executed = [];
  const claims = [...claimResults];

  device.deviceId = DEVICE_ID;
  device.desktop = {
    callClientTool: async (toolName, args) => {
      executed.push({ toolName, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  device.remoteChannel = {
    // Default: first delivery claims, later ones lose. Override to model a
    // transient DB error, which makes the claim return true (fail open).
    markCallExecuting: async () => (claims.length ? claims.shift() : true),
    updateCallResult: async () => {},
  };
  return { device, executed };
}

/**
 * Supabase client fake covering both shapes the device uses:
 * `update(...).eq(...)` (awaited) and `select(...).eq(...).maybeSingle()`.
 * Records every mcp_devices write in `writes`.
 */
function makeFakeClient({ row = null, failFetches = 0, failClaims = 0, lostClaims = 0, writeLatencies = [], claimDeviceId = DEVICE_ID } = {}) {
  const writes = [];
  // Recorded when a write COMPLETES, not when it is issued. `writes` alone
  // cannot test ordering: setOnlineStatus evaluates .update() synchronously
  // before its only await, so issue order holds with or without the
  // statusWriteChain serialisation.
  const completions = [];
  let fetchAttempts = 0;
  let claimAttempts = 0;
  let pendingWrite = null;
  let lastClaim = null;

  // The claim, update({status:'executing'}).eq(...).select(...): it records the
  // filters and the select, because both decide what PostgREST returns — a
  // missing filter claims the wrong row, and a missing select() answers 204
  // with no row at all. The first `lostClaims` failed attempts still commit,
  // like a response lost after the write.
  const claim = () => {
    const filters = {};
    let selected = null;
    const settle = () => {
      claimAttempts++;
      const failed = claimAttempts <= failClaims;
      const wantsRow = selected === '*';
      const matches =
        filters.id === row?.id && filters.status === 'pending' && (!wantsRow || filters.device_id === claimDeviceId);
      const committed = !!row && matches && row.status === 'pending' && (!failed || claimAttempts <= lostClaims);
      if (committed) row.status = 'executing';
      lastClaim = { filters: { ...filters }, select: selected };
      if (failed) return { data: null, error: { message: 'claim failed' } };
      if (selected === null) return { data: null, error: null }; // PostgREST 204, no representation
      return { data: committed ? [wantsRow ? row : { id: row.id }] : [], error: null };
    };
    const builder = {
      eq: (col, value) => {
        filters[col] = value;
        return builder;
      },
      // Claims now also guard timeout_at > corrected-now. These transport
      // tests focus on claim routing/atomicity, so the fake accepts the range
      // predicate without adding clock behavior of its own.
      gt: () => builder,
      select: (cols = '*') => {
        selected = cols;
        return builder;
      },
      then: (onFulfilled, onRejected) => Promise.resolve().then(settle).then(onFulfilled, onRejected),
    };
    return builder;
  };

  const result = () => {
    const p = Promise.resolve({ data: null, error: null });
    p.maybeSingle = async () => {
      fetchAttempts++;
      if (fetchAttempts <= failFetches) {
        return { data: null, error: { message: 'fetch failed' } };
      }
      return { data: row, error: null };
    };
    p.eq = () => result();
    p.gt = (col, value) => {
      assert(col === 'timeout_at', 'fallback must filter timeout_at');
      assert(value === 'now', 'fallback read must compare against database time');
      return result();
    };
    p.select = () => result();
    return p;
  };

  const chain = {
    update: (payload) => {
      writes.push(payload);
      // Per-write completion latency, so a test can make an earlier write land
      // LATER than a later one — the only way to observe serialisation.
      pendingWrite = {
        payload,
        delay: writeLatencies.length ? writeLatencies.shift() : 0,
      };
      return chain;
    },
    select: () => chain,
    insert: () => chain,
    eq: (col, value) => {
      if (!pendingWrite) return result();
      const { payload, delay } = pendingWrite;
      pendingWrite = null;
      // The claim's first .eq() lands here, so hand it to the builder that
      // records filters instead of dropping it.
      if (payload.status === 'executing') return claim().eq(col, value);
      const p = new Promise((resolve) => {
        const settle = () => {
          completions.push(payload);
          resolve({ data: null, error: null });
        };
        // Only defer when a test actually asked for latency, so every other
        // test keeps the original resolve-immediately semantics. 'never': a
        // PATCH sent down a half-open connection, which nothing answers.
        if (delay === 'never') return;
        if (delay > 0) realSetTimeout(settle, delay);
        else settle();
      });
      // markCallExecuting chains .eq().eq().select() off a single update(), so
      // this must stay chainable exactly like result() does — returning a bare
      // promise leaves that chain hanging forever.
      const chainable = (promise) => {
        promise.eq = () => promise;
        promise.select = () => promise;
        promise.maybeSingle = async () => ({ data: null, error: null });
        // As postgrest-js: the fetch is aborted and the result carries the
        // error. A write the server already has may still complete above.
        promise.abortSignal = (signal) => chainable(Promise.race([promise, new Promise((resolve) => {
          const abort = () => resolve({ data: null, error: { message: `${signal.reason?.name ?? 'AbortError'}: aborted` } });
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        })]));
        return promise;
      };
      return chainable(p);
    },
  };

  return {
    writes,
    completions,
    attempts: () => fetchAttempts,
    claims: () => claimAttempts,
    lastClaim: () => lastClaim,
    // Required by recreateChannel(); without them it dies on a TypeError before
    // reaching anything the recreate tests stub.
    removeChannel: () => Promise.resolve('ok'),
    // isDisconnecting models a client that has already settled, so
    // waitForSocketSettled() polls once and returns. NOTE: this fake has no
    // real connection state, so it cannot observe whether a new socket was
    // actually dialled — the recreate tests verify sequencing, not transport.
    realtime: { disconnect: () => Promise.resolve(), isDisconnecting: () => false },
    from: () => chain,
  };
}

function makeRemoteChannel(opts = {}) {
  const rc = new RemoteChannel();
  const client = makeFakeClient(opts);
  rc.client = client; // private in TS, plain property at runtime
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.deviceId = DEVICE_ID;
  rc.deviceName = 'test-device';
  rc.onToolCall = () => {};
  return { rc, client };
}

const payloadFor = (id, deviceId = DEVICE_ID) => ({
  new: {
    id,
    tool_name: 'start_process',
    tool_args: { command: 'echo hi' },
    device_id: deviceId,
    metadata: {},
  },
});

// --- 1. Exactly-once under dual delivery ------------------------------------
// Both transports deliver every call during the transition. The DB claim fails
// OPEN on a transient error, so the in-memory guard is the real guarantee.

await test('dual delivery of the same call executes the tool exactly once', async () => {
  const { device, executed } = makeDevice();
  await device.handleNewToolCall(payloadFor('call-a'));
  await device.handleNewToolCall(payloadFor('call-a')); // the other transport
  assert(executed.length === 1, `expected 1 execution, got ${executed.length}`);
});

await test('exactly-once holds when the DB claim fails OPEN for both deliveries', async () => {
  const { device, executed } = makeDevice({ claimResults: [true, true] });
  await device.handleNewToolCall(payloadFor('call-b'));
  await device.handleNewToolCall(payloadFor('call-b'));
  assert(executed.length === 1, `fail-open claim double-executed: ${executed.length} runs`);
});

await test('a lost DB claim (another process won) skips execution', async () => {
  const { device, executed } = makeDevice({ claimResults: [false] });
  await device.handleNewToolCall(payloadFor('call-c'));
  assert(executed.length === 0, `expected no execution, got ${executed.length}`);
});

await test('a delivery the doorbell already claimed executes once without claiming again', async () => {
  const { device, executed } = makeDevice();
  let dbClaims = 0;
  device.remoteChannel.markCallExecuting = async () => { dbClaims++; return true; };
  await device.handleNewToolCall({ ...payloadFor('call-e'), claimed: true });
  assert(executed.length === 1, `expected 1 execution, got ${executed.length}`);
  assert(dbClaims === 0, `expected no DB claim, got ${dbClaims}`);
});

await test('calls for another device are ignored and do not poison the dedupe set', async () => {
  const { device, executed } = makeDevice();
  await device.handleNewToolCall(payloadFor('call-d', OTHER_DEVICE));
  assert(executed.length === 0, 'must not execute another device call');
  // The device filter runs before dedupe, so our own copy must still run.
  await device.handleNewToolCall(payloadFor('call-d'));
  assert(executed.length === 1, 'a mismatched delivery must not suppress our own');
});

await test('the seen-call-id set stays bounded', async () => {
  const { device } = makeDevice();
  for (let i = 0; i < 250; i++) await device.handleNewToolCall(payloadFor(`bulk-${i}`));
  assert(device.seenCallIds.size <= 100, `set grew to ${device.seenCallIds.size}`);
});

// --- 2. Doorbell routing ----------------------------------------------------

await test('doorbell for another device is ignored without fetching', async () => {
  const { rc, client } = makeRemoteChannel();
  await rc.onDoorbell({ call_id: 'x', device_id: OTHER_DEVICE });
  assert(client.attempts() === 0 && client.claims() === 0, 'must not even fetch the row');
});

await test('doorbell delivers a pending row through the shared handler', async () => {
  const row = { id: 'x', status: 'pending', tool_name: 'start_process' };
  const { rc, client } = makeRemoteChannel({ row });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 1, 'expected one delivery');
  assert(delivered[0].new === row, 'must pass the claimed row as {new: row}');
  assert(delivered[0].claimed === true, 'must mark the delivery claimed');
  assert(client.claims() === 1 && client.attempts() === 0, 'one claim, no separate fetch');
});

await test('the doorbell claim filters by id, device and pending status, and asks for the row', async () => {
  const { rc, client } = makeRemoteChannel({ row: { id: 'x', status: 'pending' } });
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  const claim = client.lastClaim();
  assert(claim.filters.id === 'x', `claim must filter on the call id: ${JSON.stringify(claim)}`);
  assert(claim.filters.device_id === DEVICE_ID, `claim must filter on this device: ${JSON.stringify(claim)}`);
  assert(claim.filters.status === 'pending', `claim must stay conditional on pending: ${JSON.stringify(claim)}`);
  assert(claim.select === '*', 'claim must select the row, or PostgREST returns no representation');
});

await test('a claim that does not match this device delivers nothing', async () => {
  const { rc, client } = makeRemoteChannel({ row: { id: 'x', status: 'pending' }, claimDeviceId: OTHER_DEVICE });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'a row owned by another device must not be delivered');
  assert(client.claims() === 1 && client.attempts() === 0, 'one claim, no read-back');
});

await test('doorbell for an already-claimed row does not re-deliver', async () => {
  const { rc, client } = makeRemoteChannel({ row: { id: 'x', status: 'executing' } });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'non-pending rows must not be re-delivered');
  assert(client.attempts() === 0, 'a clean empty claim needs no fetch');
});

await test('doorbell claim retries a transient failure', async () => {
  const { rc, client } = makeRemoteChannel({ row: { id: 'x', status: 'pending' }, failClaims: 2 });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  rc.sleep = () => Promise.resolve();
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(client.claims() === 3, `expected 3 attempts, got ${client.claims()}`);
  assert(delivered.length === 1, 'should deliver after the retry succeeds');
  assert(delivered[0].claimed === true, 'the successful retry claimed it');
});

await test('a claim that reads back executing is never delivered — the claimant is unknowable', async () => {
  const { rc, client } = makeRemoteChannel({ row: { id: 'x', status: 'pending' }, failClaims: 1, lostClaims: 1 });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  rc.sleep = () => Promise.resolve();
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(client.attempts() === 1, `expected one read-back, got ${client.attempts()}`);
  // Our own committed claim and another process's claim both read 'executing',
  // so delivering on that guess runs a side-effecting tool twice.
  assert(delivered.length === 0, `an executing row must not be delivered, got ${delivered.length}`);
});

await test('every claim failing falls back to an unclaimed delivery', async () => {
  const { rc, client } = makeRemoteChannel({
    row: { id: 'x', status: 'pending', timeout_at: new Date(Date.now() + 60_000).toISOString() },
    failClaims: 3,
  });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  rc.sleep = () => Promise.resolve();
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(client.claims() === 3 && client.attempts() === 1, 'three claims, then one fetch');
  assert(delivered.length === 1, 'the fetched pending row must be delivered');
  assert(delivered[0].claimed !== true, 'device.ts must still claim it');
});

await test('doorbell with a missing row is a no-op', async () => {
  const { rc } = makeRemoteChannel({ row: null });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'gone', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'missing row must not deliver');
});

// --- 2b. Handler rejections are observed -------------------------------------
// handleNewToolCall is async and its promise is discarded at both call sites, so
// a rejection would be unhandled and terminate the device process.

await test('a rejecting tool-call handler does not produce an unhandled rejection', async () => {
  const { rc } = makeRemoteChannel({ row: { id: 'x', status: 'pending' } });
  rc.onToolCall = async () => { throw new Error('handler blew up'); };

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
    await new Promise((r) => setImmediate(r)); // let a rejection surface
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert(unhandled.length === 0, `unhandled rejection escaped: ${unhandled[0]?.message}`);
});

await test('a synchronously throwing handler is contained too', async () => {
  const { rc } = makeRemoteChannel({ row: { id: 'x', status: 'pending' } });
  rc.onToolCall = () => { throw new Error('sync throw'); };
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID }); // must not reject
});

// --- 3. Result write ---------------------------------------------------------
// The result write is the only notification the server needs: a DB trigger on
// mcp_remote_calls sends it to the instance that dispatched the call.

await test('a completed call writes exactly one completed result row', async () => {
  const writes = [];
  const { device, executed } = makeDevice();
  device.remoteChannel.updateCallResult = async (id, status) => { writes.push(`${id}:${status}`); };
  await device.handleNewToolCall(payloadFor('call-result'));
  assert(executed.length === 1, 'tool should have run');
  assert(writes.join(',') === 'call-result:completed', `expected one completed write — got ${writes.join(',')}`);
});

// --- 4. Heartbeat cadence ---------------------------------------------------
// One cadence for every device: the server sweeps a row offline after 15 min
// without a heartbeat, and the dashboard's dot trusts a row's 'online' only
// while last_seen is fresh.

await test('heartbeat cadence fits inside the server sweep and the dashboard window', async () => {
  assert(
    HEARTBEAT_INTERVAL_MS * 2 < SERVER_OFFLINE_TIMEOUT_MS,
    `cadence ${HEARTBEAT_INTERVAL_MS}ms must allow >=2 writes inside ${SERVER_OFFLINE_TIMEOUT_MS}ms`
  );
  assert(
    HEARTBEAT_INTERVAL_MS < DASHBOARD_FRESHNESS_MS,
    `cadence ${HEARTBEAT_INTERVAL_MS}ms must refresh last_seen inside ${DASHBOARD_FRESHNESS_MS}ms`
  );
});

await test('stopHeartbeat clears the heartbeat timers', async () => {
  const { rc } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.startHeartbeat(DEVICE_ID);
  rc.stopHeartbeat();
  assert(rc.heartbeatInterval === null, 'heartbeat timer cleared');
  assert(rc.connectionCheckInterval === null, 'health check timer cleared');
});

// --- 5. Reachability and status writes --------------------------------------
// `status` is what the server's device selection filters on, so it is a claim
// that this device will run a tool call right now. It follows the private
// channel's join state AND the local executor probe MCPDevice installs (issue
// #4). These cases build a bare RemoteChannel, which has no device and so no
// probe, leaving the join state the only thing under test here; the executor
// half is covered in test-remote-device-readiness.js.

await test('heartbeat stays silent when no transport is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('errored');
  await rc.updateHeartbeat();
  assert(client.writes.length === 0, 'a deaf device must let the sweep age its row out');
});

// Joined is only half of it. Until the join's own status write lands the
// device is not ready, and the heartbeat must not mark the row online ahead of
// it. Reachability is both.
await test('heartbeat stays silent when joined but the row was never marked ready', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.channelReady = false;
  await rc.updateHeartbeat();
  assert(client.writes.length === 0, 'no readiness write landed = not ready = no heartbeat');
});

await test('heartbeat writes when the channel is joined and ready, with or without presence', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.channelReady = true;
  rc.presenceTracked = false; // Presence only feeds the dashboard
  await rc.updateHeartbeat();
  assert(client.writes.length === 1, 'joined + ready = reachable');
});

await test('status goes offline when the private channel is not joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('errored');
  rc.syncReachabilityStatus();
  await rc.statusWriteChain;
  assert(client.writes[0].status === 'offline', 'genuinely deaf device goes offline');
});

await test('concurrent status writes stay ordered', async () => {
  // The first write completes AFTER the second is issued. Without the
  // statusWriteChain serialisation the teardown's 'offline' then lands at the
  // DB after the re-join's 'online', leaving a healthy device undispatchable
  // until the next heartbeat (up to 5 min). Assert on `completions`, not
  // `writes` — see makeFakeClient.
  const { rc, client } = makeRemoteChannel({ writeLatencies: [20, 0] });
  rc.channel = makeChannelState('joined');
  rc.queueStatusWrite('offline'); // teardown
  rc.queueStatusWrite('online'); // immediate re-join
  await rc.statusWriteChain;
  // Let the deferred first write land even when the implementation does NOT
  // serialise, so this fails on ORDER — the actual bug — rather than on timing.
  const deadline = Date.now() + 500;
  while (client.completions.length < 2 && Date.now() < deadline) {
    await new Promise((r) => realSetTimeout(r, 5));
  }
  assert(client.writes.length === 2, 'both writes issued');
  assert(client.completions.length === 2, 'both writes completed');
  assert(
    client.completions.map((w) => w.status).join(',') === 'offline,online',
    `writes must COMPLETE in issue order so the join wins, got ${client.completions
      .map((w) => w.status)
      .join(',')}`
  );
});

await test("a heartbeat still in flight cannot land after a drop's 'offline'", async () => {
  // The heartbeat's PATCH is slow and the channel drops meanwhile. Status is
  // all dispatch reads, so a late 'online' would leave a deaf device picked.
  const { rc, client } = makeRemoteChannel({ writeLatencies: [20, 0] });
  rc.channel = makeChannelState('joined');
  rc.channelReady = true;
  const heartbeat = rc.updateHeartbeat();
  rc.channel = makeChannelState('errored'); // the drop
  rc.channelReady = false;
  rc.syncReachabilityStatus();
  await heartbeat;
  await rc.statusWriteChain;
  const deadline = Date.now() + 500;
  while (client.completions.length < 2 && Date.now() < deadline) {
    await new Promise((r) => realSetTimeout(r, 5));
  }
  assert(client.completions.length === 2, 'both writes completed');
  assert(
    client.completions.map((w) => w.status).join(',') === 'online,offline',
    `the drop's 'offline' must land last, got ${client.completions.map((w) => w.status).join(',')}`
  );
});

// --- 6. Presence and readiness writes ----------------------------------------
// Server dispatch reads only the row's status; Presence only feeds the
// dashboard, so a Presence failure never writes the row.

await test('a Presence failure never writes the device row', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = { state: 'joined', track: async () => 'timed out' };

  await rc.trackPresence(0);

  assert(client.writes.length === 0, `Presence must not write the row at all: ${JSON.stringify(client.writes)}`);
});

/** Resolves true once `promise` settles, false if it hasn't within `ms` */
const settlesWithin = (promise, ms) => Promise.race([
  promise.then(() => true, () => true),
  new Promise((resolve) => realSetTimeout(() => resolve(false), ms)),
]);

// A status PATCH sent down a half-open connection is never answered. It must
// not keep readiness from being retried.
await test('a status write nothing answers cannot keep readiness from being retried', async () => {
  const { rc } = makeRemoteChannel({ writeLatencies: ['never'] }); // the first status write
  rc.deviceRowWriteSignal = () => AbortSignal.timeout(50);
  rc.channel = { state: 'joined' };

  const firstReturned = await settlesWithin(rc.markChannelReady(), 2000);
  const retried = firstReturned && await settlesWithin(rc.markChannelReady(), 2000);
  assert(firstReturned && retried && rc.channelReady,
    `a status write that was never answered ${firstReturned ? 'failed in time' : 'kept the readiness attempt waiting for 2 s'}`
    + `${firstReturned ? `, and the retry after it ${retried ? 'finished' : 'waited behind it for 2 s'}` : ''}: `
    + `ready ${rc.channelReady}. The health check retries readiness only once that attempt returns.`);
});

// --- 7. Shutdown ------------------------------------------------------------
// setOffline()'s durable write is the final word on status, so nothing may race
// or outlast it — device.ts force-exits 5s after the signal.

await test('status writes are suppressed once shutting down', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.shuttingDown = true;
  rc.syncReachabilityStatus();
  rc.queueStatusWrite('online');
  await rc.statusWriteChain;
  assert(client.writes.length === 0, 'no status write after teardown starts');
});

await test('heartbeat is suppressed once shutting down', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.shuttingDown = true;
  await rc.updateHeartbeat();
  assert(client.writes.length === 0, 'no heartbeat write during shutdown');
});

await test('unsubscribe is bounded and still clears the channel', async () => {
  const { rc } = makeRemoteChannel();
  rc.channel = {
    state: 'joined',
    untrack: () => new Promise(() => {}), // never settles
    unsubscribe: () => new Promise(() => {}), // half-open socket
  };
  rc.sleep = () => Promise.resolve();
  await rc.unsubscribe();
  assert(rc.channel === null, 'must give up on a wedged leave push and move on');
  assert(rc.shuttingDown === true, 'teardown flag set');
});

await test('setOffline does not hang when getSession stalls', async () => {
  const { rc } = makeRemoteChannel();
  rc.client.auth = { getSession: () => new Promise(() => {}) }; // never settles
  rc.lastKnownSession = { access_token: 'cached-at', refresh_token: 'cached-rt' };
  // Missing config makes setOffline return right after the session step, so no
  // subprocess is spawned.
  rc.client.supabaseUrl = undefined;
  rc.client.supabaseKey = undefined;

  let settled = false;
  await Promise.race([
    rc.setOffline(DEVICE_ID).then(() => { settled = true; }),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  assert(settled, 'setOffline must settle rather than block the shutdown path');
});

console.log(`\n${failures ? '🔴' : '✅'} remote transport: ${failures} failing test(s).`);
exitProcess(failures ? 1 : 0);
