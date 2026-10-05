/**
 * Integration test: `remote --report` uploads its zip to the deployed
 * diagnostics Worker.
 *
 * Runs the built CLI against the live services: the report's network checks go
 * to mcp.desktopcommander.app (MCP_SERVER_URL can point elsewhere), and the
 * upload to the Worker's default address (DC_DIAGNOSTICS_URL can point
 * elsewhere). It never uses the real home folder: a temporary HOME /
 * USERPROFILE holds a device.json that looks like a real sign-in, with ids
 * fixed and reserved for tests, never real Supabase ids: device
 * 00000000-0000-0000-0000-000000000001, and a fake, unsigned access token
 * whose payload has sub 00000000-0000-0000-0000-000000000000 (the CLI only
 * reads `sub`; nothing signs in or refreshes). Uploads land like any report,
 * under <user>/<device>/<YYYY-MM-DD-HHMM>-<id>.zip.
 *
 *   1. remote --report: exit 0, the zip in the temporary home, and
 *      "Sent to Desktop Commander support. Report id: <8 chars>".
 *   2. remote --report --no-upload: the zip, no "Sent" line.
 *   3. A non-zip POSTed straight to the Worker: 415.
 *
 * Needs a built dist/ (npm run test:integration builds it). Prints the report
 * id so it can be found in the bucket.
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
/** The Worker's report ids: 8 characters without 0, 1, I and O. */
const REPORT_ID = /\nSent to Desktop Commander support\. Report id: ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})\n/;
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
  const { DEFAULT_DIAGNOSTICS_URL } = await import('../../dist/remote-device/diagnostics/upload.js');
  const workerUrl = process.env.DC_DIAGNOSTICS_URL || DEFAULT_DIAGNOSTICS_URL;
  console.log(`Worker: ${workerUrl}${process.env.MCP_SERVER_URL ? `, server: ${process.env.MCP_SERVER_URL}` : ''}`);
  const home = makeHome();
  try {
    console.log('\n[Case 1] remote --report uploads the zip');
    const sent = await runReport(home);
    console.log(sent.output.split('\n').filter((line) => /^(Saved|Sent|Give|Not sent)/.test(line)).join('\n'));
    assert.strictEqual(sent.code, 0, `exit code ${sent.code}:\n${sent.output}`);
    savedZip(sent, home);
    const id = sent.output.match(REPORT_ID)?.[1];
    assert.ok(id, `a report id from the Worker:\n${sent.output}`);
    console.log(`[Case 1] PASS - report id ${id}`);

    console.log('\n[Case 2] remote --report --no-upload only saves the zip');
    const kept = await runReport(home, ['--no-upload']);
    assert.strictEqual(kept.code, 0, `exit code ${kept.code}:\n${kept.output}`);
    savedZip(kept, home);
    assert.ok(!/Sent to|Not sent/.test(kept.output), `no upload line:\n${kept.output}`);
    assert.match(kept.output, /Reply to your support conversation with this file attached\./);
    console.log('[Case 2] PASS - saved, not sent');

    console.log('\n[Case 3] a non-zip POSTed straight to the Worker');
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-DC-User-Id': TEST_USER_ID, 'X-DC-Device-Id': TEST_DEVICE_ID },
      body: 'not a zip',
      signal: AbortSignal.timeout(30_000),
    });
    assert.strictEqual(response.status, 415, `415 for a body that doesn't start with PK, got ${response.status}`);
    console.log('[Case 3] PASS - 415');

    console.log(`\nAll assertions passed. Report id: ${id}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
