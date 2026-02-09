/**
 * DOCX Editing Operations
 * 
 * Reads DOCX → HTML (via direct XML parser or mammoth fallback),
 * applies a sequence of operations to the HTML DOM,
 * then converts the modified HTML → DOCX (html-to-docx).
 * 
 * @module docx/operations
 */

import path from 'path';
import type { DocxEditOptions, DocxOperation } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { parseDocxToHtml } from '../html.js';
import { createDocxFromHtml } from '../builders/html-builder.js';
import { DEFAULT_CONVERSION_OPTIONS } from '../constants.js';
import { DocxOperationSchema } from '../../schemas.js';
import { validateDocxPath, validateOperations } from '../validators.js';
import { applyOperation } from './handlers/index.js';
import { preprocessOperations } from './preprocessor.js';

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

      // Preprocess operations (e.g., convert local image paths to base64)
      const preprocessedOps = await preprocessOperations(operations, baseDir);

      // Apply each operation sequentially
      for (let i = 0; i < preprocessedOps.length; i++) {
        const op = preprocessedOps[i];
        try {
          const validatedOp = DocxOperationSchema.parse(op);
          html = applyOperation(html, validatedOp, baseDir);
        } catch (error) {
          if (error instanceof DocxError) throw error;
          
          // Zod validation errors
          if (error instanceof Error && 'issues' in error) {
            throw new DocxError(
              `Invalid operation at index ${i}: ${error.message}`,
              DocxErrorCode.OPERATION_FAILED,
              { path: normalizedPath, operationIndex: i, operation: op, validationError: error }
            );
          }
          
          // Other errors
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
