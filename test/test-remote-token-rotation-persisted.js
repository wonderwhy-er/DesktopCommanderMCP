#!/usr/bin/env node

/**
 * Regression test for DC-661 (#661): a refresh token rotated by auth-js must
 * reach device.json, or a restart hours later replays a spent one and an
 * unattended device sits waiting for a browser. Runs against
 * ./helpers/remote-device-harness.js - no network, no browser, no Supabase.
 */
import assert from 'node:assert';
import { mkdirSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    MCPDevice,
    makeDevice,
    drainWrites,
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

/** EPERM on the commit, the way Windows raises it while something holds the destination. */
function refuseRename(times) {
    const real = fsp.rename;
    let left = times;
    fsp.rename = async (from, to) => {
        if (left-- > 0) {
            const error = new Error('EPERM: operation not permitted, rename');
            error.code = 'EPERM';
            throw error;
        }
        return real(from, to);
    };
    return () => { fsp.rename = real; };
}

await test('a commit refused once still lands the rotation', async (configPath) => {
    const { device, client } = await makeDevice(configPath);
    const restore = refuseRename(1);
    try {
        client.rotate('access-2', 'refresh-2');
        await drainWrites(device);
    } finally {
        restore();
    }

    assert.strictEqual(
        readPersisted(configPath).session?.refresh_token, 'refresh-2',
        'one EPERM on the commit drops the rotation, so disk keeps a token the server has already ' +
        'spent and the next restart asks for a browser - the failure this PR exists to stop'
    );
});

await test('a commit the filesystem keeps refusing leaves the old config and no temp file', async (configPath) => {
    const { device, client } = await makeDevice(configPath);
    const restore = refuseRename(Infinity);
    try {
        client.rotate('access-2', 'refresh-2');
        await drainWrites(device);
    } finally {
        restore();
    }

    assert.deepStrictEqual(
        readdirSync(path.dirname(configPath)).filter((f) => f.endsWith('.tmp')), [],
        'the temp file outlives the failed commit, holding a session beside the config it never replaced'
    );
    assert.strictEqual(
        readPersisted(configPath).session?.refresh_token, 'refresh-1',
        'a refused commit must leave the previous config exactly as it was'
    );
});

finish();
