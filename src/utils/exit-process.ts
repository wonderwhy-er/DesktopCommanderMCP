/**
 * Single place for ending the process on purpose. Use this instead of process.exit().
 *
 * process.exit() tears Node down at once, without waiting for work V8 still
 * runs on background threads. On Windows that aborts the process with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c"
 * and exit code 0xC0000409 instead of the one asked for, whenever V8 is still
 * compiling WebAssembly, e.g. the HTTP parser fetch() compiles right after a
 * download (nodejs/node#56645). An exit that happens because nothing is left
 * to do waits for that work.
 *
 * So exitProcess() sets the exit code and lets Node exit on its own. If
 * something keeps the process alive (stdin, a socket, a timer), process.exit()
 * ends it after EXIT_GRACE_MS, by which time that background work is done.
 * Either way 'exit' listeners run and pending stdout/stderr writes get the
 * grace period to flush.
 *
 * Unlike process.exit() this returns, and the process keeps running for up to
 * EXIT_GRACE_MS: callers return right after calling it. Only the first call
 * counts; later calls (a second Ctrl+C, a timeout firing) keep its exit code.
 */

/** Longest the process keeps running after exitProcess() */
export const EXIT_GRACE_MS = 1000;

let exitCode: number | undefined;

export function exitProcess(code: number): void {
  if (exitCode !== undefined) return;
  exitCode = code;
  process.exitCode = code;
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
}
