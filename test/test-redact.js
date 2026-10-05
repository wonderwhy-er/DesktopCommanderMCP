#!/usr/bin/env node

/**
 * redact() is the one masker the remote diagnostics pass every line through:
 * the device log (remote.log) and `remote --report`. A planted secret of each
 * kind it covers must never come out of it, and a plain status line must come
 * out unchanged.
 *
 * Kinds: JWTs (eyJ…), access_token / refresh_token / apikey / password values
 * after `=` or `:` (query strings, JSON, prose), `Bearer …`, emails, UUIDs, the
 * home folder (→ `~`), the user name and the host name.
 *
 * The test sets its own temporary HOME / USERPROFILE before loading the module:
 * main's runner gives tests no temporary home, and redact() reads os.homedir().
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-redact.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-redact-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

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

function finish() {
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${failures ? '🔴' : '✅'} redact: ${failures} failing test(s).`);
    process.exit(failures ? 1 : 0);
}

let redact;
try {
    ({ redact } = await import('../dist/remote-device/diagnostics/redact.js'));
} catch (error) {
    failures++;
    console.error(`🔴 FAIL  redact.js loads\n     ${error.message}`);
    finish();
}

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwbGFudGVkLXN1YmplY3QifQ.c2lnbmF0dXJlLXBsYW50ZWQtMTIz';
const UUID = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const EMAIL = 'planted.person+tag@example.co.uk';

/** Fails naming the secret and the output it leaked into. */
function assertGone(output, secret, what) {
    assert(!output.toLowerCase().includes(secret.toLowerCase()), `${what} came out: ${JSON.stringify(output)}`);
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

await test('the home folder\'s real path becomes ~ too (on macOS the temp folder is under a symlink)', () => {
    const real = fs.realpathSync(home);
    const out = redact(`${real}${path.sep}.nvm${path.sep}node`);
    assert.strictEqual(out, `~${path.sep}.nvm${path.sep}node`);
});

await test('the home folder is matched as a whole path, not inside a longer one', () => {
    for (const input of [`/backup${home.replace(/\\/g, '/')}/x`, `${home}-other${path.sep}x`, `${home}lt${path.sep}x`]) {
        const out = redact(input);
        assert(!out.includes('~'), `${JSON.stringify(input)} became ${JSON.stringify(out)}`);
    }
});

await test('the user name and the host name are masked', () => {
    const user = os.userInfo().username;
    const host = os.hostname();
    const out = redact(`owner ${user} on ${host}`);
    if (user.length >= 3) assertGone(out, user, 'the user name');
    if (host.length >= 3) assertGone(out, host, 'the host name');
});

await test('a plain status line comes out unchanged', () => {
    const line = "Channel subscribed (recovered after 2 attempts) — socket=open(1) ch=joined attempt=0";
    assert.strictEqual(redact(line), line);
    const debug = "Channel reads 'joined' but no confirmed heartbeat in 81s - forcing recreate — socket=open(1) ch=joined attempt=3";
    assert.strictEqual(redact(debug), debug);
});

finish();
