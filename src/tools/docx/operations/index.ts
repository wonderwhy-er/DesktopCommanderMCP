/**
 * DOCX Editing Operations
 * 
 * This module provides functionality to edit DOCX files using HTML-based operations.
 * It uses mammoth to read DOCX → HTML, applies operations to HTML, then html-to-docx
 * to write back to DOCX format.
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

/**
 * Edit DOCX file using HTML-based operations
 * 
 * This function reads a DOCX file, converts it to HTML using mammoth, applies
 * the specified operations sequentially, and converts the modified HTML back
 * to DOCX format using html-to-docx.
 * 
 * The workflow is:
 * 1. Read DOCX file
 * 2. Convert DOCX → HTML (mammoth)
 * 3. Apply operations to HTML
 * 4. Convert HTML → DOCX (html-to-docx)
 * 
 * @param docxPath - Path to the DOCX file to edit
 * @param operations - Array of operations to apply sequentially
 * @param options - Edit options
 * @returns Buffer containing the modified DOCX file
 * @throws {DocxError} If editing fails
 * 
 * @example
 * ```typescript
 * // Replace text and append HTML content
 * const buffer = await editDocxWithOperations('document.docx', [
 *   { type: 'replaceText', search: 'old', replace: 'new', global: true },
 *   { type: 'appendHtml', html: '<h1>New Section</h1><p>Content here</p>' }
 * ]);
 * 
 * // Insert HTML after a specific element
 * const buffer2 = await editDocxWithOperations('document.docx', [
 *   { 
 *     type: 'insertHtml', 
 *     html: '<div>New content</div>',
 *     selector: 'h1',
 *     position: 'after'
 *   }
 * ]);
 * 
 * // Replace HTML elements
 * const buffer3 = await editDocxWithOperations('document.docx', [
 *   { 
 *     type: 'replaceHtml',
 *     selector: '.old-class',
 *     html: '<div class="new-class">New content</div>',
 *     replaceAll: true
 *   }
 * ]);
 * 
 * // Update HTML elements
 * const buffer4 = await editDocxWithOperations('document.docx', [
 *   { 
 *     type: 'updateHtml',
 *     selector: 'p',
 *     html: 'Updated content',
 *     attributes: { class: 'updated' },
 *     updateAll: false
 *   }
 * ]);
 * ```
 */
export async function editDocxWithOperations(
  docxPath: string,
  operations: DocxOperation[],
  options: DocxEditOptions = {}
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      // Validate inputs
      validateDocxPath(docxPath);
      validateOperations(operations);

      const normalizedPath = docxPath.trim();
      const baseDir = options.baseDir ?? path.dirname(normalizedPath);

      // Configure parse options
      const parseOptions = {
        includeImages: options.includeImages ?? DEFAULT_CONVERSION_OPTIONS.includeImages,
        preserveFormatting: options.preserveFormatting ?? DEFAULT_CONVERSION_OPTIONS.preserveFormatting,
        ...(options.styleMap && { styleMap: options.styleMap }),
      };
      
      // Read and convert DOCX to HTML
      const docxResult = await parseDocxToHtml(normalizedPath, parseOptions);
      let html = docxResult.html;

      // Apply operations sequentially
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        
        try {
          // Validate operation schema
          const validatedOp = DocxOperationSchema.parse(op);
          
          // Apply the operation using handler
          html = applyOperation(html, validatedOp, baseDir);
        } catch (error) {
          // Re-throw DocxError as-is (preserves context)
          if (error instanceof DocxError) {
            throw error;
          }
          
          // Handle Zod validation errors
          if (error instanceof Error && 'issues' in error) {
            throw new DocxError(
              `Invalid operation at index ${i}: ${error.message}`,
              DocxErrorCode.OPERATION_FAILED,
              { 
                path: normalizedPath,
                operationIndex: i,
                operation: op,
                validationError: error
              }
            );
          }
          
          // Wrap other errors
          throw new DocxError(
            `Failed to apply operation at index ${i}: ${error instanceof Error ? error.message : String(error)}`,
            DocxErrorCode.OPERATION_FAILED,
            { 
              path: normalizedPath,
              operationIndex: i,
              operation: op
            }
          );
        }
      }

      // Convert modified HTML back to DOCX
      return await createDocxFromHtml(html, { baseDir });
    },
    DocxErrorCode.DOCX_EDIT_FAILED,
    { path: docxPath, operationCount: operations.length }
  );
}
