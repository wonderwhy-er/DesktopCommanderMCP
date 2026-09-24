/**
 * Helpers for tests that check processes against the OS rather than against
 * Desktop Commander's own bookkeeping: start a process tree
 * (fixtures/process-tree.js) whose processes report their PIDs, check which
 * PIDs still run, and kill what a failing test left behind.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const FIXTURE = fileURLToPath(new URL('../fixtures/process-tree.js', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new directory for one tree's PID files */
export function createPidDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-process-tree-'));
}

/**
 * Shell command starting a tree of `levels` processes (the command's program
 * and its descendants) that write their PIDs to `dir`. Quoted so it runs the
 * same in PowerShell, cmd and POSIX shells.
 */
export function processTreeCommand(dir, levels, ...flags) {
  return ['node', `"${FIXTURE}"`, `"${dir}"`, String(levels), ...flags].join(' ');
}

/** The PIDs written to `dir` so far, by level (level 1 first) */
export function readWrittenPids(dir) {
  return fs.readdirSync(dir)
    .filter((file) => /^\d+\.pid$/.test(file))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => Number(fs.readFileSync(path.join(dir, file), 'utf8')));
}

/** The PIDs of a tree's `levels` processes, waiting until every level has written its PID */
export async function readTreePids(dir, levels, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = readWrittenPids(dir);
    if (pids.length === levels) return pids;
    if (Date.now() >= deadline) {
      throw new Error(`Only ${pids.length} of ${levels} tree processes reported a PID within ${timeoutMs}ms`);
    }
    await sleep(50);
  }
}

/** Whether a process with this PID is running */
export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // Exists, but belongs to another user
  }
}

/** macOS/Linux: the process group of `pid` */
export function processGroupOf(pid) {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
}

/** Waits until none of `pids` runs. Returns the ones still running at the deadline. */
export async function waitForExit(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let running = pids.filter(isRunning);
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(50);
    running = running.filter(isRunning);
  }
  return running;
}

/**
 * Test cleanup, run even when assertions fail: kills whichever of the given
 * PIDs still run and deletes the PID directories. Pass only PIDs the test's
 * own processes reported.
 */
export function cleanUpProcesses(pids, dirs = []) {
  const leftovers = [...new Set(pids)].filter((pid) => pid > 0 && isRunning(pid));
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // ESRCH: exited meanwhile. Anything else is reported, not thrown, so it can't hide the test's own failure.
      if (error.code !== 'ESRCH') console.log(`Cleanup: could not kill ${pid}: ${error.message}`);
    }
  }
  if (leftovers.length > 0) {
    console.log(`Cleanup: killed leftover test processes ${leftovers.join(', ')}`);
  }
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return leftovers;
}
