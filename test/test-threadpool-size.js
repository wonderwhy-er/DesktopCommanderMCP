/**
 * setThreadpoolSize (src/utils/threadpool-size.ts) gives libuv's thread pool
 * its size from inside the process. src/bootstrap.ts uses it for the server's
 * 16 threads.
 *
 * On Windows with Node 22 (libuv before 1.52), libuv reads UV_THREADPOOL_SIZE
 * only from the environment the process started with, so a value set through
 * process.env never counts. There setThreadpoolSize runs the same script again
 * with the variable in its environment, waits for that copy, and exits with
 * its exit code.
 *
 * Checks which libuv versions need that, and how the copy behaves: on every
 * system, by telling setThreadpoolSize that libuv can't see process.env. A
 * small script calls it and prints what the process that goes on sees.
 */
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { LAUNCHER_PID_VARIABLE, processEnvReachesThreadpool } from '../dist/utils/threadpool-size.js';
import { runIfMain } from './helpers/run-if-main.js';
import { runNode } from './helpers/run-node.js';
import { createTempDir } from './helpers/test-env.js';
import { waitUntil } from './helpers/wait.js';

const MODULE_URL = new URL('../dist/utils/threadpool-size.js', import.meta.url).href;

/**
 * A script that calls setThreadpoolSize('7') as if libuv couldn't see
 * process.env, then prints one JSON line: its process ID and its parent's, UV_THREADPOOL_SIZE,
 * whether the launcher's variable is still in its environment, its arguments
 * and DC_TEST_USER_VALUE. With the argument `wait` it then keeps running;
 * otherwise it exits with the code given as its second argument.
 */
function writeScript(dir) {
  const script = path.join(dir, 'set-size.mjs');
  fs.writeFileSync(script, `
import { setThreadpoolSize } from ${JSON.stringify(MODULE_URL)};
setThreadpoolSize('7', false);
console.log(JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  size: process.env.UV_THREADPOOL_SIZE,
  launcherVariable: process.env[${JSON.stringify(LAUNCHER_PID_VARIABLE)}] !== undefined,
  args: process.argv.slice(2),
  userValue: process.env.DC_TEST_USER_VALUE,
}));
const [mode, code] = process.argv.slice(2);
if (mode === 'wait') setInterval(() => {}, 1000);
else process.exitCode = Number(code);
`);
  return script;
}

/** The environment for the script: this process's, without a UV_THREADPOOL_SIZE unless `extra` sets one */
function scriptEnv(extra = {}) {
  const { UV_THREADPOOL_SIZE, ...env } = process.env;
  return { ...env, ...extra };
}

/** The JSON lines the script printed */
function printed(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function testWhichLibuvNeedsACopy() {
  assert.strictEqual(processEnvReachesThreadpool('win32', '1.51.0'), false, 'Node 22 on Windows: libuv 1.51 reads the startup environment');
  assert.strictEqual(processEnvReachesThreadpool('win32', '1.49.2'), false, 'Node 22.12 on Windows: libuv 1.49');
  assert.strictEqual(processEnvReachesThreadpool('win32', '1.52.0'), true, 'libuv 1.52 reads process.env (uv_os_getenv)');
  assert.strictEqual(processEnvReachesThreadpool('win32', '1.52.1'), true, 'Node 24 on Windows');
  assert.strictEqual(processEnvReachesThreadpool('win32', '2.0.0'), true, 'a later major version');
  assert.strictEqual(processEnvReachesThreadpool('linux', '1.51.0'), true, 'Linux: setenv() updates what getenv() reads');
  assert.strictEqual(processEnvReachesThreadpool('darwin', '1.51.0'), true, 'macOS: the same');
  console.log('✓ only Windows with a libuv before 1.52 needs the script started again');
}

async function testCopyRunsTheRest(script) {
  const child = await runNode([script, 'exit', '3'], { env: scriptEnv({ DC_TEST_USER_VALUE: 'kept' }) });
  const lines = printed(child.stdout);
  assert.strictEqual(lines.length, 1, `only the copy should run the code after the call, got:\n${child.stdout}${child.stderr}`);
  const [copy] = lines;
  assert.strictEqual(child.status, 3, `the script should exit with the copy's exit code, got ${child.status}:\n${child.stderr}`);
  assert.notStrictEqual(copy.parentPid, process.pid, 'the code after the call should run in a copy, started by the script, not by this test');
  assert.strictEqual(copy.size, '7', 'the copy should have UV_THREADPOOL_SIZE in its environment');
  assert.deepStrictEqual(copy.args, ['exit', '3'], 'the copy should get the same arguments');
  assert.strictEqual(copy.userValue, 'kept', 'the copy should get the rest of the environment');
  assert.strictEqual(copy.launcherVariable, false, 'the copy should drop the launcher variable, so the commands it starts are not taken for copies');
  console.log('✓ the copy runs the rest of the script with the size, the same arguments and environment, and its exit code is the script\'s');
}

async function testSizeAlreadySet(script) {
  const child = await runNode([script, 'exit', '0'], { env: scriptEnv({ UV_THREADPOOL_SIZE: '7' }) });
  const [only] = printed(child.stdout);
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(only.parentPid, process.pid, 'a size already in the environment at start counts: no copy');
  console.log('✓ a size that was in the environment when Node started needs no copy');
}

async function testNoCopyUnderADebugger(script) {
  const child = await runNode(['--inspect=127.0.0.1:0', script, 'exit', '0'], { env: scriptEnv() });
  const [only] = printed(child.stdout);
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(only.parentPid, process.pid, 'with a debugger attached the script should go on in its own process');
  console.log('✓ no copy when Node was started with --inspect: the debugger stays on the process that runs the code');
}

async function testCopyEndsWithLauncher(script) {
  const launcher = spawn(process.execPath, [script, 'wait'], { env: scriptEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  launcher.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  let copyPid;
  try {
    await waitUntil(() => stdout.includes('\n'), 15_000, 'the copy prints its process ID');
    copyPid = printed(stdout)[0].pid;
    assert.notStrictEqual(copyPid, launcher.pid, 'the script should have started a copy');
    launcher.kill();
    await waitUntil(() => !isRunning(copyPid), 10_000, `the copy (${copyPid}) exits after the launcher (${launcher.pid}) was killed`);
    console.log('✓ the copy ends when the process that started it is killed, as a client ends a server');
  } finally {
    launcher.kill();
    if (copyPid && isRunning(copyPid)) process.kill(copyPid);
  }
}

export default async function runTests() {
  testWhichLibuvNeedsACopy();
  const dir = createTempDir('dc-threadpool-size-');
  try {
    const script = writeScript(dir);
    await testCopyRunsTheRest(script);
    await testSizeAlreadySet(script);
    await testNoCopyUnderADebugger(script);
    await testCopyEndsWithLauncher(script);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
