/**
 * DOCX Editing Operations
 * 
 * This module provides functionality to edit DOCX files using HTML-based operations.
 * It uses mammoth to read DOCX → HTML, applies operations to HTML, then html-to-docx
 * to write back to DOCX format.
 * 
 * @module docx/operations
 */

import fs from 'fs/promises';
import path from 'path';
import type { DocxEditOptions, DocxOperation } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { parseDocxToHtml } from '../html.js';
import { createDocxFromHtml } from '../builders/html-builder.js';
import {
  markdownToHtml,
  markdownTableToHtml,
  buildMarkdownTableFromRows,
} from '../converters/markdown-to-html.js';
import { escapeRegExp } from '../utils.js';
import {
  DocxReplaceTextOperationSchema,
  DocxOperationSchema,
} from '../../schemas.js';

/**
 * Apply text replacement operation to HTML
 * @param html - HTML content
 * @param search - Text to search for
 * @param replace - Replacement text
 * @param matchCase - Whether to match case
 * @param global - Whether to replace all occurrences
 * @returns Modified HTML
 */
function applyReplaceText(
  html: string,
  search: string,
  replace: string,
  matchCase: boolean = false,
  global: boolean = true
): string {
  const flags = matchCase ? (global ? 'g' : '') : global ? 'gi' : 'i';
  const searchRegex = new RegExp(escapeRegExp(search), flags);
  return html.replace(searchRegex, replace);
}

/**
 * Apply append markdown operation to HTML
 * @param html - Current HTML content
 * @param markdown - Markdown content to append
 * @returns Modified HTML
 */
function applyAppendMarkdown(html: string, markdown: string): string {
  if (!markdown || !markdown.trim()) {
    return html;
  }

  const appendHtml = markdownToHtml(markdown);
  return html + '\n' + appendHtml;
}

/**
 * Apply insert table operation to HTML
 * @param html - Current HTML content
 * @param markdownTable - Markdown table string (optional)
 * @param rows - Table rows array (optional)
 * @returns Modified HTML
 */
function applyInsertTable(
  html: string,
  markdownTable?: string,
  rows?: string[][]
): string {
  let tableHtml = '';

  if (markdownTable) {
    tableHtml = markdownTableToHtml(markdownTable);
  } else if (rows && rows.length > 0) {
    const markdown = buildMarkdownTableFromRows(rows);
    tableHtml = markdownTableToHtml(markdown);
  }

  if (!tableHtml) {
    return html;
  }

  return html + '\n' + tableHtml;
}

/**
 * Apply insert image operation to HTML
 * @param html - Current HTML content
 * @param imagePath - Path to image (file path, URL, or data URL)
 * @param altText - Alt text for image
 * @param width - Image width (optional)
 * @param height - Image height (optional)
 * @param baseDir - Base directory for resolving relative paths
 * @returns Modified HTML
 */
function applyInsertImage(
  html: string,
  imagePath: string,
  altText: string = '',
  width?: number,
  height?: number,
  baseDir?: string
): string {
  if (!imagePath || !imagePath.trim()) {
    return html;
  }

  // Determine image source
  let imageSrc: string;
  if (imagePath.startsWith('data:') || imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    imageSrc = imagePath;
  } else {
    // Resolve relative path
    const resolvedPath = baseDir
      ? path.resolve(baseDir, imagePath)
      : path.resolve(imagePath);
    imageSrc = `file://${resolvedPath}`;
  }

  // Build image attributes
  const attributes: string[] = [`src="${imageSrc}"`];
  if (altText) {
    attributes.push(`alt="${altText.replace(/"/g, '&quot;')}"`);
  }
  if (width) {
    attributes.push(`width="${width}"`);
  }
  if (height) {
    attributes.push(`height="${height}"`);
  }

  const imgTag = `<img ${attributes.join(' ')} />`;
  return html + '\n' + imgTag;
}

/**
 * Apply a single operation to HTML content
 * @param html - Current HTML content
 * @param operation - Operation to apply
 * @param baseDir - Base directory for resolving paths
 * @returns Modified HTML
 */
function applyOperation(
  html: string,
  operation: DocxOperation,
  baseDir?: string
): string {
  switch (operation.type) {
    case 'replaceText':
      return applyReplaceText(
        html,
        operation.search,
        operation.replace,
        operation.matchCase,
        operation.global
      );

    case 'appendMarkdown':
      return applyAppendMarkdown(html, operation.markdown);

    case 'insertTable':
      return applyInsertTable(html, operation.markdownTable, operation.rows);

    case 'insertImage':
      return applyInsertImage(
        html,
        operation.imagePath,
        operation.altText,
        operation.width,
        operation.height,
        baseDir
      );

    default:
      throw new DocxError(
        `Unknown operation type: ${(operation as any).type}`,
        DocxErrorCode.UNKNOWN_OPERATION,
        { operation }
      );
  }
}

/**
 * Edit DOCX file using HTML-based operations
 * 
 * This function reads a DOCX file, converts it to HTML, applies the specified
 * operations, and converts the modified HTML back to DOCX format.
 * 
 * @param docxPath - Path to the DOCX file to edit
 * @param operations - Array of operations to apply
 * @param options - Edit options
 * @returns Buffer containing the modified DOCX file
 * @throws {DocxError} If editing fails
 * 
 * @example
 * ```typescript
 * const buffer = await editDocxWithOperations('document.docx', [
 *   { type: 'replaceText', search: 'old', replace: 'new' },
 *   { type: 'appendMarkdown', markdown: '# New Section\nContent' }
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
      // Validate input path
      if (!docxPath || !docxPath.toLowerCase().endsWith('.docx')) {
        throw new DocxError(
          'Invalid DOCX path: must end with .docx',
          DocxErrorCode.INVALID_PATH,
          { path: docxPath }
        );
      }

      // Validate operations
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new DocxError(
          'Operations array cannot be empty',
          DocxErrorCode.OPERATION_FAILED,
          { path: docxPath }
        );
      }

      const baseDir = options.baseDir ?? path.dirname(docxPath);

      // Read existing DOCX and convert to HTML
      const docxResult = await parseDocxToHtml(docxPath, {
        includeImages: options.includeImages ?? true,
        preserveFormatting: options.preserveFormatting ?? true,
      });

      let html = docxResult.html;

      // Apply operations sequentially
      for (const op of operations) {
        const validatedOp = DocxOperationSchema.parse(op);
        html = applyOperation(html, validatedOp, baseDir);
      }

      // Convert modified HTML back to DOCX
      return await createDocxFromHtml(html, { baseDir });
    },
    DocxErrorCode.DOCX_EDIT_FAILED,
    { path: docxPath, operationCount: operations.length }
  );
}
