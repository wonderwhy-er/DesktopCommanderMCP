/**
 * DOCX Editing Operations
 * 
 * Reads DOCX → HTML (via direct XML parser or mammoth fallback),
 * applies a sequence of operations to the HTML DOM,
 * then converts the modified HTML → DOCX (html-to-docx).
 * 
 * @module docx/operations
 */

import fs from 'fs/promises';
import path from 'path';
import type { DocxEditOptions, DocxOperation, DocxInsertImageOperation } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { parseDocxToHtml } from '../html.js';
import { createDocxFromHtml } from '../builders/html-builder.js';
import { DEFAULT_CONVERSION_OPTIONS } from '../constants.js';
import { DocxOperationSchema } from '../../schemas.js';
import { validateDocxPath, validateOperations } from '../validators.js';
import { applyOperation } from './handlers/index.js';
import { isDataUrl, isUrl, resolveImagePath, getMimeType } from '../utils.js';

// ─── Image Preprocessing ─────────────────────────────────────────────────────

/**
 * Resolve local image paths to base64 data URLs before operations are applied.
 * html-to-docx cannot handle `file://` URLs — only base64 data URLs and HTTP URLs work.
 */
async function preprocessOperations(operations: DocxOperation[], baseDir: string): Promise<DocxOperation[]> {
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
      processed.push({ ...imgOp, imagePath: `data:${mimeType};base64,${imageBuffer.toString('base64')}` });
    } catch (err) {
      throw new DocxError(
        `Failed to read image file: ${trimmedPath} (resolved: ${resolvedPath}). ${err instanceof Error ? err.message : String(err)}`,
        DocxErrorCode.INVALID_IMAGE_FILE,
        { imagePath: trimmedPath, resolvedPath, baseDir }
      );
    }
  }

  return processed;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a sequence of edit operations to a DOCX file and return the modified DOCX as a Buffer.
 */
export async function editDocxWithOperations(
  docxPath: string,
  operations: DocxOperation[],
  options: DocxEditOptions = {}
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      validateDocxPath(docxPath);
      validateOperations(operations);

      const normalizedPath = docxPath.trim();
      const baseDir = options.baseDir ?? path.dirname(normalizedPath);

      const parseOptions = {
        includeImages: options.includeImages ?? DEFAULT_CONVERSION_OPTIONS.includeImages,
        preserveFormatting: options.preserveFormatting ?? DEFAULT_CONVERSION_OPTIONS.preserveFormatting,
        ...(options.styleMap && { styleMap: options.styleMap }),
      };
      
      // Read DOCX → HTML
      const docxResult = await parseDocxToHtml(normalizedPath, parseOptions);
      let html = docxResult.html;
      const { documentDefaults } = docxResult;

      // Resolve local image paths to base64
      const preprocessedOps = await preprocessOperations(operations, baseDir);

      // Apply each operation
      for (let i = 0; i < preprocessedOps.length; i++) {
        const op = preprocessedOps[i];
        try {
          html = applyOperation(html, DocxOperationSchema.parse(op), baseDir);
        } catch (error) {
          if (error instanceof DocxError) throw error;
          if (error instanceof Error && 'issues' in error) {
            throw new DocxError(
              `Invalid operation at index ${i}: ${error.message}`,
              DocxErrorCode.OPERATION_FAILED,
              { path: normalizedPath, operationIndex: i, operation: op, validationError: error }
            );
          }
          throw new DocxError(
            `Failed to apply operation at index ${i}: ${error instanceof Error ? error.message : String(error)}`,
            DocxErrorCode.OPERATION_FAILED,
            { path: normalizedPath, operationIndex: i, operation: op }
          );
        }
      }

      // HTML → DOCX, preserving the original document's default styles
      return await createDocxFromHtml(html, { baseDir, documentDefaults });
    },
    DocxErrorCode.DOCX_EDIT_FAILED,
    { path: docxPath, operationCount: operations.length }
  );
}
