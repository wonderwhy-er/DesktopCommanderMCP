/**
 * Threadpool bootstrap. MUST be the first import in index.ts.
 *
 * Every fs operation (read_file, write_file, edit_block, config/history/log
 * persistence) runs on libuv's threadpool, which defaults to only 4 threads.
 * Under heavy parallel load — e.g. several agents reading/writing files on a
 * slow or cloud-synced filesystem — 4 stalled operations exhaust the pool, and
 * because a stalled syscall keeps its thread until the OS returns (a JS-level
 * timeout does not cancel it), every subsequent fs op queues for minutes. That
 * surfaced as multi-minute tool-call hangs under parallel `claude -p` load.
 *
 * Raising the pool size gives enough headroom that a burst of slow reads no
 * longer starves the rest. libuv reads UV_THREADPOOL_SIZE only when the pool is
 * first initialized (on first submitted work), so this assignment has to happen
 * before ANY threadpool work — hence "first import". A user-provided value is
 * always respected.
 */
const DEFAULT_THREADPOOL_SIZE = 16;

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(DEFAULT_THREADPOOL_SIZE);
}
