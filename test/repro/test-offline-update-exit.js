// Repro: the remote device's shutdown script (blocking-offline-update.js)
// ends with process.exit() right after its fetch(), which aborts Node on
// Windows, and outlives the time its parent gives it when Supabase is slow.
//
// On shutdown the device (setOffline() in src/remote-device/remote-channel.ts)
// runs dist/remote-device/scripts/blocking-offline-update.js with
// spawnSync(..., { timeout: 3000 }) and reports exit code 0 as "marked as
// offline", 2 as "timed out", anything else as a failure. process.exit()
// while V8 still compiles fetch()'s HTTP parser on a background thread aborts
// Node with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and exit
// code 0xC0000409 (nodejs/node#56645, see src/utils/exit-process.ts): the
// update went through, but the parent logs a failure.
//
// The script talks to a local stand-in for Supabase, never the real one:
//   update:  answers the device update. It answers with a large body (the
//            updated rows) so fetch()'s parser is still being optimized when
//            the script exits: the race the real script runs into by chance.
//            Expects exit 0 on every run.
//   silent:  never answers. Expects the script's own timeout, exit 2, before
//            the parent's 3 s kill.
// Each run is started and killed the way the parent does it.
//
// Run: node test/repro/run-repro.js test-offline-update-exit.js
//      (REPRO_RUNS=30 update runs and 3 silent runs by default)
// Exit code: 1 if any run did not end with the expected code within the parent's time.
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { exitProcess } from '../../dist/utils/exit-process.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PROJECT_ROOT, 'dist/remote-device/scripts/blocking-offline-update.js');
const UPDATE_RUNS = Number(process.env.REPRO_RUNS || 30);
const SILENT_RUNS = 3;
/** setOffline() gives the script this long, then kills it */
const PARENT_TIMEOUT_MS = 3000;
const CRASH_CODE = 0xC0000409;
const DEVICE_ID = 'repro-device';
/** Rows returned for the update: enough data for V8 to optimize fetch()'s parser */
const UPDATE_RESPONSE = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({
  id: DEVICE_ID, status: 'offline', last_seen: new Date().toISOString(), note: `row ${i}`.padEnd(160, '.'),
})));

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** An access token that looks live to the script: it goes straight to the update */
const ACCESS_TOKEN = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: 'repro', exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;

let silent = false;
const requests = [];
const server = http.createServer((request, response) => {
  requests.push(`${request.method} ${request.url}`);
  if (silent) return; // Never answers: the script has to give up on its own
  request.resume();
  request.on('end', () => {
    if (request.method === 'PATCH' && request.url.startsWith('/rest/v1/mcp_devices')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(UPDATE_RESPONSE);
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"not found"}');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const supabaseUrl = `http://127.0.0.1:${server.address().port}`;

/** Runs the script like setOffline() does: resolves with its exit code or the signal it was killed with, and how long it took */
function runOnce() {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, DEVICE_ID, supabaseUrl, 'repro-anon-key', ACCESS_TOKEN, ''], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const parentTimeout = setTimeout(() => child.kill('SIGTERM'), PARENT_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(parentTimeout);
      resolve({ code, signal, ms: Date.now() - started, output });
    });
  });
}

function describe({ code, signal, output }) {
  if (signal) return `killed by the parent's ${PARENT_TIMEOUT_MS}ms timeout`;
  if (code === CRASH_CODE) return `exit 0x${code.toString(16).toUpperCase()}${output.includes('UV_HANDLE_CLOSING') ? ' (async.c assertion)' : ''}`;
  return `exit ${code}`;
}

async function scenario(name, runs, expected) {
  const tally = {};
  let unexpected = 0;
  let slowest = 0;
  let sample = '';
  for (let i = 0; i < runs; i++) {
    const run = await runOnce();
    const outcome = describe(run);
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    slowest = Math.max(slowest, run.ms);
    if (run.code !== expected) {
      unexpected++;
      sample ||= run.output.trim();
    }
  }
  console.log(`${name}: ${runs} runs (expects exit ${expected}), slowest ${slowest}ms: ${JSON.stringify(tally)}`);
  if (sample) console.log(`  output of a run that did not: ${sample.split('\n').slice(0, 3).join(' | ')}`);
  return unexpected;
}

let unexpected = 0;
try {
  unexpected += await scenario('update', UPDATE_RUNS, 0);
  const updates = requests.filter((line) => line.startsWith('PATCH /rest/v1/mcp_devices')).length;
  if (updates !== UPDATE_RUNS) {
    console.log(`  the stand-in got ${updates} device updates for ${UPDATE_RUNS} runs`);
    unexpected++;
  }
  silent = true;
  unexpected += await scenario('silent', SILENT_RUNS, 2);
} finally {
  server.closeAllConnections();
  server.close();
}

const total = UPDATE_RUNS + SILENT_RUNS;
console.log(unexpected > 0
  ? `REPRODUCED: ${unexpected} of ${total} runs did not end the way the parent expects`
  : `OK: all ${total} runs ended with the expected exit code within the parent's ${PARENT_TIMEOUT_MS}ms`);
exitProcess(unexpected > 0 ? 1 : 0);
