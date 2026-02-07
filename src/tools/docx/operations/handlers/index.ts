/**
 * DOCX Operation Handlers
 *
 * Pure functions: HTML in → modified HTML out.
 * Each handler corresponds to one DocxOperation type.
 *
 * @module docx/operations/handlers
 */

import type { DocxOperation } from '../../types.js';
import { DocxError, DocxErrorCode } from '../../errors.js';
import {
  markdownToHtml,
  markdownTableToHtml,
  buildMarkdownTableFromRows,
} from '../../converters/markdown-to-html.js';
import { appendHtml, insertHtml, replaceHtml, updateHtml } from '../html-manipulator.js';
import { escapeHtmlAttribute, escapeRegExp, isUrl, isDataUrl, resolveImagePath } from '../../utils.js';
import { validateImageDimensions } from '../../validators.js';

// ─── Text Operations ─────────────────────────────────────────────────────────

export function handleReplaceText(
  html: string,
  search: string,
  replace: string,
  matchCase = false,
  global = true
): string {
  if (!search?.trim()) return html;
  const flags = matchCase ? (global ? 'g' : '') : global ? 'gi' : 'i';
  return html.replace(new RegExp(escapeRegExp(search), flags), replace);
}

// ─── HTML / Markdown Append & Insert ─────────────────────────────────────────

export function handleAppendMarkdown(html: string, markdown: string): string {
  if (!markdown?.trim()) return html;
  const converted = markdownToHtml(markdown);
  return converted ? appendHtml(html, converted) : html;
}

export function handleAppendHtml(html: string, content: string): string {
  return appendHtml(html, content);
}

export function handleInsertHtml(
  html: string,
  content: string,
  selector?: string,
  position: 'before' | 'after' | 'inside' = 'after'
): string {
  return insertHtml(html, content, selector, position);
}

export function handleReplaceHtml(
  html: string,
  selector: string,
  content: string,
  replaceAll = false
): string {
  return replaceHtml(html, selector, content, replaceAll);
}

export function handleUpdateHtml(
  html: string,
  selector: string,
  content?: string,
  attributes?: Record<string, string>,
  updateAll = false
): string {
  return updateHtml(html, selector, content, attributes, updateAll);
}

// ─── Table Insertion ─────────────────────────────────────────────────────────

/**
 * Insert a table from markdown or a rows array.
 * If a selector is given, the table is placed relative to that element;
 * otherwise it is appended to the end of the document.
 */
export function handleInsertTable(
  html: string,
  markdownTable?: string,
  rows?: string[][],
  selector?: string,
  position: 'before' | 'after' | 'inside' = 'after'
): string {
  let tableHtml = '';

  if (markdownTable?.trim()) {
    tableHtml = markdownTableToHtml(markdownTable);
  } else if (rows?.length) {
    const md = buildMarkdownTableFromRows(rows);
    if (md) tableHtml = markdownTableToHtml(md);
  }

  if (!tableHtml) return html;

  return selector?.trim()
    ? insertHtml(html, tableHtml, selector, position)
    : appendHtml(html, tableHtml);
}

// ─── Image Insertion ─────────────────────────────────────────────────────────

/**
 * Insert an image into the document.
 *
 * By the time this handler runs, local file paths should already be converted
 * to base64 data URLs by `preprocessOperations()` in `operations/index.ts`.
 * html-to-docx only supports base64 data URLs and HTTP URLs.
 */
export function handleInsertImage(
  html: string,
  imagePath: string,
  altText = '',
  width?: number,
  height?: number,
  baseDir?: string,
  selector?: string,
  position: 'before' | 'after' | 'inside' = 'after'
): string {
  if (!imagePath?.trim()) return html;
  if (width !== undefined || height !== undefined) validateImageDimensions(width, height);

  const trimmedPath = imagePath.trim();
  let imageSrc: string;

  if (isDataUrl(trimmedPath) || isUrl(trimmedPath)) {
    imageSrc = trimmedPath;
  } else {
    // Fallback: should not normally occur after preprocessing
    const resolved = resolveImagePath(trimmedPath, baseDir).replace(/\\/g, '/');
    imageSrc = resolved.startsWith('/') ? `file://${resolved}` : `file:///${resolved}`;
  }

  // Build style attribute
  const styles: string[] = [];
  if (width && width > 0) styles.push(`width:${width}px`);
  if (height && height > 0) styles.push(`height:${height}px`);

  // Build img attributes
  const attrs: string[] = [`src="${escapeHtmlAttribute(imageSrc)}"`];
  if (altText?.trim()) attrs.push(`alt="${escapeHtmlAttribute(altText.trim())}"`);
  if (width && width > 0) attrs.push(`width="${width}"`);
  if (height && height > 0) attrs.push(`height="${height}"`);
  if (styles.length > 0) attrs.push(`style="${styles.join('; ')}"`);

  const imgTag = `<p><img ${attrs.join(' ')} /></p>`;

  return selector?.trim()
    ? insertHtml(html, imgTag, selector, position)
    : appendHtml(html, imgTag);
}

// ─── Operation Router ────────────────────────────────────────────────────────

/** Apply a single DocxOperation to HTML content, routing to the correct handler. */
export function applyOperation(html: string, operation: DocxOperation, baseDir?: string): string {
  switch (operation.type) {
    case 'replaceText':
      return handleReplaceText(html, operation.search, operation.replace, operation.matchCase ?? false, operation.global ?? true);

    case 'appendMarkdown':
      return handleAppendMarkdown(html, operation.markdown);

    case 'appendHtml':
      return handleAppendHtml(html, operation.html);

    case 'insertHtml':
      return handleInsertHtml(html, operation.html, operation.selector, operation.position ?? 'after');

    case 'replaceHtml':
      return handleReplaceHtml(html, operation.selector, operation.html, operation.replaceAll ?? false);

    case 'updateHtml':
      return handleUpdateHtml(html, operation.selector, operation.html, operation.attributes, operation.updateAll ?? false);

    case 'insertTable':
      return handleInsertTable(html, operation.markdownTable, operation.rows, operation.selector, operation.position ?? 'after');

    case 'insertImage':
      return handleInsertImage(
        html, operation.imagePath, operation.altText, operation.width, operation.height,
        baseDir, operation.selector, operation.position ?? 'after'
      );

    default: {
      const unknownOp = operation as { type: string };
      throw new DocxError(`Unknown operation type: ${unknownOp.type}`, DocxErrorCode.UNKNOWN_OPERATION, { operation: unknownOp });
    }
  }
}
