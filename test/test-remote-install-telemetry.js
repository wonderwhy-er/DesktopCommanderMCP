#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DeviceAuthenticator } from '../dist/remote-device/device-authenticator.js';

function recorder() {
    const events = [];
    return {
        events,
        capture: async (event, properties = {}) => {
            events.push({ event, properties });
        },
    };
}

function clock(...values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

function authResponse() {
    return {
        device_code: 'device-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://example.test/verify',
        verification_uri_complete: 'https://example.test/verify?user_code=ABCD-1234',
        expires_in: 600,
        interval: 5,
    };
}
async function testSuccessfulDeviceStart() {
    const telemetry = recorder();
    let request;
    const authenticator = new DeviceAuthenticator('https://mcp.example.test', {
        capture: telemetry.capture,
        monotonicNow: clock(1000, 1123),
        fetch: async (url, init) => {
            request = { url, init };
            return new Response(JSON.stringify(authResponse()), {
                status: 200,
                headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() },
            });
        },
    });

    const result = await authenticator.requestDeviceCode('challenge', 'existing-device');

    assert.equal(request.url, 'https://mcp.example.test/device/start');
    assert.equal(JSON.parse(request.init.body).device_id, 'existing-device');
    assert.equal(result.user_code, 'ABCD-1234');
    assert.deepEqual(telemetry.events.map((x) => x.event), [
        'remote_device_auth_request_started',
        'remote_device_auth_code_received',
    ]);
    assert.deepEqual(telemetry.events[1].properties, {
        duration_ms: 123,
        has_existing_device_id: true,
    });
}
async function testInitialNetworkFailure() {
    const telemetry = recorder();
    const authenticator = new DeviceAuthenticator('https://mcp.example.test', {
        capture: telemetry.capture,
        monotonicNow: clock(2000, 2456),
        fetch: async () => { throw new Error('dns lookup failed'); },
    });

    await assert.rejects(
        () => authenticator.requestDeviceCode('challenge'),
        /dns lookup failed/,
    );

    assert.deepEqual(telemetry.events.map((x) => x.event), [
        'remote_device_auth_request_started',
        'remote_device_auth_request_network_error',
    ]);
    assert.equal(telemetry.events[1].properties.duration_ms, 456);
    assert.equal(telemetry.events[1].properties.has_existing_device_id, false);
}
async function testInitialHttpFailure() {
    const telemetry = recorder();
    const authenticator = new DeviceAuthenticator('https://mcp.example.test', {
        capture: telemetry.capture,
        monotonicNow: clock(3000, 3075),
        fetch: async () => new Response(
            JSON.stringify({ error_description: 'service unavailable' }),
            { status: 503, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } },
        ),
    });

    await assert.rejects(
        () => authenticator.requestDeviceCode('challenge'),
        /service unavailable/,
    );

    assert.deepEqual(telemetry.events.map((x) => x.event), [
        'remote_device_auth_request_started',
        'remote_device_auth_request_failed',
    ]);
    assert.equal(telemetry.events[1].properties.duration_ms, 75);
}
async function flushPromises() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

async function testBrowserLaunchTelemetry() {
    const success = recorder();
    const successAuth = new DeviceAuthenticator('https://mcp.example.test', {
        capture: success.capture,
        open: async () => undefined,
    });
    successAuth.displayUserInstructions(authResponse());
    await flushPromises();
    assert.deepEqual(success.events.map((x) => x.event), [
        'remote_device_browser_launch_succeeded',
    ]);

    const failure = recorder();
    const failureAuth = new DeviceAuthenticator('https://mcp.example.test', {
        capture: failure.capture,
        open: async () => { throw new Error('no browser'); },
    });
    failureAuth.displayUserInstructions(authResponse());
    await flushPromises();
    assert.deepEqual(failure.events.map((x) => x.event), [
        'remote_device_browser_launch_failed',
    ]);
    assert.match(failure.events[0].properties.error.message, /no browser/);
}
await testSuccessfulDeviceStart();
await testInitialNetworkFailure();
await testInitialHttpFailure();
await testBrowserLaunchTelemetry();

console.log('PASS remote install telemetry behavior');
