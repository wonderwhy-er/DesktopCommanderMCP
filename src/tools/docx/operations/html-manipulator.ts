/**
 * HTML Manipulation Utilities
 * 
 * Provides functions for manipulating HTML content using DOM parsing.
 * Used by DOCX operations to modify HTML components.
 * 
 * @module docx/operations/html-manipulator
 */

import { createRequire } from 'module';
import { DocxError, DocxErrorCode } from '../errors.js';

const require = createRequire(import.meta.url);
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

/**
 * Parse HTML string into DOM document.
 * 
 * CRITICAL: @xmldom/xmldom is an XML parser — it does NOT auto-create <html>/<body>
 * wrappers like a browser DOMParser would. Without them, getElementsByTagName('body')
 * returns nothing, and all DOM-based operations (insert, replace, update) break
 * because they can't find elements or the root container.
 * 
 * We always wrap content in a proper HTML structure before parsing.
 * 
 * @param html - HTML content (fragment or full document)
 * @returns Parsed DOM document with guaranteed <body> element
 * @throws {DocxError} If parsing fails
 */
function parseHtml(html: string): Document {
  try {
    const parser = new DOMParser();
    
    // Ensure proper HTML structure for xmldom
    let htmlToParse = html;
    const lower = html.toLowerCase();
    if (!lower.includes('<body')) {
      // Wrap fragment in full HTML structure so xmldom creates proper DOM
      htmlToParse = `<html><body>${html}</body></html>`;
    } else if (!lower.includes('<html')) {
      htmlToParse = `<html>${html}</html>`;
    }
    
    const doc = parser.parseFromString(htmlToParse, 'text/html');
    
    // Check for parsing errors
    const parserError = doc.getElementsByTagName('parsererror');
    if (parserError.length > 0) {
      throw new DocxError(
        'Failed to parse HTML: invalid HTML structure',
        DocxErrorCode.OPERATION_FAILED,
        { htmlSnippet: html.substring(0, 100) }
      );
    }
    
    return doc;
  } catch (error) {
    if (error instanceof DocxError) {
      throw error;
    }
    throw new DocxError(
      `Failed to parse HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED,
      { htmlSnippet: html.substring(0, 100) }
    );
  }
}

/**
 * Serialize DOM document back to HTML string.
 * 
 * Returns ONLY the inner content of <body> — NOT the <body>/<html> wrapper tags.
 * This is because we added those wrappers in parseHtml() for xmldom compatibility,
 * but the output should be a clean HTML fragment for further processing by
 * ensureHtmlStructure() in the html-builder.
 * 
 * @param doc - DOM document
 * @returns HTML content string (body inner content only)
 */
function serializeHtml(doc: Document): string {
  try {
    const serializer = new XMLSerializer();
    const body = doc.getElementsByTagName('body')[0];
    
    if (body) {
      // Serialize each child node of <body> individually to avoid
      // including the <body> wrapper tags in the output
      let content = '';
      for (let i = 0; i < body.childNodes.length; i++) {
        content += serializer.serializeToString(body.childNodes[i]);
      }
      return content;
    }
    
    // Fallback: return document element content
    return doc.documentElement ? serializer.serializeToString(doc.documentElement) : '';
  } catch (error) {
    throw new DocxError(
      `Failed to serialize HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED
    );
  }
}

/**
 * Get the root element (body or documentElement) for querying
 */
function getRootElement(doc: Document): Element {
  const body = doc.getElementsByTagName('body')[0];
  return body || doc.documentElement;
}

/**
 * Find elements in HTML using CSS selector
 * Supports: tag names, class selectors (.class), ID selectors (#id)
 * @param doc - DOM document
 * @param selector - CSS selector
 * @returns Array of matching elements
 */
function querySelectorAll(doc: Document, selector: string): Element[] {
  if (!selector || !selector.trim()) {
    return [];
  }

  const trimmedSelector = selector.trim();
  const root = getRootElement(doc);
  const elements: Element[] = [];

  try {
    // ID selector (e.g., "#idname")
    if (trimmedSelector.startsWith('#')) {
      const id = trimmedSelector.substring(1);
      const element = doc.getElementById(id);
      if (element) {
        elements.push(element);
      }
      return elements;
    }

    // Class selector (e.g., ".classname")
    if (trimmedSelector.startsWith('.')) {
      const className = trimmedSelector.substring(1);
      const found = root.getElementsByClassName(className);
      for (let i = 0; i < found.length; i++) {
        elements.push(found[i] as Element);
      }
      return elements;
    }

    // Tag name selector (e.g., "p", "div", "h1")
    if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(trimmedSelector)) {
      const found = root.getElementsByTagName(trimmedSelector);
      for (let i = 0; i < found.length; i++) {
        elements.push(found[i] as Element);
      }
      return elements;
    }

    // Default: try as tag name
    const found = root.getElementsByTagName(trimmedSelector);
    for (let i = 0; i < found.length; i++) {
      elements.push(found[i] as Element);
    }
  } catch (error) {
    throw new DocxError(
      `Failed to query selector "${selector}": ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED
    );
  }

  return elements;
}

/**
 * Clone nodes from source document to target document
 */
function cloneNodesToDocument(sourceNodes: NodeList, targetDoc: Document): Node[] {
  const clonedNodes: Node[] = [];
  for (let i = 0; i < sourceNodes.length; i++) {
    clonedNodes.push(targetDoc.importNode(sourceNodes[i], true));
  }
  return clonedNodes;
}

/**
 * Append HTML content to the end of the document
 * @param html - Current HTML content
 * @param appendHtmlContent - HTML to append
 * @returns Modified HTML (body inner content only, no wrapper tags)
 */
export function appendHtml(html: string, appendHtmlContent: string): string {
  if (!appendHtmlContent?.trim()) {
    return html;
  }

  try {
    // parseHtml() wraps in <html><body>...</body></html> if needed,
    // ensuring body is always available for DOM operations
    const doc = parseHtml(html);
    const body = doc.getElementsByTagName('body')[0];

    if (!body) {
      // Shouldn't happen after parseHtml fix, but fallback gracefully
      return html.trim() + '\n' + appendHtmlContent.trim();
    }

    // Parse the HTML to append (also gets wrapped in body)
    const appendDoc = parseHtml(appendHtmlContent);
    const appendBody = appendDoc.getElementsByTagName('body')[0];
    const appendRoot = appendBody || getRootElement(appendDoc);
    const nodesToAppend = cloneNodesToDocument(appendRoot.childNodes, doc);

    // Append all child nodes
    for (const node of nodesToAppend) {
      body.appendChild(node);
    }

    // serializeHtml returns only body inner content (no body/html wrapper tags)
    return serializeHtml(doc);
  } catch (error) {
    if (error instanceof DocxError) {
      throw error;
    }
    throw new DocxError(
      `Failed to append HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED
    );
  }
}

/**
 * Insert HTML content at a specific position
 * @param html - Current HTML content
 * @param insertHtmlContent - HTML to insert
 * @param selector - CSS selector to find target element (optional)
 * @param position - Position relative to target: 'before', 'after', 'inside' (default: 'after')
 * @returns Modified HTML
 * @throws {DocxError} If selector is provided but no matching element is found
 */
export function insertHtml(
  html: string,
  insertHtmlContent: string,
  selector?: string,
  position: 'before' | 'after' | 'inside' = 'after'
): string {
  if (!insertHtmlContent?.trim()) {
    return html;
  }

  try {
    const doc = parseHtml(html);
    const root = getRootElement(doc);

    // Parse the HTML to insert (parseHtml wraps in body, so use body's children)
    const insertDoc = parseHtml(insertHtmlContent);
    const insertBody = insertDoc.getElementsByTagName('body')[0];
    const insertRoot = insertBody || getRootElement(insertDoc);
    const nodesToInsert = cloneNodesToDocument(insertRoot.childNodes, doc);

    // If no selector, append to root
    if (!selector) {
      for (const node of nodesToInsert) {
        root.appendChild(node);
      }
      return serializeHtml(doc);
    }

    // Find target elements
    const targets = querySelectorAll(doc, selector);

    if (targets.length === 0) {
      throw new DocxError(
        `Target element not found for selector: "${selector}"`,
        DocxErrorCode.OPERATION_FAILED,
        { selector }
      );
    }

    // Insert relative to targets
    for (const target of targets) {
      for (const node of nodesToInsert) {
        const clonedNode = node.cloneNode(true);

        switch (position) {
          case 'before':
            target.parentNode?.insertBefore(clonedNode, target);
            break;
          case 'inside':
            target.appendChild(clonedNode);
            break;
          case 'after':
          default:
            if (target.nextSibling) {
              target.parentNode?.insertBefore(clonedNode, target.nextSibling);
            } else {
              target.parentNode?.appendChild(clonedNode);
            }
            break;
        }
      }
    }

    return serializeHtml(doc);
  } catch (error) {
    if (error instanceof DocxError) {
      throw error;
    }
    throw new DocxError(
      `Failed to insert HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED,
      { selector, position }
    );
  }
}

/**
 * Replace HTML elements with new content
 * @param html - Current HTML content
 * @param selector - CSS selector to find elements to replace
 * @param replaceHtmlContent - HTML content to replace with
 * @param replaceAll - Replace all matches (default: false, only first match)
 * @returns Modified HTML
 * @throws {DocxError} If no matching elements are found
 */
export function replaceHtml(
  html: string,
  selector: string,
  replaceHtmlContent: string,
  replaceAll: boolean = false
): string {
  if (!selector?.trim()) {
    return html;
  }

  try {
    const doc = parseHtml(html);
    const targets = querySelectorAll(doc, selector);

    if (targets.length === 0) {
      throw new DocxError(
        `Target element not found for selector: "${selector}"`,
        DocxErrorCode.OPERATION_FAILED,
        { selector }
      );
    }

    // Parse replacement HTML (parseHtml wraps in body, so use body's children)
    const replaceDoc = parseHtml(replaceHtmlContent);
    const replaceBody = replaceDoc.getElementsByTagName('body')[0];
    const replaceRoot = replaceBody || getRootElement(replaceDoc);
    const replaceNodes = cloneNodesToDocument(replaceRoot.childNodes, doc);

    const elementsToReplace = replaceAll ? targets : [targets[0]];

    for (const target of elementsToReplace) {
      const parent = target.parentNode;
      if (!parent) continue;

      // Insert replacement nodes before target
      for (const node of replaceNodes) {
        parent.insertBefore(node.cloneNode(true), target);
      }

      // Remove target
      parent.removeChild(target);
    }

    return serializeHtml(doc);
  } catch (error) {
    if (error instanceof DocxError) {
      throw error;
    }
    throw new DocxError(
      `Failed to replace HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED,
      { selector, replaceAll }
    );
  }
}

/**
 * Update HTML elements (modify attributes and/or content)
 * @param html - Current HTML content
 * @param selector - CSS selector to find elements to update
 * @param htmlContent - New innerHTML content (optional)
 * @param attributes - Attributes to set/update (optional)
 * @param updateAll - Update all matches (default: false, only first match)
 * @returns Modified HTML
 * @throws {DocxError} If no matching elements are found
 */
export function updateHtml(
  html: string,
  selector: string,
  htmlContent?: string,
  attributes?: Record<string, string>,
  updateAll: boolean = false
): string {
  if (!selector?.trim()) {
    return html;
  }

  try {
    const doc = parseHtml(html);
    const targets = querySelectorAll(doc, selector);

    if (targets.length === 0) {
      throw new DocxError(
        `Target element not found for selector: "${selector}"`,
        DocxErrorCode.OPERATION_FAILED,
        { selector }
      );
    }

    const elementsToUpdate = updateAll ? targets : [targets[0]];

    for (const target of elementsToUpdate) {
      // Update innerHTML if provided
      // NOTE: xmldom does NOT support .innerHTML setter — we must use DOM methods
      if (htmlContent !== undefined) {
        // Remove all existing children
        while (target.firstChild) {
          target.removeChild(target.firstChild);
        }
        // Parse new content and append children
        const contentDoc = parseHtml(htmlContent);
        const contentBody = contentDoc.getElementsByTagName('body')[0];
        const contentRoot = contentBody || getRootElement(contentDoc);
        const newChildren = cloneNodesToDocument(contentRoot.childNodes, doc);
        for (const child of newChildren) {
          target.appendChild(child);
        }
      }

      // Update attributes if provided
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          target.setAttribute(key, value);
        }
      }
    }

    return serializeHtml(doc);
  } catch (error) {
    if (error instanceof DocxError) {
      throw error;
    }
    throw new DocxError(
      `Failed to update HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED,
      { selector, updateAll }
    );
  }
}
