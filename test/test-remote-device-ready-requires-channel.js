/**
 * Regression test: a device must not present itself as ready — to the user or
 * to the server — before it can actually receive commands.
 *
 * RDC-6. ChatGPT lists every tool, then the first call comes back saying the
 * tool is disabled while the device sits there looking healthy. Measured in the
 * hosted service's telemetry on 2026-09-18: in seven days 364 devices (316
 * users) had at least one dispatch refused and not one single success — 118 of
 * them on 0.2.50 and 66 on 0.2.51, so this is not an old-client problem.
 *
 * The hosted service dispatches to any row that says `status: 'online'`, so a
 * row may say so only once the channel can deliver; until then every call is
 * handed to a device with no delivery path.
 *
 * Both halves of that state are written here, in registerDevice():
 *
 *   - it sets `status: 'online'` before the channel is even subscribed, so the
 *     server treats the device as a dispatch target during the join attempt —
 *     and for a device that can never join (blocked websockets, proxy), for as
 *     long as the row takes to age out
 *   - it swallows a createChannel() rejection into console.debug, so device.ts
 *     prints "Device ready" over a device that cannot receive anything
 *
 * createChannel() already resolves only once the row advertises the channel, and says why:
 * "otherwise registerDevice() reports Device ready while still undispatchable".
 * The last mile is missing — the rejection never reaches the caller.
 *
 * The fakes model only what registerDevice() touches: the mcp_devices row, and
 * a realtime channel whose subscribe outcome the case picks.
 *
 * Runs as part of `npm test` (which builds first), or standalone:
 *   node test/test-remote-device-ready-requires-channel.js
 */
import assert from 'node:assert';
import { ChannelUnreachableError, RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { exitProcess } from '../dist/utils/exit-process.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';
const USER = { id: 'user-1', email: 'tester@example.com' };

/**
 * A promise with its resolver exposed. Not Promise.withResolvers(): package.json
 * declares `node >= 18` and that arrived in Node 22, so calling it would throw
 * in the FakeClient constructor and take every case in this file with it, on a
 * runtime the project claims to support. CI runs Node 22 and would not notice.
 */
function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/** Realtime channel whose join outcome the test picks. */
class FakeChannel {
    state = 'joining';
    constructor(client) {
        this.client = client;
    }
    on() {
        return this;
    }
    subscribe(cb) {
        // Record what the row already claimed at the moment the join starts —
        // this is the window the server dispatches into.
        this.client.statusWritesBeforeJoin = this.client.statusWrites.slice();
        Promise.resolve().then(() => {
            if (this.client.channelJoins) {
                this.state = 'joined';
                cb('SUBSCRIBED');
            } else {
                // What a blocked websocket looks like to realtime-js.
                this.state = 'errored';
                cb('CHANNEL_ERROR', new Error('websocket refused'));
            }
        });
        return this;
    }
    track() {
        // realtime-js RESOLVES track() with a status string rather than
        // rejecting, so a refused presence publication looks like this.
        if (!this.client.presenceAcks) return Promise.resolve('timed out');
        this.tracked = true;
        return Promise.resolve('ok');
    }
    untrack() {
        return Promise.resolve('ok');
    }
    unsubscribe() {
        this.state = 'leaving';
        return Promise.resolve({ error: null });
    }
}

class FakeRealtime {
    conn = { readyState: 1 };
    reconnectTimer = { tries: 0 };
    pendingHeartbeatRef = null;
    _heartbeatSentAt = null;
    _manuallySetToken = true;
    onHeartbeat(cb) {
        this._heartbeatCb = cb;
    }
    connectionState() {
        return 'open';
    }
    isConnected() {
        return true;
    }
    disconnect() {
        return Promise.resolve();
    }
    setAuth() {}
}

/**
 * Just the mcp_devices row. Every write is recorded, because the question this
 * file asks is what the row claims, and when.
 */
class FakeClient {
    realtime = new FakeRealtime();
    channels = [];
    writes = []; // every update payload, in order
    statusWrites = []; // just the `status` values, in order
    channelJoins = true;
    presenceAcks = true; // does the channel acknowledge track()?
    failOnlineWrite = false; // is the join's 'online' write refused?
    holdOnlineWrite = false; // leave the join's 'online' write in flight, forever
    /** Resolves once the 'online' write has been issued and is hanging. */
    onlineWriteIssued = deferred();
    deviceExists = true; // is there a row for this device id at all?
    statusWritesBeforeJoin = null;

    channel() {
        const ch = new FakeChannel(this);
        this.channels.push(ch);
        return ch;
    }
    removeChannel() {
        return Promise.resolve();
    }
    removeAllChannels() {
        return Promise.resolve();
    }

    from(table) {
        assert.equal(table, 'mcp_devices', `unexpected table: ${table}`);
        const client = this;
        let result = { data: [{ id: DEVICE_ID }], error: null };
        // One thenable that is also chainable, because the three callers end
        // the chain differently: findDevice with .maybeSingle(), updateDevice
        // with .select(), setOnlineStatus with a bare .eq().
        const node = {
            select: () => node,
            update: (updates) => {
                client.writes.push(updates);
                if (typeof updates.status === 'string') client.statusWrites.push(updates.status);
                // Supabase reports a refused write in the result, not by
                // throwing — which is how it reaches code that ignores it.
                if (updates.status === 'online') {
                    if (client.failOnlineWrite) {
                        result = { data: null, error: { message: 'status write refused' } };
                    }
                    if (client.holdOnlineWrite) {
                        // A PATCH that is simply slow. Everything the device does
                        // in this window happens before the join is recorded.
                        // Only the first one: a later write must still settle.
                        client.holdOnlineWrite = false;
                        result = new Promise(() => {});
                        client.onlineWriteIssued.resolve();
                    }
                }
                return node;
            },
            insert: () => node,
            eq: () => node,
            // The device bounds its row writes; no case here runs into that bound
            abortSignal: () => node,
            maybeSingle: () =>
                Promise.resolve({
                    data: client.deviceExists ? { id: DEVICE_ID, device_name: 'test-device' } : null,
                    error: null
                }),
            then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
        };
        return node;
    }
}

// The code under test narrates itself to the console, including from async
// callbacks that land after a case has finished. Keep the original writers for
// this file's own output and mute the rest, so a run shows results and nothing
// else. Set DEBUG_TEST=1 to hear it again while working on the fix.
const out = console.log.bind(console);
const err = console.error.bind(console);
if (!process.env.DEBUG_TEST) {
    const mute = () => {};
    console.log = mute;
    console.debug = mute;
    console.error = mute;
    console.warn = mute;
}

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeRemoteChannel(channelJoins, overrides = {}) {
    const rc = new RemoteChannel();
    const client = new FakeClient();
    client.channelJoins = channelJoins;
    Object.assign(client, overrides);
    rc.client = client; // private at TS level, a plain property at runtime
    rc._user = USER;
    rc.sleep = () => Promise.resolve(); // no real backoff in tests
    return { rc, client };
}

function register(rc) {
    return rc.registerDevice({ tools: [] }, DEVICE_ID, 'test-device', () => {});
}

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        out(`PASS  ${name}`);
    } catch (error) {
        failures++;
        err(`FAIL  ${name}\n     ${error.message}`);
    }
}

// Control. The two cases below both demand that registration refuse to succeed,
// and a fix that simply made registerDevice() always fail would satisfy them
// while breaking every working device. This is the case that forbids that: a
// device whose channel joins must still register and end up online.
await test('a device whose channel joins registers and is marked online', async () => {
    const { rc, client } = makeRemoteChannel(true);
    await register(rc);
    await flush(10);

    assert.equal(client.channels[0].state, 'joined', 'precondition: the channel joined');
    assert.equal(
        client.statusWrites.at(-1),
        'online',
        `the row should end up online, got writes: ${JSON.stringify(client.statusWrites)}`
    );
});

await test('registration fails out loud when the channel cannot join', async () => {
    const { rc } = makeRemoteChannel(false);

    await assert.rejects(
        () => register(rc),
        (error) => {
            // device.ts keeps the process alive for this one and promises a
            // background retry, so it must be told apart from a registration
            // error nothing can repair — see the missing-row case below.
            assert.ok(
                error instanceof ChannelUnreachableError,
                `registerDevice() reported a failed join as ${error.name}. device.ts cannot ` +
                    'distinguish it from an unrecoverable registration failure, so it either ' +
                    'kills a recoverable process or promises a retry that can never happen.'
            );
            return true;
        },
        'registerDevice() resolved although the channel never joined. device.ts prints ' +
            '"Device ready" on the next line, so the user is told a device that cannot ' +
            'receive a single command is working — and the hosted service refuses every ' +
            'call with advice to restart the terminal, which returns to this same state.'
    );
});

await test('registration does not claim the device is online before the channel joins', async () => {
    const { rc, client } = makeRemoteChannel(false);
    await register(rc).catch(() => {
        /* the case above owns that failure */
    });
    await flush(10);

    // "must not claim online", not "must not write status": writing 'offline'
    // here is better than writing nothing, because a row left over from a
    // crashed run would otherwise stay online until the sweep ages it out.
    assert.ok(
        !client.statusWritesBeforeJoin.includes('online'),
        `the row claimed ${JSON.stringify(client.statusWritesBeforeJoin)} before the channel was ` +
            'even subscribed. The hosted service selects dispatch targets by `status`, so for that ' +
            'whole window it hands calls to a device with no delivery path and fails them fast.'
    );
});

// Presence only feeds the dashboard: doorbells arrive over the joined channel,
// and dispatch reads the row. A join whose presence is never acknowledged is
// therefore ready — on 2026-10-13 that state took tool calls down fleet-wide.
await test('a joined channel whose presence is never acknowledged is still ready', async () => {
    const { rc, client } = makeRemoteChannel(true, { presenceAcks: false });

    await register(rc);
    await flush(10);

    assert.strictEqual(client.statusWrites.at(-1), 'online',
        `the row ended ${JSON.stringify(client.statusWrites)}, so the server never picks a device ` +
            'whose only failure is the dashboard signal');
});

// The join is not the end of it: it only matters once the row records it, and
// Supabase reports a refused write in the result rather than by throwing. A
// device that joined but cannot record it is in the same place as one that
// never joined — the server will not dispatch to it.
await test('a device whose readiness write is refused is not ready', async () => {
    const { rc, client } = makeRemoteChannel(true, { failOnlineWrite: true });

    await assert.rejects(
        () => register(rc),
        (error) => {
            assert.ok(
                error instanceof ChannelUnreachableError,
                `expected a recoverable channel failure, got ${error.name}`
            );
            return true;
        },
        'registerDevice() resolved although the status write was refused. The channel ' +
            'joined, so the device believes it is ready, while the row never said online — ' +
            'and the server sends it nothing.'
    );
    await flush(10);

    // Not ready, so only a readiness retry may claim online, not the heartbeat.
    const before = client.statusWrites.length;
    await rc.updateHeartbeat();
    assert.equal(
        client.statusWrites.length,
        before,
        `the heartbeat wrote ${JSON.stringify(client.statusWrites.slice(before))} over a join whose own ` +
            'status write was refused'
    );
});

// The heartbeat does not go through createChannel(): it decides on its own,
// from isReachable(), whether to assert `status: 'online'`. So while the join's
// own write is in flight the device must not yet count as reachable — otherwise
// the heartbeat's 'online' queues behind that write and lands even if it is refused.
await test('the heartbeat cannot advertise online while readiness is still being written', async () => {
    const { rc, client } = makeRemoteChannel(true, { holdOnlineWrite: true });

    const registration = register(rc); // parks inside the join's status write
    registration.catch(() => { /* never settles here */ });
    await client.onlineWriteIssued.promise;
    const queued = rc.statusWriteChain;

    // Not awaited: a write queued behind the held one never settles.
    rc.updateHeartbeat().catch(() => { /* logged inside */ });
    await flush(10);

    assert.equal(
        rc.statusWriteChain,
        queued,
        "the heartbeat queued an 'online' behind the join's own status write, which is still in " +
            'flight; it would land even if that write is refused'
    );
});

// The catch in device.ts keeps the process alive and promises a background
// retry. That promise only holds for a channel that can come back: a missing
// row or a failed lookup happens before the recreation parameters are stored,
// so nothing in the process can repair it, and it must stay fatal as before.
await test('a missing device row is a startup failure, not a retryable channel fault', async () => {
    const { rc } = makeRemoteChannel(true, { deviceExists: false });

    await assert.rejects(
        () => register(rc),
        (error) => {
            assert.notEqual(
                error.name,
                'ChannelUnreachableError',
                `a missing device was reported as ${error.name}, which device.ts treats as ` +
                    'recoverable — it would print "Retrying in the background" over a process ' +
                    'that has no way to retry, instead of failing startup'
            );
            return true;
        }
    );
});

out(`\ndevice readiness requires the channel: ${failures} failing test(s).`);
exitProcess(failures ? 1 : 0);
