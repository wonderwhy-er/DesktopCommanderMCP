/**
 * DOCX Operation Handlers
 * 
 * Individual handlers for each operation type. Each handler is a pure function
 * that takes HTML and operation parameters and returns modified HTML.
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
import {
  appendHtml,
  insertHtml,
  replaceHtml,
  updateHtml,
} from '../html-manipulator.js';
import { escapeRegExp, isUrl, isDataUrl, resolveImagePath } from '../../utils.js';
import { validateImageDimensions } from '../../validators.js';

/**
 * Handler for replaceText operation
 */
export function handleReplaceText(
  html: string,
  search: string,
  replace: string,
  matchCase: boolean = false,
  global: boolean = true
): string {
  if (!search?.trim()) {
    return html;
  }

  const escapedSearch = escapeRegExp(search);
  const flags = matchCase ? (global ? 'g' : '') : global ? 'gi' : 'i';
  const searchRegex = new RegExp(escapedSearch, flags);
  
  return html.replace(searchRegex, replace);
}

/**
 * Handler for appendMarkdown operation
 */
export function handleAppendMarkdown(html: string, markdown: string): string {
  if (!markdown?.trim()) {
    return html;
  }

  const convertedHtml = markdownToHtml(markdown);
  return convertedHtml ? appendHtml(html, convertedHtml) : html;
}

/**
 * Handler for appendHtml operation
 */
export function handleAppendHtml(html: string, appendHtmlContent: string): string {
  return appendHtml(html, appendHtmlContent);
}

/**
 * Handler for insertHtml operation
 */
export function handleInsertHtml(
  html: string,
  insertHtmlContent: string,
  selector?: string,
  position: 'before' | 'after' | 'inside' = 'after'
): string {
  return insertHtml(html, insertHtmlContent, selector, position);
}

/**
 * Handler for replaceHtml operation
 */
export function handleReplaceHtml(
  html: string,
  selector: string,
  replaceHtmlContent: string,
  replaceAll: boolean = false
): string {
  return replaceHtml(html, selector, replaceHtmlContent, replaceAll);
}

/**
 * Handler for updateHtml operation
 */
export function handleUpdateHtml(
  html: string,
  selector: string,
  htmlContent?: string,
  attributes?: Record<string, string>,
  updateAll: boolean = false
): string {
  return updateHtml(html, selector, htmlContent, attributes, updateAll);
}

/**
 * Handler for insertTable operation
 */
export function handleInsertTable(
  html: string,
  markdownTable?: string,
  rows?: string[][]
): string {
  let tableHtml = '';

  if (markdownTable?.trim()) {
    tableHtml = markdownTableToHtml(markdownTable);
  } else if (rows?.length) {
    const markdown = buildMarkdownTableFromRows(rows);
    if (markdown) {
      tableHtml = markdownTableToHtml(markdown);
    }
  }

  return tableHtml ? appendHtml(html, tableHtml) : html;
}

/**
 * Handler for insertImage operation
 */
export function handleInsertImage(
  html: string,
  imagePath: string,
  altText: string = '',
  width?: number,
  height?: number,
  baseDir?: string
): string {
  if (!imagePath?.trim()) {
    return html;
  }

  // Validate dimensions if provided
  if (width !== undefined || height !== undefined) {
    validateImageDimensions(width, height);
  }

  const trimmedPath = imagePath.trim();
  let imageSrc: string;

  if (isDataUrl(trimmedPath) || isUrl(trimmedPath)) {
    imageSrc = trimmedPath;
  } else {
    const resolvedPath = resolveImagePath(trimmedPath, baseDir);
    imageSrc = `file://${resolvedPath}`;
  }

  // Build image attributes with proper escaping
  const attributes: string[] = [`src="${escapeHtmlAttribute(imageSrc)}"`];
  
  if (altText?.trim()) {
    attributes.push(`alt="${escapeHtmlAttribute(altText.trim())}"`);
  }
  
  if (width !== undefined && width > 0) {
    attributes.push(`width="${width}"`);
  }
  
  if (height !== undefined && height > 0) {
    attributes.push(`height="${height}"`);
  }

  const imgTag = `<img ${attributes.join(' ')} />`;
  return appendHtml(html, imgTag);
}

/**
 * Escape HTML attribute values
 */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Apply a single operation to HTML content
 * 
 * Routes to the appropriate handler based on operation type.
 * 
 * @param html - Current HTML content
 * @param operation - Operation to apply
 * @param baseDir - Base directory for resolving paths
 * @returns Modified HTML
 * @throws {Error} If operation type is unknown
 */
export function applyOperation(
  html: string,
  operation: DocxOperation,
  baseDir?: string
): string {
  switch (operation.type) {
    case 'replaceText':
      return handleReplaceText(
        html,
        operation.search,
        operation.replace,
        operation.matchCase ?? false,
        operation.global ?? true
      );

    case 'appendMarkdown':
      return handleAppendMarkdown(html, operation.markdown);

    case 'appendHtml':
      return handleAppendHtml(html, operation.html);

    case 'insertHtml':
      return handleInsertHtml(
        html,
        operation.html,
        operation.selector,
        operation.position ?? 'after'
      );

    case 'replaceHtml':
      return handleReplaceHtml(
        html,
        operation.selector,
        operation.html,
        operation.replaceAll ?? false
      );

    case 'updateHtml':
      return handleUpdateHtml(
        html,
        operation.selector,
        operation.html,
        operation.attributes,
        operation.updateAll ?? false
      );

    case 'insertTable':
      return handleInsertTable(
        html,
        operation.markdownTable,
        operation.rows
      );

    case 'insertImage':
      return handleInsertImage(
        html,
        operation.imagePath,
        operation.altText,
        operation.width,
        operation.height,
        baseDir
      );

    default:
      // Exhaustive check - TypeScript should catch this at compile time
      const _exhaustive: never = operation;
      const unknownOp = operation as { type: string };
      throw new DocxError(
        `Unknown operation type: ${unknownOp.type}`,
        DocxErrorCode.UNKNOWN_OPERATION,
        { operation: unknownOp }
      );
  }
}


