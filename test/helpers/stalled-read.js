import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * Creates a path whose fs.readFile never completes, so each read holds a libuv
 * threadpool thread the way a read on a stalled cloud or network mount does.
 *
 * macOS/Linux: a FIFO that nobody writes to.
 * Windows: a named pipe whose server accepts every connection and never sends.
 *
 * Returns { path, close }; close() releases the pipe server / the FIFO's readers.
 */
export async function createStalledReadTarget(name = 'dc-stall') {
  const id = `${name}-${process.pid}-${Date.now()}`;

  if (process.platform !== 'win32') {
    // In the temporary folder's real path, like the test homes (see test-env.js)
    const fifo = path.join(fs.realpathSync.native(os.tmpdir()), id);
    // A child process, so it doesn't use the threadpool; no shell, so the path reaches it as written
    execFileSync('mkfifo', [fifo]);
    return {
      path: fifo,
      close: () => {
        // Readers blocked in open() hold threadpool threads, and Node waits for
        // those threads on exit: open the write end once so they get EOF
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch (error) {
          if (error.code !== 'ENXIO') throw error; // ENXIO: no reader is waiting
        }
        fs.rmSync(fifo, { force: true });
      },
    };
  }

  const pipePath = `\\\\.\\pipe\\${id}`;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    // Hold the connection open and never write: the reader's ReadFile blocks
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  server.unref();
  return {
    path: pipePath,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
