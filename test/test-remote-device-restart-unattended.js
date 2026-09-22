#!/usr/bin/env node

/**
 * The question DC-695 (#695) was opened to answer: after the refresh token
 * rotates and the service restarts, does the device come back on its own?
 *
 * Every other case in this repo answers a smaller version of it - a second
 * `new MCPDevice()` reading a file the first one wrote, inside one process.
 * That models a restart; it is not one. Here each start is a real child
 * process with its own memory, its own module graph and nothing but
 * `device.json` carried between them, and the server's view of which refresh
 * tokens are still live is a file too, so a token spent in one process is
 * spent for the next.
 *
 * The browser path is trapped rather than mocked away: any run that reaches
 * DeviceAuthenticator prints BROWSER_REQUIRED and exits 2. On the reporters'
 * headless servers that path is the failure - it prints a device code nobody
 * can type and dies fifteen minutes later, which under systemd Restart=always
 * is the loop they described.
 *
 * The second case is the control: with the rotation-to-disk wiring removed -
 * 0.2.50 - the same three steps must demand a browser. Without it a pass here
 * would prove only that the harness can start a device.
 *
 * The third case has no such control, and passes with the wiring either way:
 * the pair GoTrue mints during setSession reaches disk through the save at the
 * end of start(), which 0.2.50 had too. What it pins is narrower and still
 * worth pinning - that an access token past its hour neither stops the device
 * coming up nor leaves a spent token behind for the next restart.
 *
 * Standalone:
 *   npm run build && node test/test-remote-device-restart-unattended.js
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENARIO = fileURLToPath(new URL('./helpers/unattended-restart-scenario.js', import.meta.url));

/**
 * How long one start may take. A device that is going to come up does it in
 * about a second; this is only here so that a child which never exits fails
 * this file instead of hanging the whole suite behind it.
 */
const SCENARIO_DEADLINE_MS = 60_000;

/** A whole device start, in a process of its own. */
function runScenario(env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCENARIO], {
            env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let timedOut = false;
        const deadline = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, SCENARIO_DEADLINE_MS);

        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('close', (code) => {
            clearTimeout(deadline);
            const result = timedOut
                ? 'TIMEOUT'
                : (out.match(/^RESULT: (\w+)$/m) || [])[1] ?? 'NO_RESULT';
            resolve({ code, result, out });
        });
    });
}

let failures = 0;
async function test(name, fn) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dc-695-restart-'));
    try {
        await fn({
            config: path.join(dir, 'device.json'),
            ledger: path.join(dir, 'ledger.json'),
        });
        console.log(`✅ PASS  ${name}`);
    } catch (error) {
        failures++;
        console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** A device that was authorized once, and the server's matching ledger. */
function seed({ config, ledger }) {
    writeFileSync(ledger, JSON.stringify({
        current: { access: 'access-1', refresh: 'refresh-1' },
        spent: [],
    }, null, 2));
    writeFileSync(config, JSON.stringify({
        deviceId: 'device-1',
        session: { access_token: 'access-1', refresh_token: 'refresh-1' },
    }, null, 2));
}

const summarise = (r) => `${r.result} (exit ${r.code})`;

/**
 * An access token shaped like the ones in the issue, where the timings were
 * read off iat and exp: an hour of life, rotated at forty-five minutes. Only
 * the payload matters here - nothing in the device verifies a signature.
 */
function mintAccessToken({ issuedMinutesAgo, lifetimeMinutes = 60 }) {
    const iat = Math.floor(Date.now() / 1000) - issuedMinutesAgo * 60;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iat, exp: iat + lifetimeMinutes * 60 })}.sig`;
}

await test('a device restarts unattended after its refresh token has rotated', async (paths) => {
    seed(paths);
    const env = { DC_CONFIG: paths.config, DC_LEDGER: paths.ledger };

    // Up once, then the 45-minute refresh rotates the pair and the process ends
    // - a package upgrade, a watchdog, an operator, anything that restarts it.
    const first = await runScenario({ ...env, DC_ROTATE: '1' });
    assert.strictEqual(first.result, 'READY', `precondition: the first start must come up - ${summarise(first)}\n${first.out}`);

    // Nothing of the first process survives but the two files.
    const second = await runScenario(env);

    assert.strictEqual(
        second.result, 'READY',
        'the restart could not use what was on disk and reached for a browser, which on an ' +
        `unattended host is where it stays - ${summarise(second)}\n${second.out}`
    );
});

await test('control: without the rotation reaching disk, the restart does demand a browser', async (paths) => {
    seed(paths);
    const env = { DC_CONFIG: paths.config, DC_LEDGER: paths.ledger, DC_PERSIST_ROTATION: '0' };

    const first = await runScenario({ ...env, DC_ROTATE: '1' });
    assert.strictEqual(first.result, 'READY', `precondition: the first start must come up - ${summarise(first)}\n${first.out}`);

    const second = await runScenario(env);

    assert.strictEqual(
        second.result, 'BROWSER_REQUIRED',
        'with 0.2.50 wiring the restart still came up, so this scenario is not testing what it ' +
        `claims and the case above proves nothing - ${summarise(second)}\n${second.out}`
    );
});

await test('an access token past its hour is spent for a new pair, and the restart still needs no browser', async (paths) => {
    // Seventy-five minutes since the device was authorized, so the hour-long
    // access token on disk is fifteen minutes dead. The refresh token is still
    // good, which is the whole point: GoTrue will trade it for a new pair.
    const expired = mintAccessToken({ issuedMinutesAgo: 75 });
    writeFileSync(paths.ledger, JSON.stringify({
        current: { access: expired, refresh: 'refresh-1' },
        spent: [],
    }, null, 2));
    writeFileSync(paths.config, JSON.stringify({
        deviceId: 'device-1',
        session: { access_token: expired, refresh_token: 'refresh-1' },
    }, null, 2));

    const env = { DC_CONFIG: paths.config, DC_LEDGER: paths.ledger };

    // The expired token is spent for a new pair during setSession, before the
    // device is even up. That rotation is one a restart never announced.
    const first = await runScenario(env);
    assert.strictEqual(first.result, 'READY', `the expired access token stopped the device coming up - ${summarise(first)}
${first.out}`);

    // The boundary was actually crossed, not stepped over: the server retired
    // exactly one refresh token while the device was starting. Without this the
    // case would pass just as well against a token that never expired.
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    assert.deepStrictEqual(
        ledger.spent, ['refresh-1'],
        'setSession did not spend the refresh token, so the expired access token was never the ' +
        'thing under test here'
    );

    const persisted = JSON.parse(readFileSync(paths.config, 'utf8'));
    assert.notStrictEqual(
        persisted.session?.refresh_token, 'refresh-1',
        'the refresh token spent inside setSession is still the one on disk, so the next restart ' +
        'replays it and GoTrue answers "Invalid Refresh Token: Already Used"'
    );

    // And once more, which is where replaying a spent token would show.
    const second = await runScenario(env);
    assert.strictEqual(
        second.result, 'READY',
        `the second restart past the token's life needed a browser - ${summarise(second)}
${second.out}`
    );
});

await test('a start whose config cannot be written says so instead of passing for behaviour', async (paths) => {
    seed(paths);
    // A file where the config's directory should be: the save fails at mkdir,
    // on every platform, without needing permissions to be arranged.
    const blocked = path.join(path.dirname(paths.config), 'blocked');
    writeFileSync(blocked, 'not a directory');

    const run = await runScenario({
        DC_CONFIG: paths.config,
        DC_LEDGER: paths.ledger,
        DC_BREAK_WRITES: path.join(blocked, 'device.json'),
    });

    assert.strictEqual(
        run.result, 'WRITE_FAILED',
        'the child could not write its config and did not say so, so an environment fault - EPERM ' +
        `on rename is intermittent here - reads as a verdict about restarting - ${summarise(run)}
${run.out}`
    );
});

console.log(`\n${failures ? '🔴' : '✅'} remote unattended restart: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
