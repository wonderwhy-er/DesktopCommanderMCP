#!/usr/bin/env node

/**
 * Regression test for DC-622 (#622): a device whose clock is skewed must have
 * that skew corrected BEFORE the freshly issued session is handed to auth-js.
 *
 * GoTrueClient.setSession judges a token against the device's own clock:
 *
 *     const timeNow = Date.now() / 1000;
 *     expiresAt = payload.exp;
 *     hasExpired = expiresAt <= timeNow;
 *     if (hasExpired) { ...refresh... }
 *
 * There is no skew tolerance, so a device running ahead treats a token issued
 * one second ago as expired and refreshes a brand-new session instead of using
 * it — which is what "successful device verification returns terminated
 * Supabase session" looks like from the outside.
 *
 * PR #629 (v0.2.48) added the cure: clockAwareFetch reads the `Date` header off
 * each Supabase response and observeServerDate() corrects Date.now for the
 * process. But it is wired only into the Supabase client, and on the startup
 * path nothing reaches that client until setSession() itself:
 *
 *     fetchSupabaseConfig()  -> GET  /api/mcp-info    plain fetch, Date ignored
 *     DeviceAuthenticator    -> POST /device/start    plain fetch, Date ignored
 *                            -> POST /device/poll     plain fetch, Date ignored
 *     setSession()           -> GoTrue                first clockAwareFetch call
 *
 * Every one of those responses carries a `Date` header from a correctly-synced
 * server, and every one is thrown away. The correction therefore lands one step
 * after the call that needed it.
 *
 * These cases assert the wiring, not the arithmetic — observeServerDate itself
 * is covered in test-remote-channel-reconnect.js. Everything runs against a
 * local HTTP server; no network, no browser, no Supabase.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-clock-skew-before-session.js
 */
import assert from 'node:assert';
import http from 'node:http';
import { observeServerDate } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

/** Well past CLOCK_SKEW_CORRECTION_THRESHOLD_MS (5 min), so a correction is due. */
const SERVER_AHEAD_MS = 3 * 60 * 60 * 1000;

/** Slack for the round trip between reading Date.now() and comparing it. */
const TOLERANCE_MS = 60 * 1000;

/**
 * A stand-in for mcp.desktopcommander.app that answers the three startup hops
 * and stamps every response with a `Date` header three hours ahead of this
 * machine — the shape of a device whose own clock lags.
 */
function startServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('Date', new Date(Date.now() + SERVER_AHEAD_MS).toUTCString());
        res.setHeader('Content-Type', 'application/json');

        if (req.url === '/api/mcp-info') {
            res.end(JSON.stringify({
                supabaseUrl: 'https://example.supabase.co',
                supabasePublishableKey: 'test-anon-key'
            }));
            return;
        }
        if (req.url === '/device/start') {
            res.end(JSON.stringify({
                device_code: 'test-device-code',
                user_code: 'TEST-CODE',
                verification_uri: 'https://example.invalid/verify',
                verification_uri_complete: 'https://example.invalid/verify?code=TEST-CODE',
                expires_in: 600,
                interval: 0.05
            }));
            return;
        }
        if (req.url === '/device/poll') {
            res.end(JSON.stringify({
                access_token: 'test-access-token',
                refresh_token: 'test-refresh-token',
                device_id: 'test-device-id',
                expires_in: 3600
            }));
            return;
        }
        res.statusCode = 404;
        res.end('{}');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

/** Undo any correction a previous case left in place. */
function resetClock() {
    observeServerDate(new Date().toUTCString());
}

/** True once observeServerDate has shifted this process onto server time. */
function clockWasCorrected() {
    return Math.abs(Date.now() - (realNow() + SERVER_AHEAD_MS)) < TOLERANCE_MS;
}

const realNow = Date.now.bind(Date); // captured before anything patches Date.now

let failures = 0;
async function test(name, fn) {
    try {
        resetClock();
        await fn();
        console.log(`✅ PASS  ${name}`);
    } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
    } finally {
        resetClock();
    }
}

const { server, url } = await startServer();
process.env.MCP_SERVER_URL = url;

// Imported after MCP_SERVER_URL is set: MCPDevice reads it in its constructor.
const { MCPDevice } = await import('../dist/remote-device/device.js');
const { DeviceAuthenticator } = await import('../dist/remote-device/device-authenticator.js');

await test('fetchSupabaseConfig() corrects a skewed clock from the response Date', async () => {
    const device = new MCPDevice();
    await device.fetchSupabaseConfig();
    assert(
        clockWasCorrected(),
        'the very first startup request already carries a correctly-synced Date header; ' +
        'ignoring it leaves auth-js to judge the fresh token on a wrong clock'
    );
});

await test('the authorization poll corrects a skewed clock before the session is used', async () => {
    const authenticator = new DeviceAuthenticator(url);
    const deviceAuth = {
        device_code: 'test-device-code',
        user_code: 'TEST-CODE',
        verification_uri: 'https://example.invalid/verify',
        expires_in: 600,
        interval: 0.05
    };
    // Called directly: authenticate() would open a browser.
    const session = await authenticator.pollForAuthorization(deviceAuth, 'test-verifier');

    assert.strictEqual(session.access_token, 'test-access-token', 'precondition: the poll must succeed');
    assert(
        clockWasCorrected(),
        'the response that delivers the session states the server time; the clock must be ' +
        'right before that session reaches setSession()'
    );
});

server.close();
console.log(`\n${failures ? '🔴' : '✅'} remote clock skew before session: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
