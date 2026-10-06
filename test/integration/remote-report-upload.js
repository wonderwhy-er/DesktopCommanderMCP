/**
 * Integration test: a `remote --report` zip uploads to the deployed
 * diagnostics Worker.
 *
 * The CLI uploads only to the address the server's /api/mcp-info names, and
 * production names one only once DIAGNOSTICS_URL is set there. So the test
 * passes the Worker's address itself (WORKER_URL): it saves a report with the
 * built CLI against the live services (MCP_SERVER_URL can point elsewhere),
 * then uploads those bytes with uploadReport(). It never uses the real home
 * folder: a temporary HOME / USERPROFILE holds a device.json that looks like a
 * real sign-in, with ids fixed and reserved for tests, never real Supabase
 * ids: device 00000000-0000-0000-0000-000000000001, and a fake, unsigned
 * access token whose payload has sub 00000000-0000-0000-0000-000000000000
 * (only `sub` is read; nothing signs in or refreshes). Uploads land like any
 * report, under <user>/<device>/<YYYY-MM-DD-HHMM>-<id>.zip.
 *
 *   1. remote --report --no-upload: exit 0, the zip in the temporary home, no
 *      "Sent" line.
 *   2. That zip, uploaded to WORKER_URL: a report id of 8 characters.
 *   3. A non-zip uploaded to WORKER_URL: refused with the Worker's message,
 *      "the server answered 415: …".
 *
 * Three POSTs: the Worker allows 5 a minute per IP. Needs a built dist/ (npm
 * run test:integration builds it). Prints the report id so it can be found in
 * the bucket.
 */

import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'index.js');
/** Reserved for tests: never a real Supabase user or device. */
const TEST_USER_ID = '00000000-0000-0000-0000-000000000000';
const TEST_DEVICE_ID = '00000000-0000-0000-0000-000000000001';
/** The deployed diagnostics Worker: the test's own address, as the CLI takes none built in. */
const WORKER_URL = 'https://diagnostics.ds-c09.workers.dev';
/** The Worker's report ids: 8 characters without 0, 1, I and O. */
const REPORT_ID = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const RUN_TIMEOUT_MS = 120_000;

/** A JWT-shaped token: the CLI decodes the payload's `sub` and never verifies it. */
function fakeAccessToken(sub) {
  return [{ alg: 'none', typ: 'JWT' }, { sub, exp: 1 }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.') + '.unsigned';
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-integration-report-home-'));
  const deviceDir = path.join(home, '.desktop-commander-device');
  fs.mkdirSync(deviceDir, { recursive: true });
  fs.writeFileSync(path.join(deviceDir, 'device.json'), JSON.stringify({
    deviceId: TEST_DEVICE_ID,
    session: { access_token: fakeAccessToken(TEST_USER_ID), refresh_token: 'test-refresh-token' },
  }, null, 2));
  return home;
}

function runReport(home, args = []) {
  return new Promise((resolve) => {
    const { FORCE_COLOR, ...inherited } = process.env;
    const child = spawn(process.execPath, [CLI, 'remote', '--report', ...args], {
      cwd: home,
      env: {
        ...inherited,
        HOME: home,
        USERPROFILE: home,
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
        DC_FLAG_URL: 'http://127.0.0.1:9/',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function savedZip(result, home) {
  const saved = result.output.match(/Saved: (.+\.zip) \(/)?.[1];
  assert.ok(saved, `a "Saved:" line:\n${result.output}`);
  assert.ok(saved.startsWith(home), `the zip is in the temporary home: ${saved}`);
  assert.ok(fs.existsSync(saved), `the zip exists: ${saved}`);
  return saved;
}

async function main() {
  const { uploadReport } = await import('../../dist/remote-device/diagnostics/upload.js');
  console.log(`Worker: ${WORKER_URL}${process.env.MCP_SERVER_URL ? `, server: ${process.env.MCP_SERVER_URL}` : ''}`);
  const home = makeHome();
  const options = { diagnosticsUrl: WORKER_URL, userId: TEST_USER_ID, deviceId: TEST_DEVICE_ID };
  try {
    console.log('\n[Case 1] remote --report --no-upload saves the zip');
    const kept = await runReport(home, ['--no-upload']);
    assert.strictEqual(kept.code, 0, `exit code ${kept.code}:\n${kept.output}`);
    const zip = savedZip(kept, home);
    assert.ok(!/Sent to|Not sent/.test(kept.output), `no upload line:\n${kept.output}`);
    assert.match(kept.output, /Reply to your support conversation with this file attached\./);
    console.log('[Case 1] PASS - saved, not sent');

    console.log('\n[Case 2] the zip uploads to the Worker');
    const id = await uploadReport(fs.readFileSync(zip), options);
    assert.match(id, REPORT_ID, `a report id from the Worker: ${id}`);
    console.log(`[Case 2] PASS - report id ${id}`);

    console.log('\n[Case 3] a non-zip is refused with the Worker\'s message');
    await assert.rejects(uploadReport(Buffer.from('not a zip'), options), (error) => {
      assert.match(error.message, /^the server answered 415: \S/, error.message);
      console.log(`[Case 3] PASS - ${error.message}`);
      return true;
    });

    console.log(`\nAll assertions passed. Report id: ${id}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
