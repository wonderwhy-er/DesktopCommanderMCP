#!/usr/bin/env node

/**
 * `desktop-commander remote --report`: one command a user runs to give support
 * a diagnostics zip. It must not start the device and must never open sign-in,
 * so it also works when the user's sign-in is broken.
 *
 * The zip lands in the home folder as desktop-commander-report-<date>.zip and
 * holds report.txt (readable), report.json (the same facts) and device-log/
 * (the device log's remote-<day>.log files, oldest first, masked again). It records versions (npm included),
 * how Node runs (the Node executable and the entry script, the home folder
 * shown as ~, and what kind of install each is), the clock skew read from the
 * server's Date header, network timings to the server, Supabase REST and the
 * realtime websocket, whether Desktop Commander MCP is running right now
 * (count and earliest start, from the process list), the device id and yes/no
 * facts about the rest of device.json, and only telemetryEnabled and clientId
 * from config.json.
 *
 * Everything runs against the local stand-in (helpers/remote-stand-in.js), with
 * its options for the report: its Date header runs 90 s ahead of this machine,
 * it answers the realtime heartbeat and it takes uploads. No network.
 * Planted secrets (the session's tokens in device.json, an email, a JWT and the
 * home path in the device log, another setting in config.json, the publishable
 * key) must never appear anywhere in the zip, nor the user name. The device
 * id appears once, in the Device section; inside log lines it stays masked.
 *
 * After saving, the report uploads the zip (unless --no-upload) to the
 * diagnosticsUrl that /api/mcp-info names, and only there: https, or http on
 * this machine (the stand-in names its own /diagnostics). With none, it
 * keeps the zip and says the server named no upload address. The upload
 * carries the user id (the saved token's `sub`) and the device id, and the
 * terminal prints the report id; a failure keeps the zip and says "Not sent",
 * with the Worker's message when it sends one ({code, message}).
 *
 * The files are planted in the home the runner gives (outside one, the test
 * skips); the cases that need another home get one from createTestEnv(). It
 * never reads the real home folders.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-remote-report.js
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { deviceConfigPath, runRemote, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv, isTestHome } from './helpers/test-env.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';

const SERVER_AHEAD_S = 90;
const EMAIL = 'planted.person@example.com';
const CLIENT_ID = 'client-id-planted-0042';
const OTHER_SETTING = 'other-setting-must-not-appear';
/** The old `remote` ignores --report and starts the device: bound it */
const RUN_TIMEOUT_MS = 60_000;

/** A file from the zip a run says it saved. */
function zipFile(result, name) {
    const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
    assert(saved, `no "Saved:" line:\n${result.output}`);
    return new PizZip(fs.readFileSync(saved)).file(name).asText();
}

/** A package folder whose dist/index.js only waits: it stands in for an installed copy in the process list. */
function fakePackage(folder, name) {
    fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module' }));
    fs.writeFileSync(path.join(folder, 'dist', 'index.js'), 'setInterval(() => {}, 1 << 30);\n');
    return path.join(folder, 'dist', 'index.js');
}

async function runTests() {
    if (!isTestHome()) {
        skip('test-remote-report.js plants device.json and config.json in the home folder: run it through node test/run-all-tests.js');
        return true;
    }
    const home = os.homedir();
    const standIn = await startRemoteStandIn({ serverAheadSec: SERVER_AHEAD_S, diagnostics: true, realtime: true });
    const UPLOAD_URL = standIn.diagnosticsUrl;
    /** `env` pointed at the stand-in, with no proxy */
    const reportEnv = (env) => ({
        ...env,
        MCP_SERVER_URL: standIn.url,
        HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
    });
    const env = reportEnv(process.env);
    /** `remote --report <args>` with `runEnv`; `execPath` is the Node that runs it */
    const runReport = (runEnv, args = [], { execPath } = {}) =>
        runRemote(runEnv, ['--report', ...args], { execPath, timeoutMs: RUN_TIMEOUT_MS });
    /** Another home for one case: `fn` gets it and an env for it, and it is removed after */
    async function inOtherHome(fn) {
        const other = createTestEnv();
        try {
            return await fn({ home: other.home, env: reportEnv(other.env) });
        } finally {
            other.cleanup();
        }
    }
    const failures = [];

    async function test(name, fn) {
        try {
            console.log(`${await fn() === SKIPPED ? '- skipped:' : '✅ PASS '} ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
        }
    }

    try {
        // --- the planted home ---------------------------------------------------------

        const deviceDir = path.join(home, '.desktop-commander-device');
        const configDir = path.join(home, '.claude-server-commander');
        const session = standIn.login();
        writeDeviceConfig(home, { deviceId: standIn.deviceId, session });
        const deviceJson = deviceConfigPath(home);
        const savedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
        fs.utimesSync(deviceJson, savedAt, savedAt);
        fs.mkdirSync(path.join(deviceDir, 'device.json.lock'));
        // A log as an older or hand-edited version might have left it: raw secrets in kept lines. One file per UTC weekday:
        // Thursday 1 Oct, then Monday 5 Oct, with modification times in that order
        fs.writeFileSync(path.join(deviceDir, 'remote-thu.log'), [
            '2026-10-01T09:12:00Z  Starting MCP Device...',
            `2026-10-01T09:12:05Z  Channel error: refresh failed for ${EMAIL} token ${session.access_token} — socket=closed(3) ch=errored attempt=1`,
            `2026-10-01T09:12:06Z  Persisted session invalid: ENOENT ${path.join(home, 'secret-project', 'plan.txt')}`,
            `2026-10-01T09:12:07Z  Channel error: device ${standIn.deviceId} not joined — socket=open(1) ch=errored attempt=2`,
        ].join('\n') + '\n');
        fs.writeFileSync(path.join(deviceDir, 'remote-mon.log'), [
            '2026-10-05T14:20:44Z  Device marked as offline',
            `2026-10-05T14:20:45Z  Received tool call c-9: read_file {"path":"planted-tool-arg"}`,
            '2026-10-05T14:21:03Z  Channel subscribed (recovered after 1 attempt) — socket=open(1) ch=joined attempt=0',
        ].join('\n') + '\n');
        fs.utimesSync(path.join(deviceDir, 'remote-thu.log'), new Date('2026-10-01T09:12:07Z'), new Date('2026-10-01T09:12:07Z'));
        fs.utimesSync(path.join(deviceDir, 'remote-mon.log'), new Date('2026-10-05T14:21:03Z'), new Date('2026-10-05T14:21:03Z'));
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
            telemetryEnabled: false,
            clientId: CLIENT_ID,
            allowedDirectories: [path.join(home, 'secret-project')],
            defaultShell: OTHER_SETTING,
        }, null, 2));
        const deviceJsonBefore = fs.readFileSync(deviceJson);
        const deviceJsonMtimeBefore = fs.statSync(deviceJson).mtimeMs;

        // --- the first run --------------------------------------------------------------

        const started = Date.now();
        const run = await runReport(env);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const zips = fs.readdirSync(home).filter((name) => /^desktop-commander-report-.*\.zip$/.test(name));
        let zip = null;
        const entries = {};
        if (zips.length === 1) {
            zip = new PizZip(fs.readFileSync(path.join(home, zips[0])));
            for (const name of Object.keys(zip.files)) {
                if (!zip.files[name].dir) entries[name] = zip.file(name).asText();
            }
        }
        const reportJson = entries['report.json'] ? JSON.parse(entries['report.json']) : null;
        const reportTxt = entries['report.txt'] ?? '';
        const everything = Object.values(entries).join('\n');

        await test(`remote --report exits 0 and says where the zip is (${seconds} s)`, () => {
            assert.strictEqual(run.code, 0, `exit code ${run.code}; output:\n${run.output}`);
            assert.match(run.output, /Collecting diagnostics/);
            assert.match(run.output, /✓ versions {3}✓ clock {3}✓ network {3}✓ device state {3}✓ device log \(2 files\)/, run.output);
            assert(run.output.includes(`Saved: ${path.join(home, zips[0] ?? 'desktop-commander-report-')}`), run.output);
            assert.match(run.output, /It holds no passwords, tokens, emails or file contents; you can open it and check\./);
            assert(!/warning/i.test(run.output), `no warning on the terminal:\n${run.output}`);
        });

        await test('it uploads the saved zip with the user and device ids, and prints the report id', () => {
            assert.strictEqual(standIn.uploads.length, 1, `one upload, got ${standIn.uploads.length}`);
            const [upload] = standIn.uploads;
            assert(upload.body.equals(fs.readFileSync(path.join(home, zips[0]))), 'the same bytes as the saved zip');
            assert.strictEqual(upload.headers['content-type'], 'application/zip');
            assert.strictEqual(upload.headers['x-dc-user-id'], standIn.userId, 'the user id is the saved token\'s sub');
            assert.strictEqual(upload.headers['x-dc-device-id'], standIn.deviceId);
            assert.match(run.output, new RegExp(`\\nSent to Desktop Commander support\\. Report id: ${standIn.reportId}\\n`), run.output);
            assert.match(run.output, /\nGive this id to support\. We keep it for 7 days, then delete it\.\n/);
            assert(!run.output.includes('Reply to your support conversation'), 'sent: no "attach it yourself" line');
        });

        await test('the zip is in the home folder, named by date, with report.txt, report.json and the device log', () => {
            assert.strictEqual(zips.length, 1, `one zip expected in the home folder, found: ${zips.join(', ') || 'none'}`);
            assert.match(zips[0], /^desktop-commander-report-\d{4}-\d\d-\d\d-\d{4}\.zip$/);
            assert.deepStrictEqual(Object.keys(entries).sort(),
                ['device-log/remote-mon.log', 'device-log/remote-thu.log', 'report.json', 'report.txt']);
        });

        await test('the zip is readable by its owner only (0o600, like the device log)', () => {
            if (process.platform === 'win32') return skip('the zip\'s file mode (0o600) is not checked on Windows, which has no such mode');
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
            assert.match(nodeLine, /node(\.exe)? \((global install|nvm|fnm|Volta|asdf|mise|Homebrew|Claude Desktop's bundled Node|unknown)\)$/, nodeLine);
            assert.strictEqual(reportJson?.versions?.nodePath, nodeLine.replace(/ \([^)]*\)$/, ''));
            // Run from this checkout: the entry script is dist/index.js, the kind a dev checkout
            const runningLine = reportTxt.match(/\nRunning +(.*)\n/)?.[1] ?? '';
            assert.match(runningLine, /[\\/]dist[\\/]index\.js \(dev checkout\)$/, runningLine);
            assert.strictEqual(reportJson?.versions?.entryPath, runningLine.replace(/ \([^)]*\)$/, ''));
            assert.strictEqual(reportJson?.versions?.runKind, 'dev checkout');
        });

        await test('the Node kind: known installers and global installs by path; anything else is "unknown"', async () => {
            const { nodeKind } = await import('../dist/remote-device/diagnostics/report.js');
            for (const [execPath, kind] of [
                ['C:\\Program Files\\nodejs\\node.exe', 'global install'],
                ['/usr/local/bin/node', 'global install'],
                ['/usr/bin/node', 'global install'],
                ['/Users/u/.nvm/versions/node/v20.11.0/bin/node', 'nvm'],
                ['/opt/homebrew/Cellar/node/22.1.0/bin/node', 'Homebrew'],
                ['/Applications/Claude.app/Contents/Resources/node', "Claude Desktop's bundled Node"],
                // Paths none of the rules know, e.g. an app's own Node
                ['C:\\Users\\u\\AppData\\Local\\SomeApp\\runtime\\node.exe', 'unknown'],
                ['/opt/some-app/runtime/bin/node', 'unknown'],
            ]) {
                assert.strictEqual(nodeKind(execPath), kind, execPath);
            }
        });

        await test('the clock skew comes from the server Date header: 90 s ahead means the device is 90 s behind', () => {
            const ahead = reportJson?.clock?.serverAheadSeconds;
            assert(typeof ahead === 'number' && Math.abs(ahead - SERVER_AHEAD_S) <= 3, `serverAheadSeconds = ${ahead}`);
            assert.match(reportTxt, /\nClock +device is (8[7-9]|9[0-3]) s behind the server/, reportTxt);
        });

        await test('the network checks reach the stand-in: mcp-info 5 times, REST with the key, websocket heartbeat', () => {
            const { requests } = standIn;
            assert.strictEqual(requests.filter((r) => r.url === '/api/mcp-info').length, 5, JSON.stringify(requests));
            const rest = requests.filter((r) => r.url === '/rest/v1/');
            assert.strictEqual(rest.length, 1, JSON.stringify(requests));
            assert.strictEqual(rest[0].apikey, standIn.anonKey);
            assert.strictEqual(standIn.heartbeatsAnswered, 1);
            assert.strictEqual(reportJson?.network?.supabase?.realtime?.heartbeat, true);
            assert.match(reportTxt, /\/api\/mcp-info 5× \d+\/\d+\/\d+ ms \(min\/median\/max\)/);
            assert.match(reportTxt, /Proxy: HTTPS_PROXY not set/);
        });

        await test('the Supabase check: a 401 (no sign-in) reads "reachable", and report.json keeps the raw status', () => {
            assert.strictEqual(reportJson?.network?.supabase?.rest?.status, 401);
            assert.match(reportTxt, /\n {14}Supabase: DNS \d+ ms · TCP \d+ ms · reachable in \d+ ms · realtime websocket opened in \d+ ms, heartbeat answered\n/, reportTxt);
            assert(!/REST|\(401\)/.test(reportTxt), 'the status code stays in report.json');
        });

        await test('device.json gives the device id, only yes/no facts and when it was saved; config.json telemetry and the client id', () => {
            // When it was saved: device.json's modification time, as ISO in report.json and in UTC in report.txt
            const savedIso = new Date(deviceJsonMtimeBefore).toISOString();
            assert.deepStrictEqual(reportJson?.device, {
                deviceJson: true, parses: true, id: standIn.deviceId, session: true,
                accessToken: true, refreshToken: true, savedAt: savedIso,
            });
            assert.deepStrictEqual(reportJson?.settings, { telemetryEnabled: false, clientId: CLIENT_ID });
            const savedUtc = `${savedIso.slice(0, 10)} ${savedIso.slice(11, 16)} UTC`;
            assert(reportTxt.includes(`\nDevice        id ${standIn.deviceId} · signed-in data: yes (access token: yes, refresh token: yes), saved ${savedUtc}\n`), reportTxt);
            // A device's save and `remote --logout` hold device.json.lock while they write or remove
            // device.json (device.ts): the report says nothing about the planted one
            assert(!/lock left behind/i.test(reportTxt) && !(entries['report.json'] ?? '').includes('lockLeftBehind'), 'no lock in the report');
            assert.match(reportTxt, new RegExp(`\\nSettings +telemetry: off · client id: ${CLIENT_ID}`));
        });

        await test('the device id appears once in each report file, in the Device section, and stays masked in the log', () => {
            const count = (text) => text.split(standIn.deviceId).length - 1;
            assert.strictEqual(count(reportTxt), 1, 'report.txt');
            assert.match(reportTxt.split('\n').find((line) => line.includes(standIn.deviceId)) ?? '', /^Device {8}id /);
            assert.strictEqual(count(entries['report.json'] ?? ''), 1, 'report.json');
            const logs = Object.entries(entries).filter(([name]) => name.startsWith('device-log/'));
            for (const [name, text] of logs) assert.strictEqual(count(text), 0, name);
            assert.match(entries['device-log/remote-thu.log'] ?? '', /Channel error: device <id> not joined/);
        });

        await test('the device log part counts the lines and keeps a tool call\'s name, not its arguments', () => {
            const log = entries['device-log/remote-mon.log'] ?? '';
            assert.match(log, /Z {2}Received tool call c-9: read_file\n/);
            assert(!log.includes('planted-tool-arg'), `a tool argument is dropped:\n${log}`);
            assert.match(log, /Channel subscribed \(recovered after 1 attempt\)/);
            assert.match(reportTxt, /\nDevice log +7 lines from 2026-10-01 09:12 to 2026-10-05 14:21 UTC; last: "Channel subscribed/, reportTxt);
        });

        await test('every existing device log file goes into the zip (21 names), oldest first by modification time', async () => {
            const { deviceLogNames } = await import('../dist/remote-device/diagnostics/device-log.js');
            const names = deviceLogNames();
            assert.strictEqual(names.length, 21, 'the files the report must pack');
            await inOtherHome(async (other) => {
                const logDir = path.join(other.home, '.desktop-commander-device');
                fs.mkdirSync(logDir, { recursive: true });
                // Written in an order that is not the names' order: every 8th name, wrapping, oldest first
                const order = names.map((_, k) => names[(k * 8) % names.length]);
                order.forEach((name, k) => {
                    const at = new Date(Date.UTC(2026, 8, 10 + k, 12));
                    fs.writeFileSync(path.join(logDir, name), `${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}  Channel subscribed (file ${name})\n`);
                    fs.utimesSync(path.join(logDir, name), at, at);
                });
                const result = await runReport(other.env, ['--no-upload']);
                assert.strictEqual(result.code, 0, result.output);
                const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
                const logEntries = Object.keys(new PizZip(fs.readFileSync(saved)).files).filter((name) => name.startsWith('device-log/'));
                assert.deepStrictEqual(logEntries, order.map((name) => `device-log/${name}`), 'all files, oldest first');
                for (const name of names) {
                    assert.match(zipFile(result, `device-log/${name}`), new RegExp(`Channel subscribed \\(file ${name.replace(/\./g, '\\.')}\\)`));
                }
                assert.match(zipFile(result, 'report.txt'), /\nDevice log +21 lines from 2026-09-10 12:00 to 2026-09-30 12:00 UTC/);
                assert.match(result.output, /device log \(21 files\)/);
            });
        });

        await test('nothing private is in the zip', () => {
            assert(zip, 'no zip to check');
            const planted = {
                'the access token': session.access_token,
                'a JWT': 'eyJ',
                'the refresh token': session.refresh_token,
                'the email': EMAIL,
                'the publishable key': standIn.anonKey,
                'the user id (only in the upload header)': standIn.userId,
                'a tool argument': 'planted-tool-arg',
                'another config setting': OTHER_SETTING,
                'the home folder': home,
                'the home folder (forward slashes)': home.replace(/\\/g, '/'),
                'the home folder (JSON-escaped)': JSON.stringify(home).slice(1, -1),
                'the host name': os.hostname(),
            };
            for (const [what, secret] of Object.entries(planted)) {
                assert(!everything.toLowerCase().includes(secret.toLowerCase()), `${what} is in the zip`);
            }
        });

        // redact() leaves a name under 3 characters alone (redact.ts), so such a name can't be checked
        await test('the user name is not in the zip', () => {
            const user = os.userInfo().username;
            if (user.length < 3) return skip('the user name is under 3 characters, which redact() leaves alone');
            assert(zip, 'no zip to check');
            assert(!everything.toLowerCase().includes(user.toLowerCase()), 'the user name is in the zip');
        });

        await test('it never starts sign-in and never writes the device files', () => {
            const signIn = standIn.requests.filter((r) => r.url.startsWith('/device/') || r.url.startsWith('/auth/'));
            assert.deepStrictEqual(signIn, [], 'no sign-in or session request');
            assert(fs.readFileSync(deviceJson).equals(deviceJsonBefore), 'device.json unchanged');
            assert.strictEqual(fs.statSync(deviceJson).mtimeMs, deviceJsonMtimeBefore, 'device.json not rewritten');
            assert(!run.output.includes('Starting MCP Device'), 'the device does not start');
        });

        await test('the Supabase check: a 5xx reads as a server error, and no answer as "not reachable"', async () => {
            standIn.restRootStatus = 503;
            const failing = await runReport(env);
            standIn.restRootStatus = null;
            const failingTxt = zipFile(failing, 'report.txt');
            assert.match(failingTxt, /\n {14}Supabase: .* · answered with a server error \(503\) in \d+ ms · realtime websocket/, failingTxt);
            assert.strictEqual(JSON.parse(zipFile(failing, 'report.json')).network.supabase.rest.status, 503);

            // mcp-info names a Supabase address that nothing listens on
            const closed = http.createServer();
            await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
            standIn.supabaseUrl = `http://127.0.0.1:${closed.address().port}`;
            await new Promise((resolve) => closed.close(resolve));
            const gone = await runReport(env);
            standIn.supabaseUrl = null;
            const goneTxt = zipFile(gone, 'report.txt');
            assert.match(goneTxt, /\n {14}Supabase: .*\bnot reachable \([^)]+\)/, goneTxt);
            assert(!/reachable in \d/.test(goneTxt), goneTxt);
        });

        await test('--no-upload sends nothing and says to attach the zip, as before', async () => {
            const before = standIn.uploads.length;
            const result = await runReport(env, ['--no-upload']);
            assert.strictEqual(result.code, 0, result.output);
            assert.strictEqual(standIn.uploads.length, before, 'no upload');
            assert.match(result.output, /\nReply to your support conversation with this file attached\.\n/, result.output);
            assert(!/Sent to|Not sent/.test(result.output), result.output);
        });

        await test('without device.json the upload carries no id headers', async () => {
            await inOtherHome(async (other) => {
                const before = standIn.uploads.length;
                const result = await runReport(other.env);
                assert.strictEqual(result.code, 0, result.output);
                assert.strictEqual(standIn.uploads.length, before + 1, 'one upload');
                const { headers } = standIn.uploads.at(-1);
                assert(!('x-dc-user-id' in headers) && !('x-dc-device-id' in headers), JSON.stringify(headers));
                assert.match(result.output, new RegExp(`Report id: ${standIn.reportId}`), result.output);
            });
        });

        await test('a server error keeps the zip and says "Not sent"', async () => {
            standIn.failUploads(1, 500);
            const result = await runReport(env);
            assert.strictEqual(result.code, 0, result.output);
            const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
            assert(saved && fs.existsSync(saved), 'the zip is kept');
            assert.match(result.output, /\nNot sent \(the server answered 500\)\. Attach the zip to your support conversation instead\.\n/, result.output);
            assert(!result.output.includes('Report id'), result.output);
        });

        await test('a refused upload shows the Worker\'s message ({code, message})', async () => {
            standIn.failUploads(1, 429, 'too many reports, try again in a minute');
            const result = await runReport(env);
            assert.strictEqual(result.code, 0, result.output);
            assert.match(result.output, /\nNot sent \(the server answered 429: too many reports, try again in a minute\)\. Attach the zip to your support conversation instead\.\n/, result.output);
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

        await test('the upload goes to the server\'s diagnosticsUrl only: no address, no upload', async () => {
            const upload = await import('../dist/remote-device/diagnostics/upload.js');
            assert(!('DEFAULT_DIAGNOSTICS_URL' in upload), 'no built-in address');
            const options = { userId: null, deviceId: null };
            await upload.uploadReport(Buffer.from('PK'), { ...options, diagnosticsUrl: `${UPLOAD_URL}?to=server` });
            assert.strictEqual(standIn.uploads.at(-1).url, '/diagnostics?to=server', 'the server\'s address');
            const before = standIn.uploads.length;
            await assert.rejects(upload.uploadReport(Buffer.from('PK'), { ...options, diagnosticsUrl: null }), /^Error: the server named no upload address$/);
            assert.strictEqual(standIn.uploads.length, before, 'nothing posted');
        });

        await test('the server\'s diagnosticsUrl is used if https, or http on this machine; anything else is ignored', async () => {
            // collectReport() runs in this process: it reads the runner's home, and the server from MCP_SERVER_URL
            const { collectReport } = await import('../dist/remote-device/diagnostics/report.js');
            const saved = process.env.MCP_SERVER_URL;
            process.env.MCP_SERVER_URL = standIn.url;
            try {
                for (const [served, expected] of [
                    ['https://diagnostics.example.invalid/', 'https://diagnostics.example.invalid/'],
                    [UPLOAD_URL, UPLOAD_URL],
                    ['http://localhost:9/diagnostics', 'http://localhost:9/diagnostics'],
                    ['http://diagnostics.example.invalid/', null],
                    ['ftp://127.0.0.1/diagnostics', null],
                    [undefined, null],
                ]) {
                    standIn.diagnosticsUrl = served;
                    assert.strictEqual((await collectReport()).diagnosticsUrl, expected, `served ${served}`);
                }
            } finally {
                standIn.diagnosticsUrl = UPLOAD_URL;
                if (saved === undefined) delete process.env.MCP_SERVER_URL; else process.env.MCP_SERVER_URL = saved;
            }
        });

        await test('the server names no diagnosticsUrl: nothing is sent, the zip is kept, and the terminal says why', async () => {
            const before = standIn.uploads.length;
            standIn.diagnosticsUrl = undefined;
            const result = await runReport(env);
            standIn.diagnosticsUrl = UPLOAD_URL;
            assert.strictEqual(result.code, 0, result.output);
            assert.strictEqual(standIn.uploads.length, before, 'nothing posted');
            const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
            assert(saved && fs.existsSync(saved), 'the zip is kept');
            assert.match(result.output, /\nNot sent \(the server named no upload address\)\. Attach the zip to your support conversation instead\.\n/, result.output);
            assert(!result.output.includes('Report id'), result.output);
        });

        await test('a session without tokens is not signed-in data', async () => {
            await inOtherHome(async (other) => {
                writeDeviceConfig(other.home, { deviceId: standIn.deviceId, session: {} });
                const result = await runReport(other.env, ['--no-upload']);
                assert.strictEqual(result.code, 0, result.output);
                const line = zipFile(result, 'report.txt').split('\n').find((l) => l.startsWith('Device ')) ?? '';
                assert.match(line, /· signed-in data: no \(access token: no, refresh token: no\)/, line);
            });
        });

        await test('Desktop Commander MCP: counts processes running its dist/index.js, not `remote`, not another app', async () => {
            const dcScript = fakePackage(path.join(home, 'fake-dc'), '@wonderwhy-er/desktop-commander');
            const otherScript = fakePackage(path.join(home, 'other-app'), 'other-app');
            // Real copies may already run on this machine: compare with a run just before the stand-ins start
            const before = JSON.parse(zipFile(await runReport(env), 'report.json')).desktopCommanderMcp;
            assert(typeof before?.running === 'number', `report.json has desktopCommanderMcp.running: ${JSON.stringify(before)}`);
            const startedAt = Date.now();
            const standIns = [
                spawn(process.execPath, [dcScript], { stdio: 'ignore' }),
                spawn(process.execPath, [dcScript, 'remote'], { stdio: 'ignore' }),
                spawn(process.execPath, [otherScript], { stdio: 'ignore' }),
            ];
            try {
                await new Promise((resolve) => setTimeout(resolve, 500));
                const result = await runReport(env);
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
            // node linked into the home stands for ~/.nvm/…/node
            const nvmBin = path.join(home, '.nvm', 'versions', 'node', `v${process.versions.node}`, 'bin');
            fs.mkdirSync(nvmBin, { recursive: true });
            const nodeLink = path.join(nvmBin, path.basename(process.execPath));
            try {
                fs.linkSync(process.execPath, nodeLink);
            } catch {
                fs.copyFileSync(process.execPath, nodeLink); // another volume: a copy
            }
            const again = await runReport(env, [], { execPath: nodeLink });
            assert.strictEqual(again.code, 0, again.output);
            const txt = zipFile(again, 'report.txt');
            const expected = ['~', '.nvm', 'versions', 'node', `v${process.versions.node}`, 'bin', path.basename(process.execPath)].join(path.sep);
            assert(txt.includes(`\nNode          ${expected} (nvm)\n`), txt);
            assert(!txt.includes(home), 'the home folder itself is not in the report');
        });

        await test('after all the runs and uploads: still no sign-in or token refresh, and device.json unchanged', () => {
            const signIn = standIn.requests.filter((r) => r.url.startsWith('/device/') || r.url.startsWith('/auth/'));
            assert.deepStrictEqual(signIn, [], 'no sign-in or session request');
            assert(fs.readFileSync(deviceJson).equals(deviceJsonBefore), 'device.json unchanged');
            assert.strictEqual(fs.statSync(deviceJson).mtimeMs, deviceJsonMtimeBefore, 'device.json not rewritten');
        });
    } finally {
        await standIn.close();
    }

    console.log(`\n${failures.length ? '🔴' : '✅'} remote report: ${failures.length} failing test(s).`);
    return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
