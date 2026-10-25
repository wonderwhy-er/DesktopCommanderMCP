#!/usr/bin/env node
// Device-flow polling must stop on a terminal answer from the server
// (access_denied, expired_token, ...) instead of silently polling until the
// code expires, while still retrying genuinely transient failures.
import assert from 'node:assert/strict';
import { DeviceAuthenticator } from '../dist/remote-device/device-authenticator.js';

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() },
    });
}

function deviceAuth() {
    return {
        device_code: 'device-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://example.test/verify',
        verification_uri_complete: 'https://example.test/verify?user_code=ABCD-1234',
        expires_in: 50, // 10 attempts at interval 5
        interval: 5,
    };
}

function makeAuth(responses) {
    const events = [];
    let calls = 0;
    const auth = new DeviceAuthenticator('https://mcp.example.test', {
        capture: async (event, properties = {}) => { events.push({ event, properties }); },
        fetch: async () => {
            const next = responses[Math.min(calls, responses.length - 1)];
            calls++;
            if (next instanceof Error) throw next;
            return typeof next === 'function' ? next() : next;
        },
    });
    auth.sleep = async () => {}; // no real waiting in tests
    return { auth, events, calls: () => calls };
}

async function testDeniedStopsImmediately() {
    const { auth, events, calls } = makeAuth([
        () => json(400, { error: 'authorization_pending' }),
        () => json(400, { error: 'access_denied', error_description: 'User denied the request' }),
    ]);
    await assert.rejects(() => auth.pollForAuthorization(deviceAuth(), 'verifier'), /User denied the request/);
    assert.equal(calls(), 2, 'must stop on the first terminal answer');
    assert.deepEqual(events.map((e) => e.event), ['remote_device_auth_failed']);
    assert.equal(events[0].properties.error_code, 'access_denied');
}

async function testExpiredStopsImmediately() {
    const { auth, calls } = makeAuth([() => json(400, { error: 'expired_token' })]);
    await assert.rejects(() => auth.pollForAuthorization(deviceAuth(), 'verifier'), /expired_token/);
    assert.equal(calls(), 1);
}

async function testTransientFailuresAreRetried() {
    const { auth, calls } = makeAuth([
        new Error('ECONNRESET'),
        () => new Response('<html>Bad gateway</html>', { status: 502 }),
        () => json(503, { error: 'server_error' }),
        () => json(200, { access_token: 'at', refresh_token: 'rt', device_id: 'dev-1' }),
    ]);
    const session = await auth.pollForAuthorization(deviceAuth(), 'verifier');
    assert.equal(calls(), 4);
    assert.deepEqual(session, { device_id: 'dev-1', access_token: 'at', refresh_token: 'rt' });
}

async function testNetworkErrorOnLastAttemptThrows() {
    const { auth, events, calls } = makeAuth([new Error('offline')]);
    await assert.rejects(() => auth.pollForAuthorization(deviceAuth(), 'verifier'), /offline/);
    assert.equal(calls(), 10);
    assert.deepEqual(events.map((e) => e.event), ['remote_device_auth_network_error']);
}

async function testPendingUntilTimeout() {
    const { auth, events, calls } = makeAuth([() => json(400, { error: 'authorization_pending' })]);
    await assert.rejects(() => auth.pollForAuthorization(deviceAuth(), 'verifier'), /Authorization timeout/);
    assert.equal(calls(), 10);
    assert.deepEqual(events.map((e) => e.event), ['remote_device_auth_timeout']);
}

await testDeniedStopsImmediately();
await testExpiredStopsImmediately();
await testTransientFailuresAreRetried();
await testNetworkErrorOnLastAttemptThrows();
await testPendingUntilTimeout();

console.log('PASS remote device auth polling');
