import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/**
 * Single place for renaming files. Use this instead of fs.rename.
 *
 * Windows refuses to rename a file, or replace a destination, while another
 * process has it open (readers, antivirus and search indexers hold such
 * handles briefly) and reports EPERM, EACCES or EBUSY. Those errors are
 * retried with a short backoff. Any other error, one onto an existing
 * directory or a read-only file (Windows answers those with EPERM too, and
 * they never succeed), and every error on macOS/Linux, is thrown immediately.
 */

const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_BUDGET_MS = 5_000;

export async function renameWithRetry(from: string, to: string): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error: any) {
      const transient = os.platform() === 'win32' && WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code)
        && !(await cannotBeReplaced(to));
      if (!transient || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * attempt, 100)));
    }
  }
}

/**
 * Moves `from` to `to`, a file or a folder with everything in it, as mv does.
 * A rename can't reach another volume (EXDEV): the entry is then copied, next
 * to `to` under a temporary name, renamed onto `to` once the whole copy is
 * there, and only then is the source removed. A copy that fails removes what
 * it wrote, leaves the source as it was and throws its error.
 */
export async function movePath(from: string, to: string): Promise<void> {
  try {
    await renameWithRetry(from, to);
    return;
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
  }
  const copy = path.join(path.dirname(to), `.${path.basename(to)}.${process.pid}-${Date.now()}.moving`);
  try {
    // A link is copied as a link, as a rename moves it
    await fs.cp(from, copy, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    await renameWithRetry(copy, to);
  } catch (error) {
    await fs.rm(copy, { recursive: true, force: true }).catch((cleanupError) => {
      // The copy's error says why the move failed; this one is only logged
      logger.error(`Could not remove the partial copy ${copy}: ${cleanupError}`);
    });
    throw error;
  }
  await fs.rm(from, { recursive: true });
}

/** Whether `filePath` is what a rename never replaces on Windows: a directory, or a read-only file */
async function cannotBeReplaced(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filePath);
    return stats.isDirectory() || (stats.mode & 0o200) === 0;
  } catch {
    // Missing or unreadable: nothing says the rename can't succeed, so keep treating it as a held file
    return false;
  }
}
