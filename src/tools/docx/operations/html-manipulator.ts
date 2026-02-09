/**
 * HTML DOM Manipulation
 *
 * DOM-based insert / append / replace / update for HTML content.
 * Uses @xmldom/xmldom as the parser (not a browser DOMParser).
 * 
 * IMPORTANT: All public functions use `Base64Guard` to protect base64 data URLs
 * from corruption during xmldom parse/serialize cycles. Without this, images
 * (which are embedded as long `data:image/...;base64,...` strings in `src` attributes)
 * can be lost or mangled by the XML serializer.
 * 
 * @module docx/operations/html-manipulator
 */

import { createRequire } from 'module';
import { DocxError, DocxErrorCode } from '../errors.js';

const require = createRequire(import.meta.url);
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

// ─── Selector Patterns (pre-compiled) ────────────────────────────────────────

const RE_CONTAINS = /^([a-zA-Z][a-zA-Z0-9]*)?:contains\((.+)\)$/i;
const RE_NTH_OF_TYPE = /^([a-zA-Z][a-zA-Z0-9]*):nth-of-type\((\d+)\)$/i;
const RE_FIRST_OF_TYPE = /^([a-zA-Z][a-zA-Z0-9]*):first-of-type$/i;
const RE_LAST_OF_TYPE = /^([a-zA-Z][a-zA-Z0-9]*):last-of-type$/i;

// ─── Base64 Data URL Protection ──────────────────────────────────────────────

/**
 * Protects base64 data URLs from corruption during xmldom parse/serialize.
 *
 * Problem: xmldom's DOMParser + XMLSerializer can mangle very long attribute
 * values (base64 image data). Symptoms range from silent truncation to dropped
 * `<img>` elements.
 *
 * Solution: Before DOM operations, replace all `data:…` URLs in `src` attributes
 * with short placeholder URNs. After serialization, restore the originals.
 * This keeps the DOM tree lightweight and avoids serializer issues.
 */
class Base64Guard {
  private readonly store: string[] = [];

  /** Replace all data: URLs in src attributes with short placeholders. */
  protect(html: string): string {
    if (!html.includes('data:')) return html; // Fast path: no data URLs
    return html.replace(/\bsrc="(data:[^"]+)"/g, (_, dataUrl) => {
      const index = this.store.length;
      this.store.push(dataUrl);
      return `src="urn:b64:${index}"`;
    });
  }

  /** Restore original data: URLs from placeholders. */
  restore(html: string): string {
    if (this.store.length === 0) return html; // Fast path: nothing to restore
    let result = html;
    // Use split/join to avoid $-pattern issues in String.replace
    for (let i = 0; i < this.store.length; i++) {
      result = result.split(`urn:b64:${i}`).join(this.store[i]);
    }
    return result;
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Re-throw any non-DocxError as a DocxError. */
function rethrowAsDocxError(error: unknown, message: string, context?: Record<string, unknown>): never {
  if (error instanceof DocxError) throw error;
  throw new DocxError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    DocxErrorCode.OPERATION_FAILED,
    context
  );
}

/**
 * Parse HTML string into a DOM Document.
 *
 * @xmldom/xmldom is an XML parser — it does NOT auto-create `<html>/<body>` wrappers
 * like a browser would. We always ensure a proper structure so that
 * `getElementsByTagName('body')` works reliably.
 */
function parseHtml(html: string): Document {
  try {
    let htmlToParse = html;
    const lower = html.toLowerCase();
    if (!lower.includes('<body')) htmlToParse = `<html><body>${html}</body></html>`;
    else if (!lower.includes('<html')) htmlToParse = `<html>${html}</html>`;

    const doc = new DOMParser().parseFromString(htmlToParse, 'text/html');

    const parserErrors = doc.getElementsByTagName('parsererror');
    if (parserErrors.length > 0) {
      throw new DocxError('Failed to parse HTML: invalid structure', DocxErrorCode.OPERATION_FAILED, { htmlSnippet: html.substring(0, 100) });
    }
    
    return doc;
  } catch (error) {
    rethrowAsDocxError(error, 'Failed to parse HTML', { htmlSnippet: html.substring(0, 100) });
  }
}

/**
 * Serialize a DOM Document back to an HTML string.
 * Returns only the inner content of `<body>` (no wrapper tags) because we
 * added those in `parseHtml` for xmldom compatibility.
 */
function serializeHtml(doc: Document): string {
  try {
    const serializer = new XMLSerializer();
    const body = doc.getElementsByTagName('body')[0];
    
    if (body) {
      let content = '';
      for (let i = 0; i < body.childNodes.length; i++) {
        content += serializer.serializeToString(body.childNodes[i]);
    }
      return content;
    }

    return doc.documentElement ? serializer.serializeToString(doc.documentElement) : '';
  } catch (error) {
    throw new DocxError(
      `Failed to serialize HTML: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED
    );
  }
}

/** Get the root element (body or documentElement) for querying. */
function getRootElement(doc: Document): Element {
  return doc.getElementsByTagName('body')[0] || doc.documentElement;
}

/** Clone nodes from one document into another. */
function cloneNodesToDocument(sourceNodes: NodeList, targetDoc: Document): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < sourceNodes.length; i++) {
    nodes.push(targetDoc.importNode(sourceNodes[i], true));
  }
  return nodes;
}

// ─── CSS-like Selector Engine ────────────────────────────────────────────────

/**
 * Find elements using an extended CSS-like selector.
 *
 * Supported:
 *   `#id`, `.class`, `tag`,
 *   `tag:contains(text)`, `:contains(text)`,
 *   `tag:nth-of-type(N)`, `tag:first-of-type`, `tag:last-of-type`
 */
function querySelectorAll(doc: Document, selector: string): Element[] {
  const s = selector?.trim();
  if (!s) return [];

  const root = getRootElement(doc);
  const elements: Element[] = [];

  try {
    // #id
    if (s.startsWith('#')) {
      const el = doc.getElementById(s.substring(1));
      if (el) elements.push(el);
      return elements;
    }

    // .class
    if (s.startsWith('.')) {
      const found = root.getElementsByClassName(s.substring(1));
      for (let i = 0; i < found.length; i++) elements.push(found[i] as Element);
      return elements;
    }

    // tag:contains(text)
    const containsMatch = s.match(RE_CONTAINS);
    if (containsMatch) {
      const tag = containsMatch[1] || '*';
      const needle = containsMatch[2].trim().toLowerCase();
      const candidates = root.getElementsByTagName(tag);
      for (let i = 0; i < candidates.length; i++) {
        if ((candidates[i].textContent || '').toLowerCase().includes(needle)) {
          elements.push(candidates[i] as Element);
        }
      }
      return elements;
    }

    // tag:nth-of-type(N)
    const nthMatch = s.match(RE_NTH_OF_TYPE);
    if (nthMatch) {
      const n = parseInt(nthMatch[2], 10);
      const found = root.getElementsByTagName(nthMatch[1]);
      if (n >= 1 && n <= found.length) elements.push(found[n - 1] as Element);
      return elements;
    }

    // tag:first-of-type
    const firstMatch = s.match(RE_FIRST_OF_TYPE);
    if (firstMatch) {
      const found = root.getElementsByTagName(firstMatch[1]);
      if (found.length > 0) elements.push(found[0] as Element);
      return elements;
    }

    // tag:last-of-type
    const lastMatch = s.match(RE_LAST_OF_TYPE);
    if (lastMatch) {
      const found = root.getElementsByTagName(lastMatch[1]);
      if (found.length > 0) elements.push(found[found.length - 1] as Element);
      return elements;
    }

    // Plain tag name (fallback)
    const found = root.getElementsByTagName(s);
    for (let i = 0; i < found.length; i++) elements.push(found[i] as Element);
  } catch (error) {
    throw new DocxError(
      `Failed to query selector "${selector}": ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.OPERATION_FAILED
    );
  }

  return elements;
}

// ─── DOM Position Helper ─────────────────────────────────────────────────────

/** Insert `node` relative to `target` at the given `position`. */
function insertAtPosition(
  node: Node,
  target: Element,
  position: 'before' | 'after' | 'inside'
): void {
  switch (position) {
    case 'before':
      target.parentNode?.insertBefore(node, target);
      break;
    case 'inside':
      target.appendChild(node);
      break;
    case 'after':
    default:
      if (target.nextSibling) target.parentNode?.insertBefore(node, target.nextSibling);
      else target.parentNode?.appendChild(node);
      break;
}
}

// ─── Public Operations ───────────────────────────────────────────────────────
// All public functions use Base64Guard to protect image data URLs from
// corruption during the xmldom parse → manipulate → serialize cycle.

/** Append HTML content to the end of the document body. */
export function appendHtml(html: string, content: string): string {
  if (!content?.trim()) return html;

  const guard = new Base64Guard();
  const safeHtml = guard.protect(html);
  const safeContent = guard.protect(content);

  try {
    const doc = parseHtml(safeHtml);
    const body = doc.getElementsByTagName('body')[0];
    if (!body) return html.trim() + '\n' + content.trim();

    const contentDoc = parseHtml(safeContent);
    const contentRoot = getRootElement(contentDoc);
    for (const node of cloneNodesToDocument(contentRoot.childNodes, doc)) {
      body.appendChild(node);
    }

    return guard.restore(serializeHtml(doc));
  } catch (error) {
    rethrowAsDocxError(error, 'Failed to append HTML');
  }
}

/**
 * Insert HTML content at a specific position relative to a selector target.
 * If no selector is given, appends to the root element.
 */
export function insertHtml(
  html: string,
  content: string,
  selector?: string,
  position: 'before' | 'after' | 'inside' = 'after'
): string {
  if (!content?.trim()) return html;

  const guard = new Base64Guard();
  const safeHtml = guard.protect(html);
  const safeContent = guard.protect(content);

  try {
    const doc = parseHtml(safeHtml);
    const root = getRootElement(doc);

    const contentDoc = parseHtml(safeContent);
    const contentRoot = getRootElement(contentDoc);
    const nodesToInsert = cloneNodesToDocument(contentRoot.childNodes, doc);

    if (!selector) {
      for (const node of nodesToInsert) root.appendChild(node);
      return guard.restore(serializeHtml(doc));
    }

    const targets = querySelectorAll(doc, selector);
    if (targets.length === 0) {
      throw new DocxError(`Target element not found for selector: "${selector}"`, DocxErrorCode.OPERATION_FAILED, { selector });
    }

    // Insert at FIRST match only to prevent duplication
    const target = targets[0];
      for (const node of nodesToInsert) {
      insertAtPosition(node.cloneNode(true), target, position);
    }

    return guard.restore(serializeHtml(doc));
  } catch (error) {
    rethrowAsDocxError(error, 'Failed to insert HTML', { selector, position });
  }
}

/** Replace matched elements with new HTML content. */
export function replaceHtml(
  html: string,
  selector: string,
  content: string,
  replaceAll = false
): string {
  if (!selector?.trim()) return html;

  const guard = new Base64Guard();
  const safeHtml = guard.protect(html);
  const safeContent = guard.protect(content);

  try {
    const doc = parseHtml(safeHtml);
    const targets = querySelectorAll(doc, selector);
    if (targets.length === 0) {
      throw new DocxError(`Target element not found for selector: "${selector}"`, DocxErrorCode.OPERATION_FAILED, { selector });
    }

    const contentDoc = parseHtml(safeContent);
    const contentRoot = getRootElement(contentDoc);
    const replaceNodes = cloneNodesToDocument(contentRoot.childNodes, doc);

    for (const target of replaceAll ? targets : [targets[0]]) {
      const parent = target.parentNode;
      if (!parent) continue;
      for (const node of replaceNodes) parent.insertBefore(node.cloneNode(true), target);
      parent.removeChild(target);
    }

    return guard.restore(serializeHtml(doc));
  } catch (error) {
    rethrowAsDocxError(error, 'Failed to replace HTML', { selector, replaceAll });
  }
}

/** Update matched elements' content and/or attributes. */
export function updateHtml(
  html: string,
  selector: string,
  content?: string,
  attributes?: Record<string, string>,
  updateAll = false
): string {
  if (!selector?.trim()) return html;

  const guard = new Base64Guard();
  const safeHtml = guard.protect(html);
  const safeContent = content !== undefined ? guard.protect(content) : undefined;

  try {
    const doc = parseHtml(safeHtml);
    const targets = querySelectorAll(doc, selector);
    if (targets.length === 0) {
      throw new DocxError(`Target element not found for selector: "${selector}"`, DocxErrorCode.OPERATION_FAILED, { selector });
    }

    for (const target of updateAll ? targets : [targets[0]]) {
      // Replace innerHTML via DOM methods (xmldom doesn't support .innerHTML setter)
      if (safeContent !== undefined) {
        while (target.firstChild) target.removeChild(target.firstChild);
        const contentDoc = parseHtml(safeContent);
        const contentRoot = getRootElement(contentDoc);
        for (const child of cloneNodesToDocument(contentRoot.childNodes, doc)) {
          target.appendChild(child);
        }
      }

      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          target.setAttribute(key, value);
        }
      }
    }

    return guard.restore(serializeHtml(doc));
  } catch (error) {
    rethrowAsDocxError(error, 'Failed to update HTML', { selector, updateAll });
  }
}
