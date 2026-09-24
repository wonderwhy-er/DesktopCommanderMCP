import fs from 'fs/promises';
import path from 'path';
import { renameWithRetry } from './rename.js';
import { logger } from './logger.js';

/**
 * Single place for crash-safe file writes. Data goes to a temp file next to
 * the target and a rename swaps it in, so readers only ever see the previous
 * or the new complete file — never a truncated one.
 *
 * - The temp file's data is flushed to disk before the rename: otherwise the
 *   new name can reach the disk before the data, and a crash or power loss
 *   leaves the file empty or zero-filled (#697, #692). On macOS/Linux the
 *   folder is flushed after the rename, so the rename itself survives.
 * - Writes to the same file from this process run one after another, so the
 *   per-process temp name (`<file>.<pid>.tmp`) can't collide; the pid keeps
 *   separate processes off each other's temp file.
 * - The swap goes through renameWithRetry, which rides out Windows' brief
 *   locks on files other processes have open.
 */

const pendingWrites = new Map<string, Promise<void>>();

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

async function writeThroughTempFile(filePath: string, data: string | Uint8Array, options: AtomicWriteOptions): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    const handle = await fs.open(tempPath, 'w', options.mode);
    try {
      await handle.writeFile(data, { encoding: options.encoding ?? 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath);
  } finally {
    // After a successful rename the temp file is gone (ENOENT); after a failed
    // write, removing it is best effort and the write's own error is what's reported
    await fs.unlink(tempPath).catch(() => {});
  }
  await syncFolder(path.dirname(filePath));
}

/**
 * macOS/Linux: flushes the folder, so a rename in it reaches the disk. Windows
 * can't open a folder for flushing, and NTFS journals the rename itself. The
 * new content is already committed when this runs, so a failure is logged,
 * not reported as a failed write.
 */
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.open(folder, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    logger.error(`Could not flush ${folder} after replacing a file in it: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Atomically replaces `filePath` with `data`. Resolves once the new content is
 * committed; rejects (leaving the previous file intact) if it can't be.
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const key = path.resolve(filePath);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  // The previous write's failure was already reported to its own caller; this one runs regardless
  const write = previous.catch(() => {}).then(() => writeThroughTempFile(key, data, options));

  pendingWrites.set(key, write);
  // Bookkeeping only: the caller gets `write` itself, with its rejection
  write.finally(() => {
    if (pendingWrites.get(key) === write) pendingWrites.delete(key);
  }).catch(() => {});

  return write;
}
