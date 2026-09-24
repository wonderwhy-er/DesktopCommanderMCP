import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { logger } from './logger.js';

/**
 * Ending a process together with every process it started.
 *
 * Desktop Commander runs commands through a shell (start_process) or a fresh
 * Node process (node:local), so the process it holds is only the root of what
 * the command runs: the shell starts the program, which may start more
 * (npm -> node -> a dev server holding a port). Killing the root alone ends
 * none of those. Windows never ends a process's children with it, and on
 * macOS/Linux a signal sent to one PID reaches only that process, so the
 * program kept running, orphaned, while the session was reported terminated.
 *
 * Both platforms find the tree the same way, through each process's parent
 * PID, so processes are spawned exactly as before: on macOS/Linux they stay
 * in the server's process group and session, and Ctrl+C, closing the
 * terminal and password prompts behave as they always did.
 * - Windows: taskkill /T /F ends the root and its descendants.
 * - macOS/Linux: a ps snapshot gives every process's parent. The root and its
 *   descendants get SIGTERM; after a grace period the tree is walked again,
 *   from the root and from every process found the first time (children
 *   started meanwhile), and whatever still runs gets SIGKILL.
 * Limit: a process whose parent exited before a walk has been reparented (to
 * init or a subreaper) and can no longer be found through its parent.
 *
 * Every path that ends a command DC runs for the client (force_terminate on a
 * start_process session, the node:local timeout) goes through terminateProcessTree.
 */

/** How long a process tree gets to exit after SIGTERM before SIGKILL (macOS/Linux) */
const TERMINATE_GRACE_MS = 1000;
/** How long the root gets to report its exit once it has been killed */
const EXIT_WAIT_MS = 2000;
/** Longest taskkill or ps may run */
const COMMAND_TIMEOUT_MS = 10000;
const POLL_MS = 50;

const isWindows = (): boolean => process.platform === 'win32';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once `child` has exited, false if it still runs after `timeoutMs` */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/** Runs a system command to completion: resolves its stdout, rejects with why it failed */
function runCommand(file: string, args: string[]): Promise<string> {
  const command = [file, ...args].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not finish within ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    // After a spawn error 'close' follows too; the promise keeps the first reason
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${command}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
        reject(new Error(`${command} ${how}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

/** macOS/Linux: every running process's children, from one ps snapshot */
async function snapshotChildren(): Promise<Map<number, number[]>> {
  // -A: all processes; -o pid=,ppid=: just those columns, no header. The same on macOS and Linux ps.
  const output = await runCommand('ps', ['-A', '-o', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const siblings = children.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      children.set(ppid, [pid]);
    }
  }
  return children;
}

/** `roots` and every process descended from them in `children` */
function withDescendants(roots: Iterable<number>, children: Map<number, number[]>): Set<number> {
  const found = new Set(roots);
  // Iterating a Set also visits the entries added during the iteration
  for (const pid of found) {
    for (const child of children.get(pid) ?? []) found.add(child);
  }
  return found;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // Runs, but as another user
  }
}

/** Sends `signal` to each of `pids`. Returns why it failed for any that had not exited already. */
function signalAll(pids: Iterable<number>, signal: NodeJS.Signals): string[] {
  const failures: string[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        failures.push(`${signal} to PID ${pid}: ${(error as Error).message}`);
      }
    }
  }
  return failures;
}

/** macOS/Linux: SIGTERM to `root` and its descendants, then SIGKILL to whatever of the tree still runs */
async function endPosixTree(root: number): Promise<void> {
  const tree = withDescendants([root], await snapshotChildren());
  const failures = signalAll(tree, 'SIGTERM');
  const deadline = Date.now() + TERMINATE_GRACE_MS;
  const anyRunning = () => [...tree].some(isRunning);
  while (anyRunning() && Date.now() < deadline) {
    await sleep(POLL_MS);
  }
  if (anyRunning()) {
    const current = withDescendants(tree, await snapshotChildren());
    failures.push(...signalAll([...current].filter(isRunning), 'SIGKILL'));
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

/** Windows: taskkill from the Windows directory rather than PATH, which a client may launch us with broken (see #481) */
function taskkillPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * Ends `child` and every process it started. Resolves once they are gone:
 * true, or false if some could not be ended (why is logged, and the root is
 * then killed on its own if it still runs). Never rejects.
 */
export async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return true;

  let failure: string | undefined;
  try {
    if (isWindows()) {
      await runCommand(taskkillPath(), ['/PID', String(pid), '/T', '/F']);
    } else {
      await endPosixTree(pid);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (!hasExited(child)) child.kill('SIGKILL');
  }
  if (!(await waitForExit(child, EXIT_WAIT_MS))) {
    failure = [failure, `PID ${pid} still runs ${EXIT_WAIT_MS}ms after being killed`].filter(Boolean).join('; ');
  }
  if (failure) {
    logger.error(`Could not end every process of PID ${pid}: ${failure}`);
    return false;
  }
  return true;
}
