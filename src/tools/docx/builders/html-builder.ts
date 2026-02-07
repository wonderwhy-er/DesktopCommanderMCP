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
import type { DocxBuildOptions, DocxDocumentDefaults } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { DEFAULT_BUILD_OPTIONS, HTML_WRAPPER_TEMPLATE } from '../constants.js';

const require = createRequire(import.meta.url);
const HTMLtoDOCX = require('html-to-docx');

/**
 * Build a CSS style tag with document default styles.
 * This ensures html-to-docx applies the original document's font/size
 * to any content that doesn't have explicit inline styles.
 */
function buildDefaultStyleTag(defaults?: DocxDocumentDefaults): string {
  if (!defaults) return '';
  const rules: string[] = [];
  if (defaults.font) rules.push(`font-family: '${defaults.font}'`);
  if (defaults.fontSize) rules.push(`font-size: ${defaults.fontSize}pt`);
  if (rules.length === 0) return '';
  return `<style>body { ${rules.join('; ')}; }</style>`;
}

/**
 * Ensure HTML has proper structure (DOCTYPE, html, head, body tags).
 * Optionally injects default document styles into the <head>.
 * @param html - HTML content to validate/wrap
 * @param defaults - Original document defaults (font, fontSize)
 * @returns Properly structured HTML
 */
function ensureHtmlStructure(html: string, defaults?: DocxDocumentDefaults): string {
  const trimmed = html.trim();
  const styleTag = buildDefaultStyleTag(defaults);

  if (!trimmed) {
    let wrapped = HTML_WRAPPER_TEMPLATE.replace('{content}', '');
    if (styleTag) wrapped = wrapped.replace('</head>', `${styleTag}\n</head>`);
    return wrapped;
  }

  // Check if HTML already has proper structure
  const hasDoctype = trimmed.toLowerCase().startsWith('<!doctype');
  const hasHtmlTag = trimmed.toLowerCase().includes('<html');
  const hasBodyTag = trimmed.toLowerCase().includes('<body');

  // If already has complete structure, inject styles and return
  if (hasDoctype && hasHtmlTag && hasBodyTag) {
    if (styleTag && trimmed.includes('</head>')) {
      return trimmed.replace('</head>', `${styleTag}\n</head>`);
    }
    return trimmed;
  }

  // If has body/html tags but no doctype, add doctype and inject styles
  if (hasHtmlTag || hasBodyTag) {
    let result = `<!DOCTYPE html>\n${trimmed}`;
    if (styleTag && result.includes('</head>')) {
      result = result.replace('</head>', `${styleTag}\n</head>`);
    }
    return result;
  }

  // Wrap content in proper HTML structure with default styles
  let wrapped = HTML_WRAPPER_TEMPLATE.replace('{content}', trimmed);
  if (styleTag) wrapped = wrapped.replace('</head>', `${styleTag}\n</head>`);
  return wrapped;
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

      const defaults = options.documentDefaults;

      // Ensure HTML has proper structure (DOCTYPE, html, head, body)
      // Inject original document default styles as CSS in <head>
      let processedHtml = ensureHtmlStructure(html, defaults);

      // Use original document defaults if available, otherwise fall back to built-in defaults
      const docxOptions = {
        table: { row: { cantSplit: true } },
        footer: DEFAULT_BUILD_OPTIONS.footer,
        pageNumber: DEFAULT_BUILD_OPTIONS.pageNumber,
        font: defaults?.font || DEFAULT_BUILD_OPTIONS.font,
        fontSize: defaults?.fontSize || DEFAULT_BUILD_OPTIONS.fontSize,
        orientation: DEFAULT_BUILD_OPTIONS.orientation,
        margins: { ...DEFAULT_BUILD_OPTIONS.margins },
      };

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
