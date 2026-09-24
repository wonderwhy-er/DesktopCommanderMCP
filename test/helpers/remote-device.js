import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { signalProcessGroup } from './process-tree.js';

/**
 * A real remote device process (dist/remote-device/device.js), started the way
 * a service runs `desktop-commander remote`, for tests that start, stop and
 * restart one against the stand-in (remote-stand-in.js). Point it there with
 * MCP_SERVER_URL in the environment it gets.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEVICE = path.join(PROJECT_ROOT, 'dist/remote-device/device.js');
/** A stopped device ends within its own 5 s shutdown limit; SIGKILL after far longer */
const STOP_GRACE_MS = 30_000;

/** Printed once a start got past registration, reachable or not */
export const STARTED = /- Device ID:\s+\S/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the device keeps its device id and session, in `home` */
export const deviceConfigPath = (home) => path.join(home, '.desktop-commander-device', 'device.json');

/** Writes the device's config in `home`, as a device saves it */
export function writeDeviceConfig(home, config) {
  fs.mkdirSync(path.dirname(deviceConfigPath(home)), { recursive: true });
  fs.writeFileSync(deviceConfigPath(home), JSON.stringify(config, null, 2));
}

/** Starts a device process: `desktop-commander remote` as a service runs it */
export function startDevice(env, args = []) {
  const child = spawn(process.execPath, [DEVICE, ...args], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group on macOS/Linux, so a stop reaches the local MCP child
    // too, as a systemd unit's control group does
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const device = { child, output: '', exited: false, code: null, signal: null };
  child.stdout.on('data', (data) => { device.output += data; });
  child.stderr.on('data', (data) => { device.output += data; });
  device.closed = new Promise((resolve) => child.on('close', (code, signal) => {
    Object.assign(device, { exited: true, code, signal });
    resolve();
  }));
  return device;
}

/** `desktop-commander remote --logout`, as the user runs it; resolves with its exit code and output */
export function runLogout(env) {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'dist/index.js'), 'remote', '--logout'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, output })));
}

/** Waits until `predicate` holds or the device exits; returns the predicate's last value */
export async function waitFor(device, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && !device.exited && Date.now() < deadline) await sleep(100);
  return predicate();
}

/** The last lines of a device's output, indented for an assertion message */
export const tail = (output) => output.trim().split(/\r?\n/).slice(-25).map((line) => `      | ${line}`).join('\n');

/** kill -9 of the whole unit, local MCP child included: a crash, an OOM kill, a power cut */
export async function stopHard(device) {
  if (!device.exited) {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnSync(taskkill, ['/PID', String(device.child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      signalProcessGroup(device.child.pid, 'SIGKILL');
    }
  }
  await device.closed;
  // Whatever of the group outlived it
  if (process.platform !== 'win32') signalProcessGroup(device.child.pid, 'SIGKILL');
}

/** systemctl stop / restart: SIGTERM to the whole unit, SIGKILL for what is left after a grace period */
export async function stopGracefully(device) {
  signalProcessGroup(device.child.pid, 'SIGTERM');
  const grace = setTimeout(() => signalProcessGroup(device.child.pid, 'SIGKILL'), STOP_GRACE_MS);
  await device.closed;
  clearTimeout(grace);
  signalProcessGroup(device.child.pid, 'SIGKILL');
}
