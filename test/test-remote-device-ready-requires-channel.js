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
 * The refusal is `not_broadcast_capable` in the hosted tool-call processor: the
 * device row says `status: 'online'`, so dispatch picks it, but the row carries
 * no `transport_broadcast_v1` capability, so the call cannot be delivered and
 * is failed fast with "has no live connection ... Restart the terminal".
 * Restarting lands in the same state, which is exactly what the reporter saw.
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
 * createChannel() already resolves only once presence lands, and says why:
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
    failCapabilityWrite = false; // does the capability write reach the row?
    holdCapabilityWrite = false; // leave the capability write in flight, forever
    /** Resolves once the capability write has been issued and is hanging. */
    capabilityWriteIssued = deferred();
    deviceExists = true; // is there a row for this device id at all?
    statusWritesBeforeJoin = null;

    /** True once a write advertised the capability dispatch requires. */
    advertisedBroadcast() {
        return this.writes.some((w) => w.capabilities?.transport_broadcast_v1 === true);
    }

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
                if (updates.capabilities?.transport_broadcast_v1 === true) {
                    if (client.failCapabilityWrite) {
                        result = { data: null, error: { message: 'capability write refused' } };
                    }
                    if (client.holdCapabilityWrite) {
                        // A PATCH that is simply slow. Everything the device does
                        // in this window happens while the row still has no
                        // capability recorded.
                        result = new Promise(() => {});
                        client.capabilityWriteIssued.resolve();
                    }
                }
                return node;
            },
            insert: () => node,
            eq: () => node,
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

// The join is only half of what dispatch needs: the server refuses the call
// without the capability, and the capability is written only once presence is
// published. A join whose presence is never acknowledged therefore produces
// exactly the state measured in production — the row online, the capability
// explicitly withdrawn — and it is the likelier of the two, because it happens
// AFTER a successful join rather than instead of one.
await test('a joined channel whose presence is never acknowledged is not ready', async () => {
    const { rc, client } = makeRemoteChannel(true, { presenceAcks: false });

    await assert.rejects(
        () => register(rc),
        'registerDevice() resolved after presence failed. The channel is joined but the device ' +
            'never published itself, so the capability is withdrawn and the hosted service ' +
            'refuses every call — while the user is told the device is ready.'
    );
    await flush(10);

    assert.ok(
        !client.statusWrites.includes('online'),
        `the row claimed ${JSON.stringify(client.statusWrites)} although presence never landed; ` +
            'dispatch selects by `status`, so this is the row that gets the undeliverable calls'
    );
    assert.ok(
        !client.advertisedBroadcast(),
        'precondition: the capability must stay withdrawn when presence fails'
    );
});

// Presence landing is not the end of it: it only matters because it writes the
// capability, and Supabase reports a refused write in the result rather than by
// throwing. A device that publishes presence but cannot record it is in the same
// place as one that never published — the server will not dispatch to it.
await test('a device whose readiness write is refused is not ready', async () => {
    const { rc, client } = makeRemoteChannel(true, { failCapabilityWrite: true });

    await assert.rejects(
        () => register(rc),
        (error) => {
            assert.ok(
                error instanceof ChannelUnreachableError,
                `expected a recoverable channel failure, got ${error.name}`
            );
            return true;
        },
        'registerDevice() resolved although the capability write was refused. Presence was ' +
            'published, so the device believes it is ready, while the row carries neither the ' +
            'capability nor online — and the server refuses every call to it.'
    );
    await flush(10);

    assert.ok(
        !client.statusWrites.includes('online'),
        `the row claimed ${JSON.stringify(client.statusWrites)} although its capability never landed`
    );
});

// The heartbeat does not go through createChannel(): it decides on its own,
// from isReachable(), whether to assert `status: 'online'`. So the readiness
// sequence is not the only writer, and while it is still in flight the device
// must not yet count as reachable — otherwise a heartbeat firing in that window
// publishes online over a row whose capability has not landed, which is the
// state this file exists to forbid. Reported on #724 by wonderwhy-er, who
// reproduced it by holding the capability PATCH pending.
await test('the heartbeat cannot advertise online while readiness is still being written', async () => {
    const { rc, client } = makeRemoteChannel(true, { holdCapabilityWrite: true });

    const registration = register(rc); // parks inside the capability write
    registration.catch(() => { /* never settles here; the case below owns it */ });
    await client.capabilityWriteIssued.promise;

    await rc.updateHeartbeat(DEVICE_ID);

    assert.ok(
        !client.statusWrites.includes('online'),
        `the heartbeat wrote ${JSON.stringify(client.statusWrites)} while the capability write was ` +
            'still in flight. For that window the row is online with no transport capability — the ' +
            'exact state the server refuses as not_broadcast_capable.'
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
process.exitCode = failures ? 1 : 0;
