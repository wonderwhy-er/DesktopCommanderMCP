import { spawnSync } from 'child_process';
import { exitProcess } from './exit-process.js';

/**
 * Sizing libuv's thread pool from inside the process.
 *
 * libuv reads UV_THREADPOOL_SIZE once, when the pool starts (on the first
 * submitted work). Up to libuv 1.51 (Node 22) it reads it with the C runtime's
 * getenv(). On Windows the C runtime keeps its own copy of the environment,
 * taken when the process started, and process.env changes the process's
 * environment, not that copy: libuv never sees the new value and starts its
 * default 4 threads. libuv 1.52 (Node 24) reads the process's environment
 * (uv_os_getenv), and on macOS and Linux getenv() always does.
 *
 * Where libuv can't see process.env, the only way to size the pool is to start
 * the process again with the variable in its environment.
 */

/** In the copy that setThreadpoolSize() starts: the process ID of the process that started it */
export const LAUNCHER_PID_VARIABLE = 'DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID';

/** How often the copy checks that the process that started it still runs */
const LAUNCHER_CHECK_MS = 1000;

/** Whether libuv sees a UV_THREADPOOL_SIZE set in process.env: everywhere but on Windows with a libuv before 1.52 */
export function processEnvReachesThreadpool(platform: string = process.platform, uvVersion: string = process.versions.uv): boolean {
  if (platform !== 'win32') return true;
  const [major, minor] = uvVersion.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 52);
}

/**
 * Gives libuv's thread pool `size` threads (a UV_THREADPOOL_SIZE value). Call
 * it before any thread-pool work, before anything else sets the variable.
 *
 * - If process.env already has this value, it was there when Node started,
 *   and libuv reads it: nothing to do.
 * - Where libuv sees process.env (`envReachesThreadpool`), it sets the variable there.
 * - Elsewhere it runs this process again: the same Node, options, script and
 *   arguments, stdin, stdout and stderr, with the variable in the copy's
 *   environment. It waits for the copy and exits with the copy's exit code, so
 *   this process runs none of the code after the call. If the copy can't
 *   start, it returns, and the pool keeps libuv's default size.
 * - In that copy, it only makes sure the copy ends when the process that
 *   started it is gone.
 */
export function setThreadpoolSize(size: string, envReachesThreadpool: boolean = processEnvReachesThreadpool()): void {
  const launcherPid = process.env[LAUNCHER_PID_VARIABLE];
  if (launcherPid) {
    // The commands and servers the copy starts are not copies
    delete process.env[LAUNCHER_PID_VARIABLE];
    exitWithLauncher(Number(launcherPid));
    return;
  }
  if (process.env.UV_THREADPOOL_SIZE === size) return;
  process.env.UV_THREADPOOL_SIZE = size;
  // A debugger stays on the process Node started, which would only wait for the
  // copy, and the copy couldn't open the same inspector port
  const debugging = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].some((option) => option.includes('--inspect'));
  if (envReachesThreadpool || debugging) return;

  const copy = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, [LAUNCHER_PID_VARIABLE]: String(process.pid) },
  });
  if (copy.error) return;
  // process.exit(), not exitProcess(): this process must stop here, without
  // running the rest of its code; the copy has run it
  process.exit(copy.status ?? 1);
}

/**
 * Ends the copy once the process that started it is gone. A client stops a
 * server by ending the process it started; without this, the copy, which does
 * the server's work, would keep running.
 */
function exitWithLauncher(pid: number): void {
  const timer = setInterval(() => {
    try {
      // Signal 0 only checks that the process still runs
      process.kill(pid, 0);
    } catch (error) {
      // EPERM: it runs, under another user
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      clearInterval(timer);
      exitProcess(1);
    }
  }, LAUNCHER_CHECK_MS);
  timer.unref();
}
