import fs from 'fs/promises';
import os from 'os';

/**
 * Single place for renaming files. Use this instead of fs.rename.
 *
 * Windows refuses to rename a file, or replace a destination, while another
 * process has it open (readers, antivirus and search indexers hold such
 * handles briefly) and reports EPERM, EACCES or EBUSY. Those errors are
 * retried with a short backoff. Any other error, and every error on
 * macOS/Linux, is thrown immediately.
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
      const transient = os.platform() === 'win32' && WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code);
      if (!transient || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * attempt, 100)));
    }
  }
}
