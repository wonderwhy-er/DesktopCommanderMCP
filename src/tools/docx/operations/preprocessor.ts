/**
 * DOCX Operation Preprocessor
 *
 * Preprocesses operations before execution (e.g., converting local image paths to base64).
 * Follows Single Responsibility Principle — only handles operation preprocessing.
 *
 * @module docx/operations/preprocessor
 */

import fs from 'fs/promises';
import type { DocxOperation, DocxInsertImageOperation } from '../types.js';
import { DocxError, DocxErrorCode } from '../errors.js';
import { isDataUrl, isUrl, resolveImagePath } from '../utils/paths.js';
import { getMimeType } from '../utils/images.js';

/**
 * Resolve local image paths to base64 data URLs before operations are applied.
 * html-to-docx cannot handle `file://` URLs — only base64 data URLs and HTTP URLs work.
 */
export async function preprocessOperations(
  operations: DocxOperation[],
  baseDir: string
): Promise<DocxOperation[]> {
  const processed: DocxOperation[] = [];

  for (const op of operations) {
    if (op.type !== 'insertImage') {
      processed.push(op);
      continue;
    }

    const imgOp = op as DocxInsertImageOperation;
    const trimmedPath = imgOp.imagePath?.trim();

    if (!trimmedPath || isDataUrl(trimmedPath) || isUrl(trimmedPath)) {
      processed.push(op);
      continue;
    }

    const resolvedPath = resolveImagePath(trimmedPath, baseDir);
    try {
      const imageBuffer = await fs.readFile(resolvedPath);
      const mimeType = getMimeType(resolvedPath) || 'image/png';
      processed.push({
        ...imgOp,
        imagePath: `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
      });
    } catch (err) {
      throw new DocxError(
        `Failed to read image file: ${trimmedPath} (resolved: ${resolvedPath}). ${
          err instanceof Error ? err.message : String(err)
        }`,
        DocxErrorCode.INVALID_IMAGE_FILE,
        { imagePath: trimmedPath, resolvedPath, baseDir }
      );
    }
  }

  return processed;
}

