#!/usr/bin/env node

/**
 * redact() is the one masker the remote diagnostics pass every line through:
 * the device log (remote-<day>.log) and `remote --report`. A planted secret of each
 * kind it covers must never come out of it, and a plain status line must come
 * out unchanged.
 *
 * Kinds: JWTs (eyJ…), access_token / refresh_token / apikey / password values
 * after `=` or `:` (query strings, JSON, prose), `Bearer …`, emails, UUIDs, the
 * home folder (→ `~`), the user name and the host name.
 *
 * redact() reads os.homedir() on every call, and only reads: the cases use the
 * home the runner gives. One case needs a home that isn't given by its real path,
 * so it sets HOME / USERPROFILE itself for its duration.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-redact.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwbGFudGVkLXN1YmplY3QifQ.c2lnbmF0dXJlLXBsYW50ZWQtMTIz';
const UUID = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const EMAIL = 'planted.person+tag@example.co.uk';

/** Fails naming the secret and the output it leaked into. */
function assertGone(output, secret, what) {
    assert(!output.toLowerCase().includes(secret.toLowerCase()), `${what} came out: ${JSON.stringify(output)}`);
}

async function runTests() {
    const { redact } = await import('../dist/remote-device/diagnostics/redact.js');
    const failures = [];

    async function test(name, fn) {
        try {
            console.log(`${await fn() === SKIPPED ? '- skipped:' : '✅ PASS '} ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
        }
    }

    await test('a JWT is masked, alone and inside a sentence', () => {
        const out = redact(`session refresh failed for token ${JWT} (expired)`);
        assertGone(out, 'eyJ', 'the JWT');
        assertGone(out, 'c2lnbmF0dXJlLXBsYW50ZWQtMTIz', 'the JWT signature');
        assert(out.includes('session refresh failed for token'), `the text around it is kept: ${out}`);
    });

    await test('access_token / refresh_token / apikey / password values are masked after = and :', () => {
        const cases = [
            ['query string', 'GET /realtime/v1/websocket?apikey=sb_publishable_PLANTEDkey123&vsn=1.0.0', 'sb_publishable_PLANTEDkey123'],
            ['JSON', '{"access_token":"plantedAccessValue1","refresh_token":"plantedRefreshValue2"}', 'plantedAccessValue1'],
            ['JSON, second key', '{"access_token":"plantedAccessValue1","refresh_token":"plantedRefreshValue2"}', 'plantedRefreshValue2'],
            ['prose with a colon', 'login failed, password: hunter2planted', 'hunter2planted'],
            ['key=value', 'retrying with refresh_token=plantedRefreshValue3 now', 'plantedRefreshValue3'],
            ['upper case key', 'APIKEY=PlantedUpperKey9', 'PlantedUpperKey9'],
        ];
        for (const [what, input, secret] of cases) {
            assertGone(redact(input), secret, `the ${what} value`);
        }
    });

    await test('a Bearer header value is masked', () => {
        const out = redact('Authorization: Bearer plantedOpaqueBearer.Value-42');
        assertGone(out, 'plantedOpaqueBearer', 'the bearer value');
    });

    await test('an email is masked', () => {
        const out = redact(`Session set successfully, user: ${EMAIL}`);
        assertGone(out, EMAIL, 'the email');
        assertGone(out, 'planted.person', 'the email local part');
    });

    await test('a UUID is masked, in lower and upper case', () => {
        const out = redact(`Presence tracked (device ${UUID} visible as online) user:${UUID.toUpperCase()}`);
        assertGone(out, UUID, 'the UUID');
    });

    await test('the home folder becomes ~, with either slash and JSON-escaped', () => {
        const home = os.homedir();
        const file = path.join(home, 'projects', 'secret-plan.txt');
        const inputs = [
            `ENOENT: no such file or directory, open '${file}'`,
            `open ${file.replace(/\\/g, '/')}`,
            `{"path":${JSON.stringify(file)}}`,
        ];
        for (const input of inputs) {
            const out = redact(input);
            assertGone(out, home, 'the home folder');
            assertGone(out, home.replace(/\\/g, '/'), 'the home folder (forward slashes)');
            assert(out.includes('~'), `the home folder becomes ~: ${out}`);
        }
    });

    // The runner's home is given by its real path, so this case makes a home
    // that isn't: on macOS the temporary folder is under /var, a link to /private/var
    await test('the home folder\'s real path becomes ~ too (on macOS the temp folder is under a symlink)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-redact-home-'));
        const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            assert.strictEqual(os.homedir(), home, 'os.homedir() should follow HOME/USERPROFILE');
            const real = fs.realpathSync(home);
            const out = redact(`${real}${path.sep}.nvm${path.sep}node`);
            assert.strictEqual(out, `~${path.sep}.nvm${path.sep}node`);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    await test('the home folder is matched as a whole path, not inside a longer one', () => {
        const home = os.homedir();
        for (const input of [`/backup${home.replace(/\\/g, '/')}/x`, `${home}-other${path.sep}x`, `${home}lt${path.sep}x`]) {
            const out = redact(input);
            assert(!out.includes('~'), `${JSON.stringify(input)} became ${JSON.stringify(out)}`);
        }
    });

    // redact() leaves a name under 3 characters alone (redact.ts), so such a name can't be checked
    await test('the user name is masked', () => {
        const user = os.userInfo().username;
        if (user.length < 3) return skip('the user name is under 3 characters, which redact() leaves alone');
        assertGone(redact(`owner ${user} here`), user, 'the user name');
    });

    await test('the host name is masked', () => {
        const host = os.hostname();
        if (host.length < 3) return skip('the host name is under 3 characters, which redact() leaves alone');
        assertGone(redact(`running on ${host} now`), host, 'the host name');
    });

    await test('a plain status line comes out unchanged', () => {
        const line = "Channel subscribed (recovered after 2 attempts) — socket=open(1) ch=joined attempt=0";
        assert.strictEqual(redact(line), line);
        const debug = "Channel reads 'joined' but no confirmed heartbeat in 81s - forcing recreate — socket=open(1) ch=joined attempt=3";
        assert.strictEqual(redact(debug), debug);
    });

    console.log(`\n${failures.length ? '🔴' : '✅'} redact: ${failures.length} failing test(s).`);
    return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
