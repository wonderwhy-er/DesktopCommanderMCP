/**
 * HTML → DOCX Conversion (html-to-docx)
 *
 * Converts processed HTML content into a DOCX buffer, injecting the original
 * document's default font and font size so unstyled text keeps its appearance.
 *
 * @module docx/builders/html-builder
 */

import { createRequire } from 'module';
import type { DocxBuildOptions, DocxDocumentDefaults } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { DEFAULT_BUILD_OPTIONS, HTML_WRAPPER_TEMPLATE } from '../constants.js';

const require = createRequire(import.meta.url);
const HTMLtoDOCX = require('html-to-docx');

// ─── HTML Structure Helpers ──────────────────────────────────────────────────

/** Build a `<style>` tag with the original document's default font/size as CSS `body` rules. */
function buildDefaultStyleTag(defaults?: DocxDocumentDefaults): string {
  if (!defaults) return '';
  const rules: string[] = [];
  if (defaults.font) rules.push(`font-family: '${defaults.font}'`);
  if (defaults.fontSize) rules.push(`font-size: ${defaults.fontSize}pt`);
  if (rules.length === 0) return '';
  return `<style>body { ${rules.join('; ')}; }</style>`;
}

/**
 * Ensure the HTML has a proper structure (DOCTYPE, `<html>`, `<head>`, `<body>`).
 * Injects the document-default CSS into `<head>` when available.
 */
function ensureHtmlStructure(html: string, defaults?: DocxDocumentDefaults): string {
  const trimmed = html.trim();
  const styleTag = buildDefaultStyleTag(defaults);

  if (!trimmed) {
    let wrapped = HTML_WRAPPER_TEMPLATE.replace('{content}', '');
    if (styleTag) wrapped = wrapped.replace('</head>', `${styleTag}\n</head>`);
    return wrapped;
  }

  const lower = trimmed.toLowerCase();
  const hasDoctype = lower.startsWith('<!doctype');
  const hasHtml = lower.includes('<html');
  const hasBody = lower.includes('<body');

  // Already complete — inject styles only
  if (hasDoctype && hasHtml && hasBody) {
    if (styleTag && trimmed.includes('</head>')) return trimmed.replace('</head>', `${styleTag}\n</head>`);
    return trimmed;
  }

  // Partial structure — add DOCTYPE, inject styles
  if (hasHtml || hasBody) {
    let result = `<!DOCTYPE html>\n${trimmed}`;
    if (styleTag && result.includes('</head>')) result = result.replace('</head>', `${styleTag}\n</head>`);
    return result;
  }

  // Plain fragment — wrap fully
  // Use split/join instead of replace to avoid $-pattern interpretation in base64 data URLs
  let wrapped = HTML_WRAPPER_TEMPLATE.split('{content}').join(trimmed);
  if (styleTag) wrapped = wrapped.replace('</head>', `${styleTag}\n</head>`);
  return wrapped;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a DOCX Buffer from HTML content.
 *
 * @param html - HTML content to convert
 * @param options - Build options (baseDir, documentDefaults, etc.)
 * @returns DOCX file as a Buffer
 */
export async function createDocxFromHtml(html: string, options: DocxBuildOptions = {}): Promise<Buffer> {
  return withErrorContext(
    async () => {
      if (!html?.trim()) {
        throw new DocxError('HTML content cannot be empty', DocxErrorCode.DOCX_CREATE_FAILED, { htmlLength: 0 });
      }

      const defaults = options.documentDefaults;
      const processedHtml = ensureHtmlStructure(html, defaults);

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
        throw new DocxError('Failed to generate DOCX: empty buffer', DocxErrorCode.DOCX_CREATE_FAILED, { htmlLength: html.length });
      }

      return Buffer.from(docxBuffer);
    },
    DocxErrorCode.DOCX_CREATE_FAILED,
    { htmlLength: html.length }
  );
}
