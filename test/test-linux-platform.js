import assert from 'assert';
import {
  getDefaultShell,
  hasGraphicalSession,
  isHeadlessEnvironment,
  getRuntimeLabel,
} from '../dist/platform/runtime.js';
import {
  parsePosixProcessOutput,
  parseWindowsProcessOutput,
  listPlatformProcesses,
} from '../dist/platform/processes.js';
import {
  formatProcessList,
  redactProcessArgs,
} from '../dist/tools/process.js';

function testRuntimeDetection() {
  assert.strictEqual(getDefaultShell('linux', {}), '/bin/sh');
  assert.strictEqual(getDefaultShell('darwin', {}), '/bin/zsh');
  assert.strictEqual(getDefaultShell('linux', { SHELL: '/bin/bash' }), '/bin/bash');
  assert.strictEqual(getDefaultShell('win32', { COMSPEC: 'cmd.exe' }), 'powershell.exe');

  assert.strictEqual(hasGraphicalSession('linux', {}), false);
  assert.strictEqual(hasGraphicalSession('linux', { DISPLAY: ':0' }), true);
  assert.strictEqual(isHeadlessEnvironment('linux', {}), true);
  assert.strictEqual(isHeadlessEnvironment('linux', { WAYLAND_DISPLAY: 'wayland-0' }), false);
  assert.strictEqual(isHeadlessEnvironment('linux', { DESKTOP_COMMANDER_HEADLESS: 'false' }), false);
  assert.strictEqual(isHeadlessEnvironment('win32', {}), false);
  assert.strictEqual(getRuntimeLabel('linux', {}), 'headless');
}

function testProcessParsing() {
  const summary = [
    '  101     1 root      0.0  0.1  42 systemd',
    '  220   101 app       1.5  2.3  15 worker name',
  ].join('\n');
  const args = [
    '101 /sbin/init',
    '220 /opt/worker name --port 3000',
  ].join('\n');
  const linux = parsePosixProcessOutput(summary, args);

  assert.strictEqual(linux.length, 2);
  assert.deepStrictEqual(linux[1], {
    pid: 220,
    ppid: 101,
    user: 'app',
    cpu: '1.5',
    memory: '2.3',
    runtime: '15',
    command: 'worker name',
    args: '/opt/worker name --port 3000',
  });

  const windows = parseWindowsProcessOutput(JSON.stringify({
    pid: 500,
    ppid: 100,
    command: 'node.exe',
    args: 'node.exe server.js',
    memoryMb: 128.5,
  }));
  assert.strictEqual(windows.length, 1);
  assert.strictEqual(windows[0].memory, '128.5 MB');
}

function testSafeProcessFormatting() {
  const secretArgs = 'app --token abc123 PASSWORD=hunter2 https://me:secret@example.com';
  const redacted = redactProcessArgs(secretArgs);
  assert(!redacted.includes('abc123'));
  assert(!redacted.includes('hunter2'));
  assert(!redacted.includes(':secret@'));

  const processInfo = [{
    pid: 1,
    ppid: 0,
    user: 'root',
    command: 'app',
    cpu: '0.0',
    memory: '0.1',
    runtime: '5',
    args: secretArgs,
  }];
  const safeDefault = formatProcessList(processInfo, {
    includeArgs: false,
    offset: 0,
    limit: 100,
  });
  assert(!safeDefault.includes('Args:'));

  const explicitArgs = formatProcessList(processInfo, {
    includeArgs: true,
    offset: 0,
    limit: 100,
  });
  assert(explicitArgs.includes('[REDACTED]'));
  assert(!explicitArgs.includes('abc123'));
}

async function main() {
  testRuntimeDetection();
  testProcessParsing();
  testSafeProcessFormatting();
  const liveProcesses = await listPlatformProcesses();
  assert(liveProcesses.length > 0, 'live process listing should return results');
  assert(liveProcesses.every((item) => item.args === undefined));
  console.log(`✓ Linux platform adapter tests passed (${liveProcesses.length} live processes)`);
}

main().catch((error) => {
  console.error('✗ Linux platform adapter tests failed:', error);
  process.exit(1);
});
