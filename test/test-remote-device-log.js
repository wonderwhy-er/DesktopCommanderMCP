#!/usr/bin/env node

/**
 * The remote device log (~/.desktop-commander-device/remote-<day>.log): the
 * device's history that `remote --report` packs. `remote` passes the device's
 * console output through it. Every line is written, with a UTC timestamp and
 * masked by redact(); only the private kinds are dropped. Each UTC weekday has
 * its own files: remote-mon.log rotates at 1 MB into remote-mon.1.log and
 * remote-mon.2.log. The first write on a weekday whose files are over a day old
 * (last week's) removes them first, so the log never holds more than 21 files.
 *
 * The private kinds, each printed here as the device prints it, with a planted
 * secret that must be nowhere in the log:
 * - tool calls: the tool's name and whether it succeeded stay; its arguments,
 *   metadata, results and error details go;
 * - the user's email in the ready block;
 * - the sign-in link and code;
 * - error objects dumped whole: only their name and message stay (a spawn
 *   error's `spawnargs` carry the session tokens).
 *
 * Debug lines are kept even without --debug, while the terminal stays exactly
 * as before: a console.debug that `remote` silenced prints nothing.
 *
 * The test sets its own temporary HOME / USERPROFILE: main's runner gives tests
 * no temporary home, and the log's default folder is under os.homedir().
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-device-log.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-device-log-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const MB = 1024 * 1024;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ {2}/;

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
    console.log(`\n${failures ? '🔴' : '✅'} remote device log: ${failures} failing test(s).`);
    process.exit(failures ? 1 : 0);
}

let deviceLog;
try {
    deviceLog = await import('../dist/remote-device/diagnostics/device-log.js');
} catch (error) {
    failures++;
    console.error(`🔴 FAIL  device-log.js loads\n     ${error.message}`);
    finish();
}
const { DeviceLog, startDeviceLog, getDeviceLogDir, DEVICE_LOG_FILES, deviceLogName, deviceLogNames } = deviceLog;

let dirCount = 0;
function freshDir() {
    return fs.mkdtempSync(path.join(home, `log-${++dirCount}-`));
}

/** A log file's text; by default the folder's one current-day file (remote-<day>.log), whatever the day. */
function readLog(dir, name) {
    if (name === undefined) {
        const today = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^remote-[a-z]{3}\.log$/.test(f)) : [];
        assert(today.length <= 1, `one current-day file expected, found: ${today.join(', ')}`);
        name = today[0];
        if (!name) return '';
    }
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

const DAY_MS = 24 * 60 * 60 * 1000;
// A Monday (UTC), so its files are remote-mon.*
const MONDAY = Date.parse('2026-10-05T10:00:00Z');
/** A clock the test moves: the log takes its time from it. */
function clockAt(ms) {
    const clock = { ms, now: () => clock.ms };
    return clock;
}

/** Fails naming the secret and the log it leaked into. */
function assertAbsent(text, secret, what) {
    assert(!text.includes(secret), `${what} reached the log:\n${text}`);
}

const DEVICE_ID = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const EMAIL = 'planted.person@example.com';

await test('the log folder defaults to ~/.desktop-commander-device', () => {
    assert.strictEqual(getDeviceLogDir(), path.join(home, '.desktop-commander-device'));
});

await test('lines are kept, one per line, with a UTC timestamp and without the leading emoji', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record(['✅ Channel subscribed (recovered after 1 attempt) — socket=open(1) ch=joined attempt=0']);
    log.record(['⏱️ Channel subscription timed out, Reconnecting... — socket=open(1) ch=errored attempt=1']);
    log.record(['🔌 Device marked as offline']);
    log.record(['   - 🔌 Connected to Remote MCP']);
    const lines = readLog(dir).trimEnd().split('\n');
    assert.strictEqual(lines.length, 4, `4 lines expected:\n${lines.join('\n')}`);
    for (const line of lines) assert.match(line, TIMESTAMP, `timestamped: ${line}`);
    assert.match(lines[0], /Z {2}Channel subscribed \(recovered after 1 attempt\) — socket=open\(1\)/);
    assert.match(lines[1], /Z {2}Channel subscription timed out/);
    assert.match(lines[2], /Z {2}Device marked as offline$/);
    assert.match(lines[3], /Z {2}Connected to Remote MCP$/);
});

await test('every other line is kept too, masked: no list of known lines', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record(['│ Return to ChatGPT or Claude and continue your conversation.']);
    log.record(['⏳ Subscribing to tool call channel...']);
    log.record([`👋 Presence tracked (device ${DEVICE_ID} visible as online)`]);
    log.record([`[DEBUG] Creating channel: user:${DEVICE_ID}`]);
    log.record([` - ⏳ Connecting to Local Desktop Commander MCP using: ${process.execPath} ${path.join(home, 'dist', 'index.js')}`]);
    const text = readLog(dir);
    assert.match(text, /Z {2}│ Return to ChatGPT or Claude and continue your conversation\.\n/);
    assert.match(text, /Z {2}Subscribing to tool call channel\.\.\.\n/);
    assert.match(text, /Z {2}Presence tracked \(device <id> visible as online\)\n/);
    assert.match(text, /Z {2}Creating channel: user:<id>\n/);
    assert.match(text, /Z {2}Connecting to Local Desktop Commander MCP using: /);
    assertAbsent(text, DEVICE_ID, 'the device id');
    assertAbsent(text, home, 'the home folder');
});

await test('tool calls keep the tool name and the outcome; arguments, metadata, results and errors go', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record([`🔧 Received tool call call-1: read_file {"path":"C:/planted-arg/plan.txt"} metadata: {"conversation":"planted-meta"}`]);
    log.record([`✅ Tool call read_file completed:\r\n {"content":[{"type":"text","text":"planted-result"}]}`]);
    log.record([`❌ Tool call write_file failed:`, 'EACCES planted-error-detail']);
    log.record(['[DEBUG] Calling MCP tool:', 'start_search', 'args:', JSON.stringify({ pattern: 'planted-debug-arg' }).substring(0, 100)]);
    log.record(['Error executing tool start_search:', new Error('planted-tool-error')]);
    log.record(['[DEBUG] Tool call error details:', new Error('planted-error-object')]);
    const text = readLog(dir);
    for (const secret of ['planted-arg', 'planted-meta', 'planted-result', 'planted-error-detail', 'planted-debug-arg', 'planted-tool-error', 'planted-error-object']) {
        assertAbsent(text, secret, secret);
    }
    assert.match(text, /Z {2}Received tool call call-1: read_file\n/);
    assert.match(text, /Z {2}Tool call read_file completed\n/);
    assert.match(text, /Z {2}Tool call write_file failed\n/);
    assert.match(text, /Z {2}Calling MCP tool: start_search\n/);
    assert.match(text, /Z {2}Error executing tool start_search\n/);
});

await test('an empty, spaced or colon tool name still drops the arguments, results and error details', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    const names = { empty: '', spaced: 'read file', colon: 'a:b' };
    for (const [tag, name] of Object.entries(names)) {
        // As device.ts and desktop-commander-integration.ts print them
        log.record([`🔧 Received tool call call-${tag}: ${name} {"path":"planted-${tag}-arg"} metadata: {"m":"planted-${tag}-meta"}`]);
        log.record([`✅ Tool call ${name} completed:\r\n {"content":"planted-${tag}-result"}`]);
        log.record([`❌ Tool call ${name} failed:`, `planted-${tag}-error-detail`]);
        log.record(['[DEBUG] Calling MCP tool:', name, 'args:', JSON.stringify({ pattern: `planted-${tag}-debug-arg` })]);
        log.record([`Error executing tool ${name}:`, new Error(`planted-${tag}-tool-error`)]);
    }
    const text = readLog(dir);
    for (const tag of Object.keys(names)) {
        for (const what of ['arg', 'meta', 'result', 'error-detail', 'debug-arg', 'tool-error']) {
            assertAbsent(text, `planted-${tag}-${what}`, `the ${tag} name's ${what}`);
        }
    }
    assert.match(text, /Z {2}Received tool call call-empty:\n/, text);
    assert.match(text, /Z {2}Tool call completed\n/);
    assert.match(text, /Z {2}Tool call failed\n/);
    assert.match(text, /Z {2}Calling MCP tool\n/);
    assert.match(text, /Z {2}Error executing tool\n/);
    assert.match(text, /Z {2}Tool call read file completed\n/, 'a name with a space is kept');
    assert.match(text, /Z {2}Tool call a:b completed\n/, 'a name with a colon is kept');
    assert.match(text, /Z {2}Tool call a:b failed\n/);
    assert.match(text, /Z {2}Calling MCP tool: a:b\n/);
});

await test('a tool result with a line inside cannot smuggle it in', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record([`✅ Tool call read_file completed:\r\n✅ Channel subscribed leaked-file-content`]);
    log.record(['\n⚠️  Remote session expired and could not be renewed.']);
    const text = readLog(dir);
    assertAbsent(text, 'leaked-file-content', 'a line of the result');
    assert.match(text, /Z {2}Remote session expired and could not be renewed\.\n/, `a leading newline is fine:\n${text}`);
});

await test('the ready block keeps everything but the email', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record(['✅ Device ready:']);
    log.record([`   - User:         ${EMAIL}`]);
    log.record([`   - Device ID:    ${DEVICE_ID}`]);
    log.record([`[DEBUG] Session set successfully, user: ${EMAIL}`]);
    const text = readLog(dir);
    assertAbsent(text, EMAIL, 'the email');
    assertAbsent(text, 'planted.person', 'the email local part');
    assert.match(text, /Z {2}Device ready:\n/);
    assert.doesNotMatch(text, /Z {2}User:/, 'the User line goes');
    assert.match(text, /Z {2}Device ID: +<id>\n/);
});

await test('the sign-in link and code never reach it, as the authenticator prints them', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record(['📋 Please complete authentication:\n']);
    log.record(['   1. Verify this device in your browser:']);
    log.record(['      https://mcp.desktopcommander.app/device?user_code=PLNT-CODE\n']);
    log.record(['   2. Make sure the code matches:']);
    log.record(['      PLNT-CODE\n']);
    log.record(['   Code expires in 10 minutes.\n']);
    log.record(['   - Could not open browser automatically.']);
    log.record(['   - Please visit: https://mcp.desktopcommander.app/device?user_code=PLNT-CODE\n']);
    log.record(['   - ⏳ Waiting for authorization...\n']);
    const text = readLog(dir);
    assertAbsent(text, 'PLNT-CODE', 'the code');
    assertAbsent(text, 'user_code', 'the sign-in link');
    assert.match(text, /Z {2}1\. Verify this device in your browser:\n/);
    assert.match(text, /Z {2}2\. Make sure the code matches:\n/);
    assert.match(text, /Z {2}Code expires in 10 minutes\.\n/);
    assert.match(text, /Z {2}Waiting for authorization\.\.\.\n/);
});

await test('an error object is written as its name and message only: a spawn error\'s arguments carry tokens', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    const spawnError = Object.assign(new Error('spawnSync node ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        spawnargs: ['script.js', DEVICE_ID, 'https://x.supabase.co', 'sb_publishable_PLANTEDkey', 'eyJplanted.access.token', 'plantedRefresh99'],
    });
    log.record(['[DEBUG] spawn error:', spawnError]);
    const text = readLog(dir);
    for (const secret of ['plantedRefresh99', 'PLANTEDkey', 'eyJ', 'spawnargs']) assertAbsent(text, secret, secret);
    assert.match(text, /Z {2}spawn error: Error: spawnSync node ETIMEDOUT\n/);
});

await test('kept lines are masked', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir });
    log.record([`❌ Channel error: refresh failed access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln for ${EMAIL} — socket=closed(3) ch=errored attempt=2`]);
    log.record([`💾 Found persisted session for device ${DEVICE_ID}`]);
    const text = readLog(dir);
    assertAbsent(text, 'eyJ', 'a JWT');
    assertAbsent(text, EMAIL, 'the email');
    assertAbsent(text, DEVICE_ID, 'the device id');
    assert.match(text, /Z {2}Channel error: refresh failed/);
    assert.match(text, /Z {2}Found persisted session for device <id>\n/);
});

await test('the files are named by UTC weekday: remote-mon.log, remote-mon.1.log, remote-mon.2.log; 21 names in all', () => {
    assert.strictEqual(DEVICE_LOG_FILES, 3);
    assert.deepStrictEqual([0, 1, 2].map((i) => deviceLogName(1, i)), ['remote-mon.log', 'remote-mon.1.log', 'remote-mon.2.log']);
    assert.deepStrictEqual([0, 6].map((day) => deviceLogName(day, 0)), ['remote-sun.log', 'remote-sat.log']);
    const names = deviceLogNames();
    assert.strictEqual(names.length, 21);
    assert.strictEqual(new Set(names).size, 21, 'no name twice');
});

await test('it writes to the current UTC weekday\'s file, with the line timestamped by the same clock', () => {
    const dir = freshDir();
    const clock = clockAt(MONDAY);
    new DeviceLog({ dir, now: clock.now }).record(['✅ Channel subscribed']);
    assert.deepStrictEqual(fs.readdirSync(dir), ['remote-mon.log']);
    assert.match(readLog(dir, 'remote-mon.log'), /^2026-10-05T10:00:00Z {2}Channel subscribed\n$/);
});

await test('within a day it rotates at 1 MB and, past the last file, keeps exactly DEVICE_LOG_FILES files, oldest last', () => {
    const dir = freshDir();
    const log = new DeviceLog({ dir, now: clockAt(MONDAY).now });
    const filler = 'x'.repeat(900);
    let written = 0;
    // Enough for DEVICE_LOG_FILES + 2 files: the rotation runs past the last file twice
    for (let i = 0; written < (DEVICE_LOG_FILES + 1.6) * MB; i++) {
        log.record([`❌ Channel error: n${String(i).padStart(6, '0')} ${filler}`]);
        written += 950;
    }
    log.record(['✅ Channel subscribed (the newest line)']);
    const expected = Array.from({ length: DEVICE_LOG_FILES }, (_, i) => deviceLogName(1, i));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [...expected].sort(), `files: ${fs.readdirSync(dir).join(', ')}`);
    for (const name of expected) {
        const size = fs.statSync(path.join(dir, name)).size;
        assert(size <= MB, `${name} is ${size} bytes, over 1 MB`);
        assert(size > MB / 2 || name === deviceLogName(1, 0), `${name} holds a full file's worth: ${size} bytes`);
    }
    assert.match(readLog(dir), /Channel subscribed \(the newest line\)\n$/, 'the newest line is at the end of remote-mon.log');
    // Each older file starts with older lines: n… grows from the last file to remote-mon.log's predecessor
    const first = (name) => Number(readLog(dir, name).match(/n(\d{6})/)[1]);
    for (let i = 1; i < DEVICE_LOG_FILES - 1; i++) {
        assert(first(deviceLogName(1, i + 1)) < first(deviceLogName(1, i)), `${deviceLogName(1, i + 1)} holds older lines than ${deviceLogName(1, i)}`);
    }
});

await test('a new day starts its own file; the day before stays as it was', () => {
    const dir = freshDir();
    const clock = clockAt(MONDAY);
    const log = new DeviceLog({ dir, now: clock.now });
    log.record(['✅ Monday line']);
    clock.ms = MONDAY + DAY_MS;
    log.record(['✅ Tuesday line']);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['remote-mon.log', 'remote-tue.log']);
    assert.match(readLog(dir, 'remote-mon.log'), /Z {2}Monday line\n$/);
    assert.match(readLog(dir, 'remote-tue.log'), /^2026-10-06T10:00:00Z {2}Tuesday line\n$/);
});

await test('the first write on a weekday removes that weekday\'s files from last week, and only those', () => {
    const dir = freshDir();
    const lastWeek = new Date(MONDAY - 7 * DAY_MS);
    for (const name of [deviceLogName(1, 0), deviceLogName(1, 1), deviceLogName(1, 2)]) {
        fs.writeFileSync(path.join(dir, name), `2026-09-28T10:00:00Z  last week (${name})\n`);
        fs.utimesSync(path.join(dir, name), lastWeek, lastWeek);
    }
    // Tuesday's file from 6 days ago belongs to another weekday: it stays
    const sixDaysAgo = new Date(MONDAY - 6 * DAY_MS);
    fs.writeFileSync(path.join(dir, 'remote-tue.log'), '2026-09-29T10:00:00Z  last Tuesday\n');
    fs.utimesSync(path.join(dir, 'remote-tue.log'), sixDaysAgo, sixDaysAgo);
    new DeviceLog({ dir, now: clockAt(MONDAY).now }).record(['✅ This Monday']);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['remote-mon.log', 'remote-tue.log'], 'remote-mon.1.log and .2.log are gone');
    assert.match(readLog(dir, 'remote-mon.log'), /^2026-10-05T10:00:00Z {2}This Monday\n$/, 'last week\'s lines are gone');
    assert.match(readLog(dir, 'remote-tue.log'), /last Tuesday/);
});

await test('a weekday\'s files under a day old are kept: a device started again the same day appends', () => {
    const dir = freshDir();
    const earlierToday = new Date(MONDAY - 2 * 60 * 60 * 1000);
    fs.writeFileSync(path.join(dir, 'remote-mon.log'), '2026-10-05T08:00:00Z  earlier today\n');
    fs.utimesSync(path.join(dir, 'remote-mon.log'), earlierToday, earlierToday);
    new DeviceLog({ dir, now: clockAt(MONDAY).now }).record(['✅ After a restart']);
    assert.match(readLog(dir, 'remote-mon.log'), /earlier today\n.*Z {2}After a restart\n$/s);
});

await test('two weeks of daily rotation never leave more than 21 files, all of them the fixed names', () => {
    const dir = freshDir();
    // Small files so each day rotates past its last file; the clock starts now, as the files' times do
    const clock = clockAt(Date.now());
    const log = new DeviceLog({ dir, now: clock.now, maxBytes: 300 });
    for (let d = 0; d < 14; d++) {
        clock.ms += DAY_MS;
        for (let i = 0; i < 20; i++) log.record([`❌ Channel error: day ${d} line ${i} ${'x'.repeat(60)}`]);
        assert(fs.readdirSync(dir).length <= 21, `day ${d}: ${fs.readdirSync(dir).length} files`);
    }
    const files = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(files, [...deviceLogNames()].sort(), `files: ${files.join(', ')}`);
    // The oldest week is gone: every file holds lines from the last 7 days only
    for (const name of files) assert.doesNotMatch(readLog(dir, name), /day [0-6] line/, `${name} still holds the first week`);
});

await test('startDeviceLog: the terminal is unchanged, and silenced debug lines still reach the log', () => {
    const dir = freshDir();
    const saved = { log: console.log, debug: console.debug, warn: console.warn, error: console.error, info: console.info };
    const printed = [];
    const realWrite = process.stdout.write;
    const realErrWrite = process.stderr.write;
    let stop;
    try {
        // What `remote` does without --debug, before it starts the log
        console.debug = () => { };
        process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return true; };
        process.stderr.write = (chunk, ...rest) => { printed.push(String(chunk)); return true; };
        stop = startDeviceLog({ dir });
        console.log('✅ Channel subscribed');
        console.debug(`[DEBUG] ⚠️ Channel reads 'joined' but no confirmed heartbeat in 81s - forcing recreate — socket=open(1) ch=joined attempt=0`);
        console.debug('[DEBUG] Reconnect backoff: 1200ms');
        console.log(`🔧 Received tool call c-2: list_directory {"path":"/secret"} metadata: {}`);
        console.error('❌ Presence track not acknowledged (timed out) — attempt 1/3');
    } finally {
        stop?.();
        process.stdout.write = realWrite;
        process.stderr.write = realErrWrite;
        Object.assign(console, saved);
    }
    assert.deepStrictEqual(printed, [
        '✅ Channel subscribed\n',
        `🔧 Received tool call c-2: list_directory {"path":"/secret"} metadata: {}\n`,
        '❌ Presence track not acknowledged (timed out) — attempt 1/3\n',
    ], 'the terminal shows exactly what it showed before');
    const text = readLog(dir);
    assert.match(text, /Z {2}Channel subscribed\n/);
    assert.match(text, /Z {2}Channel reads 'joined' but no confirmed heartbeat in 81s/);
    assert.match(text, /Z {2}Reconnect backoff: 1200ms\n/);
    assert.match(text, /Z {2}Received tool call c-2: list_directory\n/);
    assert.match(text, /Z {2}Presence track not acknowledged \(timed out\) — attempt 1\/3\n/);
    assertAbsent(text, '/secret', 'a tool argument');
});

await test('stop() puts the console back', () => {
    const dir = freshDir();
    const before = console.log;
    const stop = startDeviceLog({ dir });
    assert.notStrictEqual(console.log, before, 'console.log is wrapped while the log runs');
    stop();
    assert.strictEqual(console.log, before);
});

finish();
