/**
 * The remote device's offline update works when the device runs from a
 * source checkout (npm run device:start), on every Node version.
 *
 * There setOffline() (src/remote-device/remote-channel.ts) starts
 * src/remote-device/scripts/blocking-offline-update.js with plain `node`,
 * without tsx. The script needs exitProcess(): loading it from
 * src/utils/exit-process.ts works only where Node strips types (22.18+), so on
 * older Node the script failed at import and the device stayed online.
 *
 * Runs the source script against a local stand-in for Supabase with type
 * stripping turned off, as on Node before 22.18.
 */
import assert from 'assert';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_SCRIPT = path.join(PROJECT_ROOT, 'src/remote-device/scripts/blocking-offline-update.js');
const DEVICE_ID = 'source-mode-device';

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** An access token that looks live to the script: it goes straight to the update */
const ACCESS_TOKEN = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;

/** Node 22.18+ strips types by default; older Node has no flag or has it off */
const NO_TYPE_STRIPPING = process.features.typescript ? ['--no-experimental-strip-types'] : [];

function runScript(supabaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NO_TYPE_STRIPPING, SOURCE_SCRIPT, DEVICE_ID, supabaseUrl, 'test-anon-key', ACCESS_TOKEN, ''], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function run() {
  const updates = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'PATCH' && request.url.startsWith('/rest/v1/mcp_devices')) {
        updates.push(request.url);
        response.writeHead(204).end();
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"not found"}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { code, output } = await runScript(`http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(code, 0,
      `run from a source checkout without type stripping, the offline update should mark the device offline (exit 0), got exit ${code}:\n${output.trim()}`);
    assert.strictEqual(updates.length, 1, `the stand-in should get one device update, got ${updates.length}`);
    console.log(`✓ source checkout, no type stripping: device marked offline (exit 0)`);
  } finally {
    server.close();
  }
}

runIfMain(import.meta.url, run);

export default run;
