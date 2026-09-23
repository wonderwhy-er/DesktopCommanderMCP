import { createHash } from 'crypto';
import fs, { type FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';

import { validatePath } from './filesystem.js';

export const COPY_FILE_EXCLUSIVE_MAX_BYTES = 16 * 1024 * 1024;

export interface CopyFileExclusiveResult {
  bytes: number;
  sha256: string;
  destinationSha256: string;
  sourceDev: number;
  sourceIno: number;
  destinationDev: number;
  destinationIno: number;
  independentInode: true;
}

function expandHome(filePath: string): string {
  if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}
/**
 * Copy one regular file to a brand-new destination and verify exact bytes.
 *
 * The destination is opened with exclusive creation, so an existing file,
 * directory, or symlink is never replaced. The caller must provide the exact
 * expected size and SHA-256. Partial output created by this call is removed on
 * failure only when the destination pathname still identifies this call's inode.
 */
export async function copyFileExclusive(
  sourcePath: string,
  destinationPath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<CopyFileExclusiveResult> {
  if (!Number.isSafeInteger(expectedSize)
      || expectedSize < 0
      || expectedSize > COPY_FILE_EXCLUSIVE_MAX_BYTES) {
    throw new Error('copy_expected_size');
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('copy_expected_sha256');
  }

  const expandedSource = expandHome(sourcePath);
  const requestedSource = path.isAbsolute(expandedSource)
    ? path.resolve(expandedSource)
    : path.resolve(process.cwd(), expandedSource);

  const validSourcePath = await validatePath(sourcePath);
  const validDestPath = await validatePath(destinationPath);
  const requestedInfo = await fs.lstat(requestedSource);
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) {
    throw new Error('copy_source_regular_file_required');
  }

  const sourceInfo = await fs.lstat(validSourcePath);
  if (!sourceInfo.isFile()
      || sourceInfo.isSymbolicLink()
      || sourceInfo.dev !== requestedInfo.dev
      || sourceInfo.ino !== requestedInfo.ino
      || sourceInfo.size !== expectedSize) {
    throw new Error('copy_source_identity_or_size');
  }

  let sourceHandle: FileHandle | null = null;
  let destinationHandle: FileHandle | null = null;
  let destinationCreated = false;
  let destinationIdentity: { dev: number; ino: number } | null = null;
  let complete = false;

  try {
    sourceHandle = await fs.open(validSourcePath, 'r');
    const sourceOpened = await sourceHandle.stat();
    if (!sourceOpened.isFile()
        || sourceOpened.dev !== sourceInfo.dev
        || sourceOpened.ino !== sourceInfo.ino
        || sourceOpened.size !== expectedSize) {
      throw new Error('copy_source_open_drift');
    }

    destinationHandle = await fs.open(validDestPath, 'wx+', 0o600);
    destinationCreated = true;
    const destinationOpened = await destinationHandle.stat();
    destinationIdentity = { dev: destinationOpened.dev, ino: destinationOpened.ino };
    if (!destinationOpened.isFile()
        || (destinationOpened.dev === sourceOpened.dev
            && destinationOpened.ino === sourceOpened.ino)) {
      throw new Error('copy_destination_independence');
    }
    const sourceHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;

    while (total < expectedSize) {
      const want = Math.min(buffer.length, expectedSize - total);
      const { bytesRead } = await sourceHandle.read(buffer, 0, want, null);
      if (bytesRead <= 0) throw new Error('copy_source_short_read');

      sourceHash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer, offset, bytesRead - offset, null);
        if (bytesWritten <= 0) throw new Error('copy_destination_short_write');
        offset += bytesWritten;
      }
      total += bytesRead;
    }

    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: sourceExtra } = await sourceHandle.read(extra, 0, 1, null);
    if (sourceExtra !== 0 || total !== expectedSize) {
      throw new Error('copy_source_size_drift');
    }

    const sourceSha256 = sourceHash.digest('hex');
    if (sourceSha256 !== expectedSha256) {
      throw new Error('copy_source_digest');
    }

    await destinationHandle.sync();
    const destinationHash = createHash('sha256');
    let destinationTotal = 0;
    while (destinationTotal < expectedSize) {
      const want = Math.min(buffer.length, expectedSize - destinationTotal);
      const { bytesRead } = await destinationHandle.read(
        buffer, 0, want, destinationTotal);
      if (bytesRead <= 0) throw new Error('copy_destination_short_read');
      destinationHash.update(buffer.subarray(0, bytesRead));
      destinationTotal += bytesRead;
    }

    const { bytesRead: destinationExtra } = await destinationHandle.read(
      extra, 0, 1, expectedSize);
    const destinationSha256 = destinationHash.digest('hex');
    if (destinationExtra !== 0
        || destinationTotal !== expectedSize
        || destinationSha256 !== expectedSha256) {
      throw new Error('copy_destination_digest');
    }

    const [sourceFinal, sourcePathFinal, requestedFinal, destinationFinal, destinationPathFinal] =
      await Promise.all([
        sourceHandle.stat(),
        fs.lstat(validSourcePath),
        fs.lstat(requestedSource),
        destinationHandle.stat(),
        fs.lstat(validDestPath),
      ]);

    if (sourceFinal.dev !== sourceOpened.dev
        || sourceFinal.ino !== sourceOpened.ino
        || sourceFinal.size !== sourceOpened.size
        || sourcePathFinal.dev !== sourceOpened.dev
        || sourcePathFinal.ino !== sourceOpened.ino
        || requestedFinal.dev !== sourceOpened.dev
        || requestedFinal.ino !== sourceOpened.ino) {
      throw new Error('copy_source_final_drift');
    }
    if (!destinationFinal.isFile()
        || destinationFinal.size !== expectedSize
        || destinationPathFinal.dev !== destinationFinal.dev
        || destinationPathFinal.ino !== destinationFinal.ino
        || (destinationFinal.dev === sourceFinal.dev
            && destinationFinal.ino === sourceFinal.ino)) {
      throw new Error('copy_destination_final_identity');
    }

    complete = true;
    return {
      bytes: total,
      sha256: sourceSha256,
      destinationSha256,
      sourceDev: sourceFinal.dev,
      sourceIno: sourceFinal.ino,
      destinationDev: destinationFinal.dev,
      destinationIno: destinationFinal.ino,
      independentInode: true,
    };
  } finally {
    if (destinationHandle) await destinationHandle.close().catch(() => {});
    if (sourceHandle) await sourceHandle.close().catch(() => {});

    if (!complete && destinationCreated && destinationIdentity) {
      try {
        const current = await fs.lstat(validDestPath);
        if (current.dev === destinationIdentity.dev
            && current.ino === destinationIdentity.ino) {
          await fs.unlink(validDestPath);
        }
      } catch {
        // The destination is already gone or no longer ours. Never delete a
        // replacement entry while cleaning up a failed copy.
      }
    }
  }
}

[executed on device: trinity-do-engineering (c0baae6a-077b-4bca-854d-44acc8b544ea)]