import fs from 'fs/promises';
import path from 'path';
import { renameWithRetry } from './rename.js';

/**
 * Single place for crash-safe file writes. Data goes to a temp file next to
 * the target and a rename swaps it in, so readers only ever see the previous
 * or the new complete file — never a truncated one.
 *
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
    await fs.writeFile(tempPath, data, { encoding: options.encoding ?? 'utf8', mode: options.mode });
    await renameWithRetry(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

/**
 * Atomically replaces `filePath` with `data`. Resolves once the new content is
 * committed; rejects (leaving the previous file intact) if it can't be.
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const key = path.resolve(filePath);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => writeThroughTempFile(key, data, options));

  pendingWrites.set(key, write);
  write.finally(() => {
    if (pendingWrites.get(key) === write) pendingWrites.delete(key);
  }).catch(() => {});

  return write;
}
