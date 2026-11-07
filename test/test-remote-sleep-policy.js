import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { MCPDevice } from '../dist/remote-device/device.js';
import { runRemote } from '../dist/npm-scripts/remote.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const temporary = mkdtempSync(path.join(os.tmpdir(), 'dc-sleep-policy-'));
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let calls = [];
// Exercise caffeinate's actual options-to-args adapter without spawning a process.
childProcess.spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = 12345;
    child.unref = () => {};
    return child;
};
try { require('caffeinate'); } finally { childProcess.spawn = originalSpawn; }
after(() => rmSync(temporary, { recursive: true, force: true }));

async function run(t, flags, platform = 'darwin') {
    calls = [];
    const originalArgs = process.argv;
    process.argv = [process.execPath, 'remote-test', 'remote', ...flags];
    t.after(() => { process.argv = originalArgs; });
    t.mock.method(os, 'platform', () => platform);
    t.mock.method(os, 'homedir', () => temporary);
    t.mock.method(MCPDevice.prototype, 'start', async () => {});
    const originalConsole = Object.fromEntries(['log', 'warn', 'error', 'debug'].map(key => [key, console[key]]));
    t.after(() => Object.assign(console, originalConsole));
    for (const key of Object.keys(originalConsole)) console[key] = () => {};
    await runRemote();
    return calls;
}

test('AC-only mode passes the real -s switch and monitors the remote PID', async t => {
    assert.deepEqual(await run(t, ['--no-sleep-ac-only']), [
        { command: 'caffeinate', args: ['-w', process.pid, '-s'] },
    ]);
});

test('the default macOS sleep policy retains its original arguments', async t => {
    assert.deepEqual(await run(t, []), [
        { command: 'caffeinate', args: ['-w', process.pid] },
    ]);
});

test('disable-no-sleep takes precedence over the AC-only opt-in', async t => {
    assert.deepEqual(await run(t, ['--no-sleep-ac-only', '--disable-no-sleep']), []);
});

test('AC-only mode never spawns caffeinate on other operating systems', async t => {
    assert.deepEqual(await run(t, ['--no-sleep-ac-only'], 'linux'), []);
});
