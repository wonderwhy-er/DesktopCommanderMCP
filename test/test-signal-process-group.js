#!/usr/bin/env node

/**
 * signalProcessGroup() (test/helpers/process-tree.js) must treat a process
 * group whose only processes are zombies as gone, not throw.
 *
 * DC-695: test/integration/remote-device-restart.js failed once on macOS inside
 * a full integration run: exit 1 after 15 s, instead of reporting its cases.
 * It stops each device by signalling the device's process group, then signals
 * the group again once the device has exited, for whatever of it outlived the
 * device. By then the only process left can be the device's killed local MCP
 * child, a zombie until launchd reaps it. macOS answers a signal to a group of
 * zombies with EPERM (measured with Node 24.15 on macOS 26.6: EPERM while the
 * zombie exists, ESRCH once it is reaped). Linux delivers the signal instead.
 * Only ESRCH counted as "gone", so the EPERM escaped a finally block and ended
 * the whole test file.
 *
 * The zombie-only group is made without timing luck: sh with job control
 * (set -m) starts a job in a process group of its own, then execs sleep, which
 * never reaps the job when it exits.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-signal-process-group.js
 */
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { processGroupOf, signalProcessGroup } from './helpers/process-tree.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ps state of `pid` (Z = zombie), or '' when there is no such process */
function stateOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** A process group holding one zombie: its PGID, and how to end the process that keeps it a zombie */
async function startZombieGroup() {
  const keeper = spawn('sh', ['-c', 'set -m; sleep 1 & echo $!; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await new Promise((resolve, reject) => {
    keeper.stdout.once('data', (data) => resolve(Number(String(data).trim())));
    keeper.once('error', reject);
  });
  const deadline = Date.now() + 10_000;
  while (!stateOf(pid).startsWith('Z') && Date.now() < deadline) await sleep(50);
  return { pgid: pid, state: stateOf(pid), group: processGroupOf(pid), end: () => keeper.kill('SIGKILL') };
}

/** Starts `command` in a process group of its own; resolves once it runs */
function startGroup(command) {
  const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
  child.exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return child;
}

async function runTests() {
  if (process.platform === 'win32') {
    skip('signalProcessGroup: process groups are macOS/Linux only');
    return true;
  }
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${name}\n   ${error.message}`);
    }
  }

  await test('a group whose only process is a zombie counts as gone', async () => {
    const zombie = await startZombieGroup();
    try {
      assert.ok(zombie.state.startsWith('Z') && zombie.group === zombie.pgid,
        `setup: expected a zombie leading its own group, got state "${zombie.state}", group ${zombie.group} for PID ${zombie.pgid}`);
      let thrown;
      try {
        signalProcessGroup(zombie.pgid, 'SIGKILL');
      } catch (error) {
        thrown = error;
      }
      assert.ok(!thrown,
        `signalling a process group whose only process is a zombie threw ${thrown?.code}: a device's killed local MCP child `
        + 'ends test/integration/remote-device-restart.js this way on macOS');
    } finally {
      zombie.end();
    }
  });

  await test('a group that is gone is not an error', async () => {
    const child = startGroup('exit 0');
    await child.exit;
    signalProcessGroup(child.pid, 'SIGKILL');
  });

  await test('a live group gets the signal', async () => {
    const child = startGroup('sleep 60');
    signalProcessGroup(child.pid, 'SIGKILL');
    const ended = await Promise.race([child.exit, sleep(5000).then(() => null)]);
    assert.strictEqual(ended?.signal, 'SIGKILL', `the group's process was not killed: ${JSON.stringify(ended)}`);
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} signalProcessGroup: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
