#!/usr/bin/env node

/**
 * Regression test for DC-661 (#661): a rotated refresh token must reach the
 * persisted device config, so a restart does not demand browser authorization.
 *
 * The connector refreshes its Supabase session on a 45-minute cadence. auth-js
 * rotates the refresh token on every refresh and emits TOKEN_REFRESHED, and
 * RemoteChannel reacts by re-authorizing the realtime socket and updating
 * `lastKnownSession` — in memory only:
 *
 *     remote-channel.ts  TOKEN_REFRESHED -> realtime.setAuth() + lastKnownSession
 *     device.ts          savePersistedConfig() — called once, during start()
 *
 * Nothing carries a rotation to disk. `~/.desktop-commander-device/device.json`
 * therefore keeps whichever refresh token the process started with, and after a
 * few hours that token has been spent several times over. On the next restart
 * the device loads it, GoTrue refuses a reused token, and an unattended machine
 * sits waiting for someone to complete a browser flow. Reproduced independently
 * on Linux and Windows against 0.2.47/0.2.48.
 *
 * Both cases drive the real RemoteChannel and MCPDevice against a fake Supabase
 * client and a temp config file — no network, no browser, no Supabase.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-token-rotation-persisted.js
 */
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCPDevice } from '../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';

/**
 * Stands in for the Supabase client. It owns a `currentSession` the way auth-js
 * does, so a rotation changes what getSession() reports — which is exactly what
 * savePersistedConfig() reads when it decides what to write.
 */
function makeFakeClient() {
    let currentSession = null;
    let authListener = null;

    return {
        auth: {
            setSession: async ({ access_token, refresh_token }) => {
                currentSession = { access_token, refresh_token };
                return { data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null };
            },
            getSession: async () => ({ data: { session: currentSession }, error: null }),
            onAuthStateChange: (cb) => {
                authListener = cb;
                return { data: { subscription: { unsubscribe() { } } } };
            },
        },
        realtime: { setAuth: () => { } },

        /** What the 45-minute refresh does: rotate, then announce it. */
        rotate(access_token, refresh_token) {
            currentSession = { access_token, refresh_token };
            authListener?.('TOKEN_REFRESHED', currentSession);
        },
    };
}

/** A device wired to a fake client and a throwaway config file. */
async function makeDevice(configPath) {
    const device = new MCPDevice();
    device.deviceId = DEVICE_ID;
    device.configPath = configPath;

    const client = makeFakeClient();
    device.remoteChannel.client = client; // private in TS, plain property at runtime

    // Registers the TOKEN_REFRESHED listener, as start() does.
    await device.remoteChannel.setSession({ access_token: 'access-1', refresh_token: 'refresh-1' });
    // start() persists exactly here, once, and never again.
    await device.savePersistedConfig();

    return { device, client };
}

const readPersisted = (configPath) => JSON.parse(readFileSync(configPath, 'utf8'));

/** Let the un-awaited auth callback and anything it starts settle. */
const settle = () => new Promise((r) => setTimeout(r, 100));

let failures = 0;
async function test(name, fn) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dc-661-'));
    try {
        await fn(path.join(dir, 'device.json'));
        console.log(`✅ PASS  ${name}`);
    } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

await test('a rotated refresh token reaches the persisted config', async (configPath) => {
    const { client } = await makeDevice(configPath);
    assert.strictEqual(
        readPersisted(configPath).session.refresh_token, 'refresh-1',
        'precondition: startup persists the token it was given'
    );

    client.rotate('access-2', 'refresh-2');
    await settle();

    assert.strictEqual(
        readPersisted(configPath).session.refresh_token, 'refresh-2',
        'the rotation stayed in memory; disk still holds a refresh token that has already been spent'
    );
});

await test('a restart loads the rotated token, not the one the process started with', async (configPath) => {
    const { client } = await makeDevice(configPath);
    client.rotate('access-2', 'refresh-2');
    await settle();

    // A fresh process reading the same config file — what a restart does.
    const restarted = new MCPDevice();
    restarted.configPath = configPath;
    const loaded = await restarted.loadPersistedConfig();

    assert.ok(loaded, 'the restart must find a persisted session');
    assert.strictEqual(
        loaded.refresh_token, 'refresh-2',
        'the restart replays a spent refresh token, so GoTrue refuses it and the device demands browser authorization'
    );
});

console.log(`\n${failures ? '🔴' : '✅'} remote token rotation persistence: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
