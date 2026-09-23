// Repro: the product's own exit paths abort the process on Windows when they
// run right after a fetch() download.
//
// process.exit() while V8 is still compiling WebAssembly on a background
// thread (fetch()'s HTTP parser, right after its first sizeable download)
// aborts Node on Windows with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
// and exit code 0xC0000409 instead of the code the product chose
// (nodejs/node#56645). Each run starts a fresh process that downloads 4 MB
// from a local server with fetch() and then goes through one of the product's
// exit paths:
//   server: src/index.ts's uncaught-exception handler      (exit code 1)
//   device: src/remote-device/device.ts's Ctrl+C shutdown   (exit code 0)
// and counts the runs that ended with any other code.
//
// Run: node test/repro/run-repro.js test-exit-after-fetch.js   (REPRO_RUNS=20 per path by default)
// Exit code: 1 if any run ended with a code other than the product's.
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { exitProcess } from '../../dist/utils/exit-process.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
const ROLE = process.env.DC_EXIT_REPRO_ROLE;
const RUNS = Number(process.env.REPRO_RUNS || 20);
/** A run that has not exited by then is counted as hung and killed */
const RUN_LIMIT_MS = 20_000;
const CRASH_CODE = 0xC0000409;

async function download() {
  const response = await fetch(process.env.DC_EXIT_REPRO_URL);
  await response.arrayBuffer();
}

if (ROLE === 'server') {
  // Loaded with --import into the real server (dist/index.js). Once
  // src/index.ts has installed its handler, download and throw an uncaught
  // exception: the handler logs it and ends the process with code 1. (An
  // unhandled rejection no longer ends the server: it is logged and ignored.)
  const waitForHandler = setInterval(async () => {
    if (process.listenerCount('uncaughtException') === 0) return;
    clearInterval(waitForHandler);
    await download();
    setImmediate(() => { throw new Error('exit-after-fetch repro: uncaught exception right after a download'); });
  }, 10);
} else if (ROLE === 'device') {
  // A remote device whose user presses Ctrl+C right after a download:
  // MCPDevice's SIGINT handler shuts down and ends the process with code 0.
  const { MCPDevice } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'dist/remote-device/device.js')).href);
  new MCPDevice();
  await download();
  process.emit('SIGINT', 'SIGINT');
} else {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const server = http.createServer((request, response) => {
    for (let i = 0; i < 64; i++) response.write(chunk);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const paths = [
    { role: 'server', expected: 1, args: ['--import', pathToFileURL(THIS_FILE).href, path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'] },
    { role: 'device', expected: 0, args: [THIS_FILE] },
  ];

  const runOnce = ({ role, args }) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DC_EXIT_REPRO_ROLE: role, DC_EXIT_REPRO_URL: url },
      // stdin stays open: the server exits on stdin EOF, which would hide its exit path
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const limit = setTimeout(() => child.kill(), RUN_LIMIT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(limit);
      resolve({ code, signal, stderr });
    });
  });

  let unexpected = 0;
  for (const exitPath of paths) {
    const tally = {};
    for (let i = 0; i < RUNS; i++) {
      const { code, signal, stderr } = await runOnce(exitPath);
      let outcome = signal ? `hung, killed (${signal})` : `exit ${code}`;
      if (code === CRASH_CODE) {
        outcome = `exit 0x${code.toString(16).toUpperCase()}${stderr.includes('UV_HANDLE_CLOSING') ? ' (async.c assertion)' : ''}`;
      }
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      if (code !== exitPath.expected) unexpected++;
    }
    console.log(`${exitPath.role} exit path, ${RUNS} runs (expects exit ${exitPath.expected}): ${JSON.stringify(tally)}`);
  }
  server.close();

  console.log(unexpected > 0
    ? `REPRODUCED: ${unexpected} of ${RUNS * paths.length} runs did not end with the product's exit code`
    : `OK: all ${RUNS * paths.length} runs ended with the product's exit code`);
  exitProcess(unexpected > 0 ? 1 : 0);
}
