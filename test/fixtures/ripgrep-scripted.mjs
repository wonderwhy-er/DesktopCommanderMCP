// A scripted ripgrep for the search tests (see ripgrep-still-searching-hooks.mjs):
// no process runs. The search manager gets a child process that prints the
// script's stdout lines and stderr text, then ends as the script says:
// - exit: an exit code, a signal name ("SIGKILL"), or null to search on until stopped;
// - delayMs: 0 ends it before start_search answers (start_search waits up to
//   40 ms), more ends it later, for get_more_search_results to see.
import { EventEmitter } from 'node:events';

/** stdout or stderr: sends Buffers, or strings once setEncoding() was called, as a stream does */
class Output extends EventEmitter {
  setEncoding(encoding) {
    this.encoding = encoding;
    return this;
  }

  send(text) {
    if (text) this.emit('data', this.encoding ? text : Buffer.from(text));
  }
}

export function scriptedRipgrep({ stdout = [], stderr = '', exit = null, delayMs = 0 }) {
  const child = new EventEmitter();
  child.stdout = new Output();
  child.stderr = new Output();
  child.killed = false;
  let closed = false;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('close', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    setImmediate(() => close(null, signal));
    return true;
  };
  const run = () => {
    if (closed) return;
    child.stdout.send(stdout.map((line) => `${line}\n`).join(''));
    child.stderr.send(stderr);
    if (exit !== null) close(typeof exit === 'number' ? exit : null, typeof exit === 'string' ? exit : null);
  };
  // The search manager listens for 'close' once its handlers are set up: the
  // output comes after that, in this turn of the event loop or after delayMs
  child.once('newListener', function started(event) {
    if (event !== 'close') {
      child.once('newListener', started);
      return;
    }
    if (delayMs > 0) setTimeout(run, delayMs);
    else queueMicrotask(run);
  });
  process.nextTick(() => child.emit('spawn'));
  return child;
}
