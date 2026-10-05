#!/usr/bin/env node

/**
 * `desktop-commander remote --report`: one command a user runs to give support
 * a diagnostics zip. It must not start the device and must never open sign-in,
 * so it also works when the user's sign-in is broken.
 *
 * The zip lands in the home folder as desktop-commander-report-<date>.zip and
 * holds report.txt (readable), report.json (the same facts) and device-log/
 * (the remote.log files, masked again). It records versions (npm included),
 * how Node runs (the Node executable and the entry script, the home folder
 * shown as ~, and what kind of install each is), the clock skew read from the
 * server's Date header, network timings to the server, Supabase REST and the
 * realtime websocket, whether Desktop Commander MCP is running right now
 * (count and earliest start, from the process list), the device id and yes/no
 * facts about the rest of device.json, and only telemetryEnabled and clientId
 * from config.json.
 *
 * Everything runs against a local stand-in (HTTP + websocket on a free port):
 * no network. The stand-in's Date header runs 90 s ahead of this machine.
 * Planted secrets (the tokens in device.json, an email, a JWT and the home
 * path in the device log, another setting in config.json, the publishable
 * key) must never appear anywhere in the zip, nor the user name. The device
 * id appears once, in the Device section; inside log lines it stays masked.
 *
 * After saving, the report uploads the zip (unless --no-upload) to
 * DC_DIAGNOSTICS_URL (the runs here point it at the stand-in), else to the
 * diagnosticsUrl that /api/mcp-info names (https only), else to the default
 * address. The upload carries the user id (the saved token's `sub`) and the
 * device id, and the terminal prints the report id; a failure keeps the zip
 * and says "Not sent".
 *
 * The test sets its own temporary HOME / USERPROFILE for the command: main's
 * runner gives tests no temporary home. It never reads the real home folders.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-report.js
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'dist', 'index.js');

const SERVER_AHEAD_S = 90;
const DEVICE_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const USER_ID = '9b2e1c3d-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
// A JWT-shaped access token whose payload's `sub` is the user id (the upload reads it locally)
const ACCESS_TOKEN = [{ alg: 'HS256' }, { sub: USER_ID, exp: 1 }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.cGxhbnRlZC1hY2Nlc3Mtc2ln';
const REFRESH_TOKEN = 'plantedRefreshTokenValue77';
const EMAIL = 'planted.person@example.com';
const PUBLISHABLE_KEY = 'sb_publishable_PLANTEDkey4Report';
const CLIENT_ID = 'client-id-planted-0042';
const OTHER_SETTING = 'other-setting-must-not-appear';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-report-home-'));
const deviceDir = path.join(home, '.desktop-commander-device');
const configDir = path.join(home, '.claude-server-commander');

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

// --- the planted home ---------------------------------------------------------

fs.mkdirSync(deviceDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
const deviceJson = path.join(deviceDir, 'device.json');
fs.writeFileSync(deviceJson, JSON.stringify({
    deviceId: DEVICE_ID,
    session: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN },
}, null, 2));
const savedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
fs.utimesSync(deviceJson, savedAt, savedAt);
fs.mkdirSync(path.join(deviceDir, 'device.json.lock'));
// A log as an older or hand-edited version might have left it: raw secrets in kept lines
fs.writeFileSync(path.join(deviceDir, 'remote.1.log'), [
    '2026-10-01T09:12:00Z  Starting MCP Device...',
    `2026-10-01T09:12:05Z  Channel error: refresh failed for ${EMAIL} token ${ACCESS_TOKEN} — socket=closed(3) ch=errored attempt=1`,
    `2026-10-01T09:12:06Z  Persisted session invalid: ENOENT ${path.join(home, 'secret-project', 'plan.txt')}`,
    `2026-10-01T09:12:07Z  Channel error: device ${DEVICE_ID} not joined — socket=open(1) ch=errored attempt=2`,
].join('\n') + '\n');
fs.writeFileSync(path.join(deviceDir, 'remote.log'), [
    '2026-10-05T14:20:44Z  Device marked as offline',
    `2026-10-05T14:20:45Z  Received tool call c-9: read_file {"path":"planted-tool-arg"}`,
    '2026-10-05T14:21:03Z  Channel subscribed (recovered after 1 attempt) — socket=open(1) ch=joined attempt=0',
].join('\n') + '\n');
const configJson = path.join(configDir, 'config.json');
fs.writeFileSync(configJson, JSON.stringify({
    telemetryEnabled: false,
    clientId: CLIENT_ID,
    allowedDirectories: [path.join(home, 'secret-project')],
    defaultShell: OTHER_SETTING,
}, null, 2));
const deviceJsonBefore = fs.readFileSync(deviceJson);
const deviceJsonMtimeBefore = fs.statSync(deviceJson).mtimeMs;

// --- the stand-in: mcp-info, Supabase REST, realtime websocket -----------------

const requests = [];
// The live Supabase answers 401 to the REST root with only the publishable key. One test sets a 503, and one sends
// the report to a Supabase address nothing listens on (null: this stand-in).
let restStatus = 401;
let supabaseUrl = null;
// mcp-info's diagnosticsUrl (undefined: left out); the runs post to this stand-in through DC_DIAGNOSTICS_URL. The
// upload answers with uploadStatus and this report id.
const DIAGNOSTICS_URL = 'https://diagnostics.example.invalid/';
const REPORT_ID = 'R7KQ2M4X';
let diagnosticsUrl = DIAGNOSTICS_URL;
let uploadStatus = 200;
const uploads = [];
const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, apikey: req.headers.apikey });
    res.setHeader('Date', new Date(Date.now() + SERVER_AHEAD_S * 1000).toUTCString());
    res.setHeader('Content-Type', 'application/json');
    const { pathname } = new URL(req.url, 'http://stand-in');
    if (req.method === 'GET' && pathname === '/api/mcp-info') {
        res.end(JSON.stringify({ supabaseUrl: supabaseUrl ?? baseUrl, supabasePublishableKey: PUBLISHABLE_KEY, diagnosticsUrl }));
        return;
    }
    if (req.method === 'POST' && pathname === '/diagnostics') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            uploads.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            res.statusCode = uploadStatus;
            res.end(uploadStatus === 200 ? JSON.stringify({ id: REPORT_ID }) : '{"error":"stand-in failure"}');
        });
        return;
    }
    if (req.method === 'GET' && pathname === '/rest/v1/') {
        res.statusCode = restStatus;
        res.end('{}');
        return;
    }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
});
const sockets = new WebSocketServer({ noServer: true });
let heartbeatsAnswered = 0;
server.on('upgrade', (req, socket, head) => {
    requests.push({ method: 'UPGRADE', url: req.url });
    if (!req.url.startsWith('/realtime/v1/websocket')) {
        socket.destroy();
        return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => {
            const message = JSON.parse(String(data));
            if (message.topic === 'phoenix' && message.event === 'heartbeat') {
                heartbeatsAnswered++;
                ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: message.ref }));
            }
        });
    });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// --- the command -----------------------------------------------------------------

/** `remote --report` with the planted home; `args` are added, `env` overrides (e.g. no DC_DIAGNOSTICS_URL). */
function runReport(node = process.execPath, { args = [], env = {}, runHome = home } = {}) {
    return new Promise((resolve) => {
        const { FORCE_COLOR, ...inherited } = process.env;
        const child = spawn(node, [CLI, 'remote', '--report', ...args], {
            cwd: runHome,
            env: {
                ...inherited,
                HOME: runHome,
                USERPROFILE: runHome,
                MCP_SERVER_URL: baseUrl,
                DC_DIAGNOSTICS_URL: `${baseUrl}/diagnostics`,
                DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
                DC_FLAG_URL: 'http://127.0.0.1:9/',
                HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
                ...env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        // The old `remote` ignores --report and starts the device: bound it
        const timer = setTimeout(() => child.kill(), 60_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
    });
}

/** A file from the zip a run says it saved. */
function zipFile(result, name) {
    const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
    assert(saved, `no "Saved:" line:\n${result.output}`);
    return new PizZip(fs.readFileSync(saved)).file(name).asText();
}

const started = Date.now();
const run = await runReport();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const zips = fs.readdirSync(home).filter((name) => /^desktop-commander-report-.*\.zip$/.test(name));
let zip = null;
let entries = {};
if (zips.length === 1) {
    zip = new PizZip(fs.readFileSync(path.join(home, zips[0])));
    for (const name of Object.keys(zip.files)) {
        if (!zip.files[name].dir) entries[name] = zip.file(name).asText();
    }
}
const reportJson = entries['report.json'] ? JSON.parse(entries['report.json']) : null;
const reportTxt = entries['report.txt'] ?? '';

await test(`remote --report exits 0 and says where the zip is (${seconds} s)`, () => {
    assert.strictEqual(run.code, 0, `exit code ${run.code}; output:\n${run.output}`);
    assert.match(run.output, /Collecting diagnostics/);
    assert.match(run.output, /✓ versions {3}✓ clock {3}✓ network {3}✓ device state {3}✓ device log \(2 files\)/, run.output);
    assert(run.output.includes(`Saved: ${path.join(home, zips[0] ?? 'desktop-commander-report-')}`), run.output);
    assert.match(run.output, /It holds no passwords, tokens, emails or file contents; you can open it and check\./);
    assert(!/warning/i.test(run.output), `no warning on the terminal:\n${run.output}`);
});

await test('it uploads the saved zip with the user and device ids, and prints the report id', () => {
    assert.strictEqual(uploads.length, 1, `one upload, got ${uploads.length}`);
    const [upload] = uploads;
    assert(upload.body.equals(fs.readFileSync(path.join(home, zips[0]))), 'the same bytes as the saved zip');
    assert.strictEqual(upload.headers['content-type'], 'application/zip');
    assert.strictEqual(upload.headers['x-dc-user-id'], USER_ID, 'the user id is the saved token\'s sub');
    assert.strictEqual(upload.headers['x-dc-device-id'], DEVICE_ID);
    assert.match(run.output, new RegExp(`\\nSent to Desktop Commander support\\. Report id: ${REPORT_ID}\\n`), run.output);
    assert.match(run.output, /\nGive this id to support\. We keep it for 7 days, then delete it\.\n/);
    assert(!run.output.includes('Reply to your support conversation'), 'sent: no "attach it yourself" line');
});

await test('the zip is in the home folder, named by date, with report.txt, report.json and the device log', () => {
    assert.strictEqual(zips.length, 1, `one zip expected in the home folder, found: ${zips.join(', ') || 'none'}`);
    assert.match(zips[0], /^desktop-commander-report-\d{4}-\d\d-\d\d-\d{4}\.zip$/);
    assert.deepStrictEqual(Object.keys(entries).sort(),
        ['device-log/remote.1.log', 'device-log/remote.log', 'report.json', 'report.txt']);
});

await test('the zip is readable by its owner only (0o600, like the device log; Windows has no such mode)', () => {
    if (process.platform === 'win32') {
        console.log('     (skipped on Windows: file modes do not apply)');
        return;
    }
    const mode = fs.statSync(path.join(home, zips[0])).mode & 0o777;
    assert.strictEqual(mode.toString(8), '600');
});

await test('report.txt says what it contains and what it does not', () => {
    assert.match(reportTxt, /^Desktop Commander diagnostics — \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(UTC[+-]\d+(:\d\d)?\)\n/);
    assert.match(reportTxt, /\nThis file contains: versions, how Node runs \(paths, with the home folder as ~\), clock, network checks, the device id and whether sign-in data exists \(yes\/no\), device status history\.\n/);
    assert.match(reportTxt, /\nIt does not contain: tokens, passwords, emails, the user name, tool arguments or results\.\n/);
    for (const label of ['Versions', 'Node', 'Running', 'MCP', 'Clock', 'Network', 'Device', 'Settings', 'Device log']) {
        assert.match(reportTxt, new RegExp(`\\n${label} +\\S`), `a "${label}" line`);
    }
});

await test('versions include npm, and how Node runs shows both paths and their kinds', () => {
    assert.match(reportTxt, /\nVersions +Desktop Commander \d+\.\d+\.\d+ · Node \d+\.\d+\.\d+ · npm (\d+\.\d+\.\d+|not found) · \S/, reportTxt);
    assert.match(reportJson?.versions?.npm ?? '', /^\d+\.\d+\.\d+/, 'npm is on PATH here, so its version is known');
    const nodeLine = reportTxt.match(/\nNode +(.*)\n/)?.[1] ?? '';
    assert.match(nodeLine, /node(\.exe)? \((global install|nvm|fnm|Volta|asdf|mise|Homebrew|Claude Desktop's bundled Node)\)$/, nodeLine);
    assert.strictEqual(reportJson?.versions?.nodePath, nodeLine.replace(/ \([^)]*\)$/, ''));
    // Run from this checkout: the entry script is dist/index.js, the kind a dev checkout
    const runningLine = reportTxt.match(/\nRunning +(.*)\n/)?.[1] ?? '';
    assert.match(runningLine, /[\\/]dist[\\/]index\.js \(dev checkout\)$/, runningLine);
    assert.strictEqual(reportJson?.versions?.entryPath, runningLine.replace(/ \([^)]*\)$/, ''));
    assert.strictEqual(reportJson?.versions?.runKind, 'dev checkout');
});

await test('the clock skew comes from the server Date header: 90 s ahead means the device is 90 s behind', () => {
    const ahead = reportJson?.clock?.serverAheadSeconds;
    assert(typeof ahead === 'number' && Math.abs(ahead - SERVER_AHEAD_S) <= 3, `serverAheadSeconds = ${ahead}`);
    assert.match(reportTxt, /\nClock +device is (8[7-9]|9[0-3]) s behind the server/, reportTxt);
});

await test('the network checks reach the stand-in: mcp-info 5 times, REST with the key, websocket heartbeat', () => {
    assert.strictEqual(requests.filter((r) => r.url === '/api/mcp-info').length, 5, JSON.stringify(requests));
    const rest = requests.filter((r) => r.url === '/rest/v1/');
    assert.strictEqual(rest.length, 1, JSON.stringify(requests));
    assert.strictEqual(rest[0].apikey, PUBLISHABLE_KEY);
    assert.strictEqual(heartbeatsAnswered, 1);
    assert.strictEqual(reportJson?.network?.supabase?.realtime?.heartbeat, true);
    assert.match(reportTxt, /\/api\/mcp-info 5× \d+\/\d+\/\d+ ms \(min\/median\/max\)/);
    assert.match(reportTxt, /Proxy: HTTPS_PROXY not set/);
});

await test('the Supabase check: a 401 (no sign-in) reads "reachable", and report.json keeps the raw status', () => {
    assert.strictEqual(reportJson?.network?.supabase?.rest?.status, 401);
    assert.match(reportTxt, /\n {14}Supabase: DNS \d+ ms · TCP \d+ ms · reachable in \d+ ms · realtime websocket opened in \d+ ms, heartbeat answered\n/, reportTxt);
    assert(!/REST|\(401\)/.test(reportTxt), 'the status code stays in report.json');
});

await test('device.json gives the device id and only yes/no facts and the age; config.json telemetry and the client id', () => {
    assert.deepStrictEqual(reportJson?.device, {
        deviceJson: true, parses: true, id: DEVICE_ID, session: true,
        accessToken: true, refreshToken: true, savedHoursAgo: 3,
    });
    assert.deepStrictEqual(reportJson?.settings, { telemetryEnabled: false, clientId: CLIENT_ID });
    assert(reportTxt.includes(`\nDevice        id ${DEVICE_ID} · signed-in data: yes (access token: yes, refresh token: yes), saved 3 h ago\n`), reportTxt);
    // Nothing on main creates device.json.lock: the planted one is not reported
    assert(!/lock left behind/i.test(reportTxt) && !(entries['report.json'] ?? '').includes('lockLeftBehind'), 'no lock in the report');
    assert.match(reportTxt, new RegExp(`\\nSettings +telemetry: off · client id: ${CLIENT_ID}`));
});

await test('the device id appears once in each report file, in the Device section, and stays masked in the log', () => {
    const count = (text) => text.split(DEVICE_ID).length - 1;
    assert.strictEqual(count(reportTxt), 1, 'report.txt');
    assert.match(reportTxt.split('\n').find((line) => line.includes(DEVICE_ID)) ?? '', /^Device {8}id /);
    assert.strictEqual(count(entries['report.json'] ?? ''), 1, 'report.json');
    const logs = Object.entries(entries).filter(([name]) => name.startsWith('device-log/'));
    for (const [name, text] of logs) assert.strictEqual(count(text), 0, name);
    assert.match(entries['device-log/remote.1.log'] ?? '', /Channel error: device <id> not joined/);
});

await test('the device log part counts the lines and keeps a tool call\'s name, not its arguments', () => {
    const log = entries['device-log/remote.log'] ?? '';
    assert.match(log, /Z {2}Received tool call c-9: read_file\n/);
    assert(!log.includes('planted-tool-arg'), `a tool argument is dropped:\n${log}`);
    assert.match(log, /Channel subscribed \(recovered after 1 attempt\)/);
    assert.match(reportTxt, /\nDevice log +7 lines from 2026-10-01 09:12 to 2026-10-05 14:21 UTC; last: "Channel subscribed/, reportTxt);
});

await test('every existing device log file goes into the zip, oldest first', async () => {
    const { DEVICE_LOG_FILES, deviceLogName } = await import('../dist/remote-device/diagnostics/device-log.js');
    const names = Array.from({ length: DEVICE_LOG_FILES }, (_, i) => deviceLogName(i));
    assert.deepStrictEqual(names, ['remote.log', 'remote.1.log', 'remote.2.log'], 'the files the report must pack');
    const fullHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-report-full-log-home-'));
    try {
        const logDir = path.join(fullHome, '.desktop-commander-device');
        fs.mkdirSync(logDir, { recursive: true });
        // One line per file; the oldest file holds the oldest line
        names.forEach((name, i) => {
            fs.writeFileSync(path.join(logDir, name), `2026-10-0${5 - i}T12:00:00Z  Channel subscribed (file ${name})\n`);
        });
        const result = await runReport(process.execPath, { args: ['--no-upload'], runHome: fullHome });
        assert.strictEqual(result.code, 0, result.output);
        const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
        const logEntries = Object.keys(new PizZip(fs.readFileSync(saved)).files).filter((name) => name.startsWith('device-log/'));
        assert.deepStrictEqual(logEntries, [...names].reverse().map((name) => `device-log/${name}`), 'all files, oldest first');
        for (const name of names) {
            assert.match(zipFile(result, `device-log/${name}`), new RegExp(`Channel subscribed \\(file ${name.replace(/\./g, '\\.')}\\)`));
        }
        assert.match(zipFile(result, 'report.txt'), new RegExp(`\\nDevice log +${names.length} lines from 2026-10-0${6 - names.length} 12:00 to 2026-10-05 12:00 UTC`));
        assert.match(result.output, new RegExp(`device log \\(${names.length} files\\)`));
    } finally {
        fs.rmSync(fullHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

await test('nothing private is in the zip', () => {
    assert(zip, 'no zip to check');
    const everything = Object.values(entries).join('\n');
    const planted = {
        'the access token': ACCESS_TOKEN,
        'a JWT': 'eyJ',
        'the refresh token': REFRESH_TOKEN,
        'the email': EMAIL,
        'the publishable key': PUBLISHABLE_KEY,
        'the user id (only in the upload header)': USER_ID,
        'a tool argument': 'planted-tool-arg',
        'another config setting': OTHER_SETTING,
        'the home folder': home,
        'the home folder (forward slashes)': home.replace(/\\/g, '/'),
        'the home folder (JSON-escaped)': JSON.stringify(home).slice(1, -1),
        'the host name': os.hostname(),
    };
    const user = os.userInfo().username;
    if (user.length >= 3) planted['the user name'] = user;
    for (const [what, secret] of Object.entries(planted)) {
        assert(!everything.toLowerCase().includes(secret.toLowerCase()), `${what} is in the zip`);
    }
});

await test('it never starts sign-in and never writes the device files', () => {
    const signIn = requests.filter((r) => r.url.startsWith('/device/') || r.url.startsWith('/auth/'));
    assert.deepStrictEqual(signIn, [], 'no sign-in or session request');
    assert(fs.readFileSync(deviceJson).equals(deviceJsonBefore), 'device.json unchanged');
    assert.strictEqual(fs.statSync(deviceJson).mtimeMs, deviceJsonMtimeBefore, 'device.json not rewritten');
    assert(!run.output.includes('Starting MCP Device'), 'the device does not start');
});

await test('the Supabase check: a 5xx reads as a server error, and no answer as "not reachable"', async () => {
    restStatus = 503;
    const failing = await runReport();
    restStatus = 401;
    const failingTxt = zipFile(failing, 'report.txt');
    assert.match(failingTxt, /\n {14}Supabase: .* · answered with a server error \(503\) in \d+ ms · realtime websocket/, failingTxt);
    assert.strictEqual(JSON.parse(zipFile(failing, 'report.json')).network.supabase.rest.status, 503);

    // mcp-info names a Supabase address that nothing listens on
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    supabaseUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));
    const gone = await runReport();
    supabaseUrl = null;
    const goneTxt = zipFile(gone, 'report.txt');
    assert.match(goneTxt, /\n {14}Supabase: .*\bnot reachable \([^)]+\)/, goneTxt);
    assert(!/reachable in \d/.test(goneTxt), goneTxt);
});

await test('--no-upload sends nothing and says to attach the zip, as before', async () => {
    const before = uploads.length;
    const result = await runReport(process.execPath, { args: ['--no-upload'] });
    assert.strictEqual(result.code, 0, result.output);
    assert.strictEqual(uploads.length, before, 'no upload');
    assert.match(result.output, /\nReply to your support conversation with this file attached\.\n/, result.output);
    assert(!/Sent to|Not sent/.test(result.output), result.output);
});

await test('without device.json the upload carries no id headers', async () => {
    const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-report-bare-home-'));
    try {
        const before = uploads.length;
        const result = await runReport(process.execPath, { runHome: bareHome });
        assert.strictEqual(result.code, 0, result.output);
        assert.strictEqual(uploads.length, before + 1, 'one upload');
        const { headers } = uploads.at(-1);
        assert(!('x-dc-user-id' in headers) && !('x-dc-device-id' in headers), JSON.stringify(headers));
        assert.match(result.output, new RegExp(`Report id: ${REPORT_ID}`), result.output);
    } finally {
        fs.rmSync(bareHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

await test('a server error keeps the zip and says "Not sent"', async () => {
    uploadStatus = 500;
    const result = await runReport();
    uploadStatus = 200;
    assert.strictEqual(result.code, 0, result.output);
    const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
    assert(saved && fs.existsSync(saved), 'the zip is kept');
    assert.match(result.output, /\nNot sent \(the server answered 500\)\. Attach the zip to your support conversation instead\.\n/, result.output);
    assert(!result.output.includes('Report id'), result.output);
});

await test('an upload that never answers is aborted by its timeout', async () => {
    const { uploadReport } = await import('../dist/remote-device/diagnostics/upload.js');
    const silent = http.createServer(() => { /* never answers */ });
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
        const startedAt = Date.now();
        await assert.rejects(
            uploadReport(Buffer.from('PK'), { diagnosticsUrl: `http://127.0.0.1:${silent.address().port}/`, userId: null, deviceId: null, timeoutMs: 300 }),
            (error) => error.name === 'TimeoutError',
        );
        assert(Date.now() - startedAt < 5000, 'aborted near the timeout');
    } finally {
        silent.closeAllConnections();
        silent.close();
    }
});

await test('the upload goes to the server\'s diagnosticsUrl, else to the default address', async () => {
    const { uploadReport, DEFAULT_DIAGNOSTICS_URL } = await import('../dist/remote-device/diagnostics/upload.js');
    assert.strictEqual(DEFAULT_DIAGNOSTICS_URL, 'https://diagnostics.ds-c09.workers.dev');
    // The default injected as a second stand-in path, so nothing leaves this machine
    const options = { userId: null, deviceId: null, defaultUrl: `${baseUrl}/diagnostics?to=default` };
    await uploadReport(Buffer.from('PK'), { ...options, diagnosticsUrl: `${baseUrl}/diagnostics?to=server` });
    assert.strictEqual(uploads.at(-1).url, '/diagnostics?to=server', 'the server\'s address wins');
    await uploadReport(Buffer.from('PK'), { ...options, diagnosticsUrl: null });
    assert.strictEqual(uploads.at(-1).url, '/diagnostics?to=default', 'no server address: the default');
});

await test('only an https diagnosticsUrl from the server is used', async () => {
    const { collectReport } = await import('../dist/remote-device/diagnostics/report.js');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MCP_SERVER_URL: process.env.MCP_SERVER_URL };
    // collectReport reads the home folder: the planted one, never the real one
    Object.assign(process.env, { HOME: home, USERPROFILE: home, MCP_SERVER_URL: baseUrl });
    try {
        for (const [served, expected] of [[DIAGNOSTICS_URL, DIAGNOSTICS_URL], [`${baseUrl}/diagnostics`, null], [undefined, null]]) {
            diagnosticsUrl = served;
            assert.strictEqual((await collectReport()).diagnosticsUrl, expected, `served ${served}`);
        }
    } finally {
        diagnosticsUrl = DIAGNOSTICS_URL;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

await test('the server sends no diagnosticsUrl: the report is still sent, and "Not sent" means a real failure only', async () => {
    const before = uploads.length;
    diagnosticsUrl = undefined;
    const result = await runReport();
    diagnosticsUrl = DIAGNOSTICS_URL;
    assert.strictEqual(result.code, 0, result.output);
    assert.strictEqual(uploads.length, before + 1, 'posted');
    assert.match(result.output, new RegExp(`Report id: ${REPORT_ID}`), result.output);
    assert(!/Not sent|doesn't accept/.test(result.output), result.output);
});

await test('a session without tokens is not signed-in data', async () => {
    const tokenlessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-report-tokenless-home-'));
    try {
        fs.mkdirSync(path.join(tokenlessHome, '.desktop-commander-device'));
        fs.writeFileSync(path.join(tokenlessHome, '.desktop-commander-device', 'device.json'),
            JSON.stringify({ deviceId: DEVICE_ID, session: {} }));
        const result = await runReport(process.execPath, { args: ['--no-upload'], runHome: tokenlessHome });
        assert.strictEqual(result.code, 0, result.output);
        const line = zipFile(result, 'report.txt').split('\n').find((l) => l.startsWith('Device ')) ?? '';
        assert.match(line, /· signed-in data: no \(access token: no, refresh token: no\)/, line);
    } finally {
        fs.rmSync(tokenlessHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

/** A package folder whose dist/index.js only waits: it stands in for an installed copy in the process list. */
function fakePackage(folder, name) {
    fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module' }));
    fs.writeFileSync(path.join(folder, 'dist', 'index.js'), 'setInterval(() => {}, 1 << 30);\n');
    return path.join(folder, 'dist', 'index.js');
}

await test('Desktop Commander MCP: counts processes running its dist/index.js, not `remote`, not another app', async () => {
    const dcScript = fakePackage(path.join(home, 'fake-dc'), '@wonderwhy-er/desktop-commander');
    const otherScript = fakePackage(path.join(home, 'other-app'), 'other-app');
    // Real copies may already run on this machine: compare with a run just before the stand-ins start
    const before = JSON.parse(zipFile(await runReport(), 'report.json')).desktopCommanderMcp;
    assert(typeof before?.running === 'number', `report.json has desktopCommanderMcp.running: ${JSON.stringify(before)}`);
    const startedAt = Date.now();
    const standIns = [
        spawn(process.execPath, [dcScript], { stdio: 'ignore' }),
        spawn(process.execPath, [dcScript, 'remote'], { stdio: 'ignore' }),
        spawn(process.execPath, [otherScript], { stdio: 'ignore' }),
    ];
    try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await runReport();
        const after = JSON.parse(zipFile(result, 'report.json')).desktopCommanderMcp;
        assert.strictEqual(after.running, before.running + 1, `only the stand-in MCP counts: before ${before.running}, after ${after.running}`);
        assert(Date.parse(after.since) <= startedAt + 2000, `since is the earliest start: ${after.since}`);
        const txt = zipFile(result, 'report.txt');
        const line = txt.split('\n').find((l) => l.startsWith('MCP ')) ?? '';
        const copies = after.running === 1 ? '1 copy' : `${after.running} copies`;
        assert.match(line, new RegExp(`^MCP {11}running \\(${copies}, since (\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d\\)$`), txt);
        assert(!txt.includes('fake-dc') && !zipFile(result, 'report.json').includes('fake-dc'), 'no paths or command lines');
    } finally {
        for (const child of standIns) child.kill();
    }
});

await test('Desktop Commander MCP: "not running" with no copy, and the count and start time with some', async () => {
    const { formatReport } = await import('../dist/remote-device/diagnostics/report.js');
    const lineOf = (mcp) => formatReport({ ...reportJson, desktopCommanderMcp: mcp }).split('\n').find((l) => l.startsWith('MCP '));
    assert.strictEqual(lineOf({ running: 0, since: null }), 'MCP           not running');
    const today = new Date();
    today.setHours(14, 2, 0, 0);
    assert.strictEqual(lineOf({ running: 2, since: today.toISOString() }), 'MCP           running (2 copies, since 14:02)');
});

await test('the home folder is shown as ~ in a path under it', async () => {
    // The CLI's home here is the temporary one; node linked into it stands for ~/.nvm/…/node
    const nvmBin = path.join(home, '.nvm', 'versions', 'node', `v${process.versions.node}`, 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });
    const nodeLink = path.join(nvmBin, path.basename(process.execPath));
    try {
        fs.linkSync(process.execPath, nodeLink);
    } catch {
        fs.copyFileSync(process.execPath, nodeLink); // another volume: a copy
    }
    const again = await runReport(nodeLink);
    assert.strictEqual(again.code, 0, again.output);
    const txt = zipFile(again, 'report.txt');
    const expected = ['~', '.nvm', 'versions', 'node', `v${process.versions.node}`, 'bin', path.basename(process.execPath)].join(path.sep);
    assert(txt.includes(`\nNode          ${expected} (nvm)\n`), txt);
    assert(!txt.includes(home), 'the home folder itself is not in the report');
});

await test('after all the runs and uploads: still no sign-in or token refresh, and device.json unchanged', () => {
    const signIn = requests.filter((r) => r.url.startsWith('/device/') || r.url.startsWith('/auth/'));
    assert.deepStrictEqual(signIn, [], 'no sign-in or session request');
    assert(fs.readFileSync(deviceJson).equals(deviceJsonBefore), 'device.json unchanged');
    assert.strictEqual(fs.statSync(deviceJson).mtimeMs, deviceJsonMtimeBefore, 'device.json not rewritten');
});

server.close();
sockets.close();
fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(`\n${failures ? '🔴' : '✅'} remote report: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
