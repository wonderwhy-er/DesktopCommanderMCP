#!/usr/bin/env node

/**
 * RDC-4: a device must be advertised as ready only when it can actually execute.
 *
 * `status` in `mcp_devices` is what the hosted service filters device selection
 * on, so it is a claim: "this device will run a tool call right now". Today that
 * claim is derived from one signal and asserted optimistically.
 *
 * PR #598 taught the device to notice a dead local child, and the happy path was
 * verified live on 0.2.50 on 2026-09-17: kill the stdio child with the channel
 * joined, and the device goes offline, restarts once, returns online only after
 * the child answers, and serves the next call from the new process.
 *
 * The FAILURE path is what these cases cover. Of the six behaviours issue #4
 * requires, three are still missing, and they compose into one loop:
 *
 *   readiness ignores the local half   -> a device whose restart failed is
 *                                         re-advertised online by the heartbeat
 *   restart has no bounded backoff     -> every routed call spawns another child
 *   online is asserted after handshake -> a child that speaks MCP but cannot run
 *                                         a tool is announced as ready
 *
 * Everything here runs against fake Supabase writes and local stdio fixtures —
 * no network, no browser, no Supabase.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-device-readiness.js
 */
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPDevice } from '../dist/remote-device/device.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKEN_TOOLS_FIXTURE = path.join(__dirname, 'fixtures', 'broken-tools-mcp-server.js');
const NO_SUCH_SERVER = path.join(__dirname, 'fixtures', 'this-server-does-not-exist.js');
const WORKING_FIXTURE = path.join(__dirname, 'fixtures', 'dying-mcp-server.js');

/** Generous: the first backoff is ~1-3s, and recovery must land inside it. */
const RECOVERY_DEADLINE_MS = 10_000;

const DEVICE_ID = 'device-1';

/** Records what would have been written to `mcp_devices`. */
function makeFakeClient() {
    const writes = [];
    const chain = {
        update: (payload) => { writes.push(payload); return chain; },
        select: () => chain,
        eq: () => Promise.resolve({ data: null, error: null }),
    };
    return { writes, from: () => chain };
}

/** Points the spawn at a chosen script; everything else is production code. */
class FixtureIntegration extends DesktopCommanderIntegration {
    /** initialize() calls this exactly once per spawned child. */
    spawns = 0;

    constructor(serverPath) {
        super();
        this.serverPath = serverPath;
    }

    /** Let a case make a broken child startable again mid-flight. */
    useServer(serverPath) {
        this.serverPath = serverPath;
    }

    async resolveMcpConfig() {
        this.spawns++;
        return {
            command: process.execPath,
            args: [this.serverPath],
            cwd: __dirname,
            // The SDK inherits the child's stderr by default. These cases break
            // the child on purpose, and its crash trace is indistinguishable
            // from a real failure to anyone reading the output.
            stderr: 'ignore',
        };
    }
}

/**
 * Silence console while a case drives deliberate failures. The production code
 * logs each one with a full stack, which buries the actual result and reads as
 * a broken machine. Borrowed from test-remote-channel-reconnect.js.
 */
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

/**
 * A device wired to a real RemoteChannel and a recording client, so status
 * writes go through the actual predicate instead of a stub that would record
 * whatever it was handed. Both ids matter: MCPDevice reads its own, and
 * queueStatusWrite() reads the channel's.
 */
function makeDevice({ channelState = 'joined' } = {}) {
    const device = new MCPDevice();
    const client = makeFakeClient();
    device.deviceId = DEVICE_ID;
    device.remoteChannel.client = client;
    device.remoteChannel.deviceId = DEVICE_ID;
    device.remoteChannel.channel = { state: channelState };
    return { device, client };
}

const advertisedOnline = (client) => client.writes.filter((w) => w.status === 'online');

/**
 * End a recovery loop a case started but did not let finish. The loop runs
 * `while (!device.isShuttingDown)`, and `desktop.shutdown()` sets the
 * integration's flag, not the device's — so without this the loop keeps
 * rescheduling for the rest of the run. Not device.shutdown(): that reaches
 * setOffline(), which spawnSync's the real offline-update script.
 */
async function stopRecovery(device, recovery) {
    device.isShuttingDown = true;
    await recovery;
}

let failures = 0;
async function test(name, fn) {
    try {
        await withQuietLogs(fn);
        console.log(`✅ PASS  ${name}`);
    } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
    }
}

console.log([
    '',
    'RDC-4 readiness. These cases break the local child on purpose, so connection',
    'failures are expected here. The verdict is the PASS/FAIL lines.',
    '',
].join('\n'));

await test('a dead local executor is not advertised online, however healthy the channel', async () => {
    const device = new MCPDevice();
    const client = makeFakeClient();
    device.remoteChannel.client = client;          // private in TS, plain property at runtime
    device.remoteChannel.channel = { state: 'joined' };
    // The restart failed, so the device cannot execute anything.
    device.desktop = { ready: false };

    await device.remoteChannel.updateHeartbeat(DEVICE_ID);

    const advertised = client.writes.filter((w) => w.status === 'online');
    assert.deepStrictEqual(
        advertised, [],
        'the heartbeat only consults the channel, so a device that cannot execute is put back ' +
        'into the server\'s selection pool within one heartbeat interval'
    );
});

await test('repeated restart failures are spaced, not one spawn per call', async () => {
    // A server path that cannot resolve: every connect attempt fails.
    const integration = new FixtureIntegration(NO_SUCH_SERVER);

    for (let i = 0; i < 3; i++) {
        await integration.ensureReady().catch(() => { /* expected */ });
    }

    assert(
        integration.spawns < 3,
        `three back-to-back calls spawned ${integration.spawns} children; a child that crashes on ` +
        'start must not be respawned once per routed tool call'
    );
});

await test('online is withheld until the tool layer answers, not just the handshake', async () => {
    const { device, client } = makeDevice();
    // Connects and speaks MCP, but fails everything at the tool layer.
    device.desktop = new FixtureIntegration(BROKEN_TOOLS_FIXTURE);

    // Not awaited to completion: recovery keeps retrying a child that never
    // becomes usable, which is the intended production behaviour.
    const recovery = device.handleLocalMcpLoss('test');
    await Promise.race([recovery, new Promise((r) => setTimeout(r, RECOVERY_DEADLINE_MS))]);
    await device.remoteChannel.statusWriteChain;
    await stopRecovery(device, recovery);
    await device.desktop.shutdown().catch(() => { });

    assert.deepStrictEqual(
        advertisedOnline(client), [],
        'a completed MCP handshake proves the child speaks the protocol, not that it can run a tool'
    );
});

await test('a device whose restart failed recovers without an incoming tool call', async () => {
    const { device, client } = makeDevice();
    const integration = new FixtureIntegration(NO_SUCH_SERVER);
    device.desktop = integration;

    // Not awaited: recovery has to keep trying on its own.
    const recovery = device.handleLocalMcpLoss('test');

    // The child becomes startable again a moment later — a dependency that came
    // back, a machine that finished waking up.
    await new Promise((r) => setTimeout(r, 150));
    integration.useServer(WORKING_FIXTURE);

    await Promise.race([recovery, new Promise((r) => setTimeout(r, RECOVERY_DEADLINE_MS))]);
    await device.remoteChannel.statusWriteChain;
    await stopRecovery(device, recovery);
    await integration.shutdown().catch(() => { });

    assert(
        advertisedOnline(client).length > 0,
        'the device never came back online after one failed attempt. ' +
        'Verified live on 0.2.50: nothing retries, and the hosted service answers a call for an ' +
        'offline device with "No devices available", so the lazy restart never fires either — ' +
        'the device is stuck until a human restarts the connector'
    );
});

// --- every writer of `status` must consult the same predicate ----------------
// isReachable() is the rule, but it only helps where it is asked. Raised by
// @coderabbitai on #717: two writers reach `mcp_devices.status` without it.

await test('a joined channel does not announce online while the executor is dead', async () => {
    const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
    const rc = new RemoteChannel();
    const client = makeFakeClient();
    const channel = {
        state: 'joined',
        on: () => channel,
        subscribe: (cb) => { setImmediate(() => cb('SUBSCRIBED', null)); return channel; },
        track: async () => 'ok',
    };
    client.channel = () => channel;
    rc.client = client;
    rc._user = { id: 'user-1' };
    rc.deviceId = DEVICE_ID;
    rc.deviceName = 'test-device';
    rc.onToolCall = () => { };
    rc.setLocalExecutorProbe(() => false);   // the local half is dead

    await rc.createChannel();
    await rc.statusWriteChain;

    const advertised = client.writes.filter((w) => w.status === 'online');
    assert.deepStrictEqual(
        advertised, [],
        'the SUBSCRIBED callback writes online directly; a channel coming up says nothing ' +
        'about the executor being able to run a tool'
    );
});

await test('recovery does not announce online while the channel is down', async () => {
    // The remote half is down; the executor recovered fine.
    const { device, client } = makeDevice({ channelState: 'errored' });
    device.desktop = { ready: true, ensureReady: async () => { } };

    await device.handleLocalMcpLoss('test');
    await device.remoteChannel.statusWriteChain;

    const advertised = client.writes.filter((w) => w.status === 'online');
    assert.deepStrictEqual(
        advertised, [],
        'recovery writes online straight through setOnlineStatus, so a device whose channel ' +
        'is not joined is announced as ready — the same one-sided claim this branch removes'
    );
});

console.log(`\n${failures ? '🔴' : '✅'} remote device readiness: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
