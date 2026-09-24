#!/usr/bin/env node

/**
 * Regression test: when the local Desktop Commander child dies mid tool call,
 * the in-flight call must fail immediately — not after the MCP SDK's 60 second
 * default request timeout.
 *
 * DC-633 / PR #598 taught the remote device to notice a dead local child by
 * assigning `transport.onclose` and `transport.onerror` AFTER
 * `client.connect()`. But `Protocol.connect()` wraps those same two callbacks,
 * and the SDK documents that "The Protocol object assumes ownership of the
 * Transport, replacing any callbacks that have already been set". Assigning over
 * them drops the SDK's wrapper, so `Protocol._onclose()` never runs — and that
 * is the only place pending responses are rejected with ConnectionClosed.
 *
 * The call that was in flight when the child died therefore waits out
 * DEFAULT_REQUEST_TIMEOUT_MSEC (60_000) and comes back "Request timed out"
 * instead of failing in well under a second. That is the issue #658 shape
 * exactly: the oversized response kills the child DURING the call, so the call
 * left hanging is the very one that caused the crash.
 *
 * Cases:
 *   - a call in flight when the child dies rejects fast, not at the 60s timeout
 *   - it rejects with the SDK's ConnectionClosed, not some other immediate error
 *   - the disconnect is reported to the device via onDisconnect()
 *   - the next call still works — PR #598's restart path must stay intact
 *   - a protocol-level error on a HEALTHY child is not mistaken for a disconnect
 *
 * That last case guards the widened blast radius of moving the hooks onto the
 * client: Protocol.onerror fires for eleven non-fatal conditions the transport's
 * own onerror never saw (a response for an unknown message id, an unknown
 * progress token, a failed cancellation send, ...). Treating those as death
 * would take a working device offline and respawn a live child.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-inflight-call-fast-fail.js
 */
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'dying-mcp-server.js');

/** Must match CRASH_TOOL in test/fixtures/dying-mcp-server.js. */
const CRASH_TOOL = 'crash-mid-call';

/** Must match NOISE_TOOL in test/fixtures/dying-mcp-server.js. */
const NOISE_TOOL = 'protocol-noise';

/** ErrorCode.ConnectionClosed from the MCP SDK. */
const CONNECTION_CLOSED = -32000;

/**
 * A connection-closed rejection lands in milliseconds. The SDK's default
 * request timeout is 60s, so anything in between is unambiguous.
 */
const FAST_FAIL_LIMIT_MS = 5_000;

/**
 * Cap the wait so a red run reports in 15s instead of sitting through the whole
 * 60s timeout on every `npm test`.
 */
const WATCHDOG_MS = 15_000;

/**
 * Point the spawn at the fixture instead of dist/index.js. This is the only
 * thing the subclass changes — supervision, readiness and restart are the real
 * production code under test.
 */
class FixtureIntegration extends DesktopCommanderIntegration {
    /** initialize() calls this exactly once per spawned child. */
    spawns = 0;

    async resolveMcpConfig() {
        this.spawns++;
        return { command: process.execPath, args: [FIXTURE], cwd: __dirname };
    }
}

/**
 * Marker for a call the watchdog cut off. It is NOT a rejection from the SDK —
 * the call is still pending — so assertions about *why* a call failed must
 * refuse to pass on it rather than read the watchdog's own message.
 */
const STILL_PENDING = Symbol('still-pending');

/** Race a promise against a deadline without leaving the loser unhandled. */
function withWatchdog(promise, ms) {
    promise.catch(() => { }); // the losing side must not become an unhandled rejection
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(STILL_PENDING), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function callAndMeasure(integration, toolName) {
    const started = Date.now();
    try {
        const result = await withWatchdog(integration.callClientTool(toolName, {}), WATCHDOG_MS);
        return { rejected: false, result, elapsedMs: Date.now() - started };
    } catch (error) {
        if (error === STILL_PENDING) {
            return { rejected: false, stillPending: true, elapsedMs: Date.now() - started };
        }
        return { rejected: true, error, elapsedMs: Date.now() - started };
    }
}

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

// --- a protocol-level error must not look like a dead child --------------
// Runs on its own child, before anything is deliberately crashed.
const healthy = new FixtureIntegration();
const healthyDisconnects = [];
healthy.onDisconnect((reason) => healthyDisconnects.push(reason));
await healthy.initialize();
const noisy = await callAndMeasure(healthy, NOISE_TOOL);
// Let a mistaken disconnect and the restart it triggers actually land.
await new Promise((r) => setTimeout(r, 500));
const healthySpawns = healthy.spawns;
const healthyStillReady = healthy.ready;
await healthy.shutdown().catch(() => { });

// --- the child dies mid-call ---------------------------------------------
const integration = new FixtureIntegration();
const disconnectReasons = [];
integration.onDisconnect((reason) => disconnectReasons.push(reason));
await integration.initialize();

// One crash drives every assertion below, so the child is killed exactly once.
const crashed = await callAndMeasure(integration, CRASH_TOOL);
const recovered = await callAndMeasure(integration, 'healthy-tool');

console.log(
    `
in-flight call settled after ${(crashed.elapsedMs / 1000).toFixed(1)}s ` +
    `(budget ${FAST_FAIL_LIMIT_MS / 1000}s, SDK default request timeout 60s)` +
    `
  rejection: ${crashed.error?.code ?? '-'} ${crashed.error?.message ?? '(none)'}
`
);

await test('a call in flight when the local child dies rejects fast', async () => {
    assert(
        !crashed.stillPending,
        `still hanging ${(crashed.elapsedMs / 1000).toFixed(1)}s after the child died; the caller ` +
        `must learn the worker is gone in under ${FAST_FAIL_LIMIT_MS / 1000}s, not wait out the ` +
        `SDK's 60s request timeout`
    );
    assert(crashed.rejected, 'the call must reject once the child is gone, not resolve');
    assert(
        crashed.elapsedMs < FAST_FAIL_LIMIT_MS,
        `took ${(crashed.elapsedMs / 1000).toFixed(1)}s, over the ${FAST_FAIL_LIMIT_MS / 1000}s budget`
    );
});

await test('it rejects with ConnectionClosed, not a timeout or some other error', async () => {
    assert(crashed.rejected, 'no rejection to inspect — the call never failed on its own');
    const message = crashed.error?.message ?? String(crashed.error);
    assert(
        !/timed out|timeout/i.test(message),
        `a timeout hides the real cause from the user: ${message}`
    );
    // Excluding timeouts alone would pass on any immediate rejection, including
    // a wrong one. Pin the SDK's code rather than its wording, which moves
    // between versions.
    assert(
        crashed.error?.code === CONNECTION_CLOSED,
        `expected ConnectionClosed (${CONNECTION_CLOSED}), got ${crashed.error?.code}: ${message}`
    );
});

await test('the disconnect is reported to the device', async () => {
    assert(
        disconnectReasons.length > 0,
        'onDisconnect must fire so the device can stop advertising itself as online'
    );
});

await test('the next call still works (PR #598 restart path intact)', async () => {
    assert(!recovered.rejected, `restart failed: ${recovered.error?.message}`);
    const text = JSON.stringify(recovered.result);
    assert(/fixture-ok/.test(text), `expected a real result from the restarted child, got ${text}`);
});

await test('a protocol error on a healthy child is not treated as a disconnect', async () => {
    assert(!noisy.rejected, `the call itself must still succeed: ${noisy.error?.message}`);
    assert.deepStrictEqual(
        healthyDisconnects, [],
        `a live child was reported dead: ${healthyDisconnects.join('; ')}`
    );
    assert.strictEqual(healthySpawns, 1, `the child was respawned ${healthySpawns - 1} time(s) for nothing`);
    assert(healthyStillReady, 'the integration must still be ready after harmless protocol noise');
});

await integration.shutdown().catch(() => { });

console.log(`\n${failures ? '🔴' : '✅'} remote in-flight fast-fail: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
