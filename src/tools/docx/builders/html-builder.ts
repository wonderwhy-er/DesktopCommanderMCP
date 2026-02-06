/**
 * HTML to DOCX Conversion using html-to-docx
 * 
 * This module provides functionality to convert HTML content to DOCX format
 * using the html-to-docx library. It handles HTML validation, wrapping,
 * and DOCX generation with proper formatting.
 * 
 * @module docx/builders/html-builder
 */

import { createRequire } from 'module';
import type { DocxBuildOptions } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { DEFAULT_BUILD_OPTIONS, HTML_WRAPPER_TEMPLATE } from '../constants.js';

const require = createRequire(import.meta.url);
const HTMLtoDOCX = require('html-to-docx');

/**
 * Ensure HTML has proper structure (DOCTYPE, html, head, body tags)
 * @param html - HTML content to validate/wrap
 * @returns Properly structured HTML
 */
function ensureHtmlStructure(html: string): string {
  const trimmed = html.trim();

  // If already has body/html tags, return as-is
  if (trimmed.includes('<body') || trimmed.includes('<html')) {
    return trimmed;
  }

  // Wrap content in proper HTML structure
  return HTML_WRAPPER_TEMPLATE.replace('{content}', trimmed);
}

/**
 * Create DOCX from HTML using html-to-docx library
 * 
 * @param html - HTML content to convert
 * @param options - Build options
 * @returns Buffer containing the DOCX file
 * @throws {DocxError} If conversion fails
 * 
 * @example
 * ```typescript
 * const html = '<h1>Title</h1><p>Content</p>';
 * const buffer = await createDocxFromHtml(html, {
 *   baseDir: '/path/to/images'
 * });
 * await fs.writeFile('output.docx', buffer);
 * ```
 */
export async function createDocxFromHtml(
  html: string,
  options: DocxBuildOptions = {}
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      if (!html || !html.trim()) {
        throw new DocxError(
          'HTML content cannot be empty',
          DocxErrorCode.DOCX_CREATE_FAILED,
          { htmlLength: 0 }
        );
      }

      // Ensure HTML has proper structure
      const processedHtml = ensureHtmlStructure(html);

      // Configure html-to-docx options
      const docxOptions = {
        table: { row: { cantSplit: true } },
        footer: DEFAULT_BUILD_OPTIONS.footer,
        pageNumber: DEFAULT_BUILD_OPTIONS.pageNumber,
        font: DEFAULT_BUILD_OPTIONS.font,
        fontSize: DEFAULT_BUILD_OPTIONS.fontSize,
        orientation: DEFAULT_BUILD_OPTIONS.orientation,
        margins: { ...DEFAULT_BUILD_OPTIONS.margins },
      };

      // Convert HTML to DOCX buffer
      const docxBuffer = await HTMLtoDOCX(processedHtml, null, docxOptions);

      if (!docxBuffer || docxBuffer.length === 0) {
        throw new DocxError(
          'Failed to generate DOCX: empty buffer returned',
          DocxErrorCode.DOCX_CREATE_FAILED,
          { htmlLength: html.length }
        );
      }

      return Buffer.from(docxBuffer);
    },
    DocxErrorCode.DOCX_CREATE_FAILED,
    { htmlLength: html.length }
  );
}
