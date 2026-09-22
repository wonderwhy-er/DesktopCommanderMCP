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
 * Persisting on every rotation raises three questions the first version of this
 * fix did not answer, all raised in review on #710:
 *
 *   - a rotation landing as the process exits must not be dropped on the floor
 *   - two saves in flight must not let a slow earlier one overwrite a newer one
 *   - a write that cannot complete must not destroy the config that was there
 *
 * Everything drives the real RemoteChannel and MCPDevice against a fake Supabase
 * client and a temp config file — no network, no browser, no Supabase. The fake
 * snapshots its session at call time and can delay the reply, which is how a
 * slow save is modelled deterministically instead of with a sleep.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-token-rotation-persisted.js
 */
import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import {
    MCPDevice,
    makeDevice,
    readPersisted,
    sleep,
    waitForPersisted,
    createRunner,
} from './helpers/remote-device-harness.js';

const tokenIs = (want) => (config) => config?.session?.refresh_token === want;

const { test, finish } = createRunner('remote token rotation persistence', 'dc-661-');

await test('a rotated refresh token reaches the persisted config', async (configPath) => {
    const { client } = await makeDevice(configPath);
    assert.strictEqual(
        readPersisted(configPath).session.refresh_token, 'refresh-1',
        'precondition: startup persists the token it was given'
    );

    client.rotate('access-2', 'refresh-2');
    const config = await waitForPersisted(configPath, tokenIs('refresh-2'));

    assert.strictEqual(
        config?.session?.refresh_token, 'refresh-2',
        'the rotation stayed in memory; disk still holds a refresh token that has already been spent'
    );
});

await test('a restart loads the rotated token, not the one the process started with', async (configPath) => {
    const { client } = await makeDevice(configPath);
    client.rotate('access-2', 'refresh-2');
    await waitForPersisted(configPath, tokenIs('refresh-2'));

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

await test('a rotation landing as the process exits is not lost', async (configPath) => {
    const { device, client } = await makeDevice(configPath);

    // The save is in flight when teardown begins.
    client.delaySaves(300);
    client.rotate('access-2', 'refresh-2');
    await device.shutdown();

    assert.strictEqual(
        readPersisted(configPath).session.refresh_token, 'refresh-2',
        'shutdown finished while the write was still in flight, so the rotation was dropped ' +
        'and the next start replays a spent token'
    );
});

await test('a slow save cannot overwrite a newer one', async (configPath) => {
    const { client } = await makeDevice(configPath);

    // First save reads refresh-2 then stalls; second reads refresh-3 and is quick.
    client.delaySaves(300, 0);
    client.rotate('access-2', 'refresh-2');
    client.rotate('access-3', 'refresh-3');

    await waitForPersisted(configPath, tokenIs('refresh-3'));
    await sleep(500); // let the stalled save land, if it is going to

    assert.strictEqual(
        readPersisted(configPath).session.refresh_token, 'refresh-3',
        'the stalled earlier save overtook the newer one and persisted a token that is already spent'
    );
});

await test('a write that cannot complete leaves the previous config intact', async (configPath) => {
    const { client } = await makeDevice(configPath);

    // Block the temporary file the save commits through, so the write fails
    // after the previous config is already on disk. This pins the mechanism:
    // without a temp file there is nothing to block, the save overwrites the
    // live config directly, and an interruption would leave it truncated.
    mkdirSync(`${configPath}.${process.pid}.tmp`);

    client.rotate('access-2', 'refresh-2');
    await sleep(300);

    const config = readPersisted(configPath); // must still parse
    assert.strictEqual(
        config.session.refresh_token, 'refresh-1',
        'a failed write must leave the previous complete session, never a partial file'
    );
});

await test('a rotation is persisted as announced, even if the session is lost right after', async (configPath) => {
    const { client } = await makeDevice(configPath);

    // The save is queued and slow, so the sign-out lands inside the gap between
    // the rotation being announced and the save reading the session back.
    client.delaySaves(200);
    client.rotate('access-2', 'refresh-2');
    client.signOut();

    await waitForPersisted(configPath, tokenIs('refresh-2'));

    assert.strictEqual(
        readPersisted(configPath).session?.refresh_token, 'refresh-2',
        'the save re-reads the session instead of writing the one TOKEN_REFRESHED handed it, so a ' +
        'sign-out in that gap wipes a good refresh token off disk - and handleSignedOut() then tells ' +
        'the user to restart, which reads the file we just emptied'
    );
});

await test('a save with no session available does not wipe the token on disk', async (configPath) => {
    const { device, client } = await makeDevice(configPath);
    assert.strictEqual(
        readPersisted(configPath).session.refresh_token, 'refresh-1',
        'precondition: a good token is on disk'
    );

    client.signOut();
    await device.savePersistedConfig();

    assert.strictEqual(
        readPersisted(configPath).session?.refresh_token, 'refresh-1',
        'a save that finds no session writes session:null, replacing a usable token with nothing. ' +
        'Clearing is what clearPersistedConfig() is for'
    );
});

finish();
