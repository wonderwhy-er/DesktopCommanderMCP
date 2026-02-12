/**
 * DOM utilities for DOCX XML manipulation.
 *
 * Single Responsibility: XML parsing, navigation, and minimal element
 * mutation.  No file I/O — every function works on in-memory DOM nodes.
 *
 * Uses @xmldom/xmldom for parsing and serialisation so that the
 * document-order of nodes is always preserved.
 */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// ═══════════════════════════════════════════════════════════════════════
// XML parse / serialize
// ═══════════════════════════════════════════════════════════════════════

export function parseXml(xmlStr: string): Document {
    return new DOMParser().parseFromString(xmlStr, 'application/xml');
}

export function serializeXml(doc: Document): string {
    return new XMLSerializer().serializeToString(doc);
}

// ═══════════════════════════════════════════════════════════════════════
// Generic DOM helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert any NodeList / HTMLCollection-like object into a real array.
 */
export function nodeListToArray<T extends Node = Node>(
    nl: NodeListOf<T> | NodeList | { length: number; item(index: number): T | null },
): T[] {
    const arr: T[] = [];
    for (let i = 0; i < nl.length; i++) {
        const n = nl.item(i);
        if (n) arr.push(n as T);
    }
    return arr;
}

// ═══════════════════════════════════════════════════════════════════════
// Body access
// ═══════════════════════════════════════════════════════════════════════

/** Return the single <w:body> element from a parsed document.xml DOM. */
export function getBody(doc: Document): Element {
    const body = doc.getElementsByTagName('w:body').item(0);
    if (!body) throw new Error('Invalid DOCX DOM: missing <w:body>');
    return body;
}

/**
 * Return ALL direct element children of w:body **in document order**.
 * Includes w:p, w:tbl, w:sdt, w:sectPr, etc.
 */
export function getBodyChildren(body: Element): Element[] {
    const out: Element[] = [];
    for (const node of nodeListToArray(body.childNodes)) {
        if (node.nodeType === 1) out.push(node as Element);
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Body signature
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a compact signature string from the body children array.
 * Maps each node's qualified name to a short local name:
 *   w:p → p, w:tbl → tbl, w:sdt → sdt, w:sectPr → sectPr, …
 * Returns e.g. "p,tbl,p,p,sectPr".
 */
export function bodySignature(children: Element[]): string {
    return children
        .map((ch) => {
            const name = ch.nodeName;
            const idx = name.indexOf(':');
            return idx >= 0 ? name.substring(idx + 1) : name;
        })
        .join(',');
}

// ═══════════════════════════════════════════════════════════════════════
// Paragraph text helpers
// ═══════════════════════════════════════════════════════════════════════

/** Concatenate text from every <w:t> descendant of a paragraph. */
export function getParagraphText(p: Element): string {
    const tNodes = p.getElementsByTagName('w:t');
    let out = '';
    for (let i = 0; i < tNodes.length; i++) {
        out += tNodes.item(i)?.textContent ?? '';
    }
    return out;
}

/** Read the style id from w:pPr/w:pStyle/@w:val, or null if absent. */
export function getParagraphStyle(p: Element): string | null {
    for (const child of nodeListToArray(p.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:pPr') {
            const pPr = child as Element;
            for (const prChild of nodeListToArray(pPr.childNodes)) {
                if (prChild.nodeType === 1 && (prChild as Element).nodeName === 'w:pStyle') {
                    return (prChild as Element).getAttribute('w:val');
                }
            }
            return null;
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Table content extraction
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract all text content from a table cell (w:tc).
 * Returns the concatenated text from all paragraphs in the cell.
 */
export function getCellText(tc: Element): string {
    const paragraphs = tc.getElementsByTagName('w:p');
    const texts: string[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs.item(i);
        if (p) {
            const text = getParagraphText(p as Element).trim();
            if (text) texts.push(text);
        }
    }
    return texts.join(' '); // Join multiple paragraphs in cell with space
}

/**
 * Extract all rows from a table (w:tbl).
 * Returns an array of rows, where each row is an array of cell text strings.
 * First row is treated as header if it exists.
 */
export function getTableContent(tbl: Element): { headers?: string[]; rows: string[][] } {
    const rows: Element[] = [];
    for (const child of nodeListToArray(tbl.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:tr') {
            rows.push(child as Element);
        }
    }

    if (rows.length === 0) {
        return { rows: [] };
    }

    // Extract cells from each row
    const tableRows: string[][] = [];
    for (const row of rows) {
        const cells: string[] = [];
        for (const child of nodeListToArray(row.childNodes)) {
            if (child.nodeType === 1 && (child as Element).nodeName === 'w:tc') {
                cells.push(getCellText(child as Element));
            }
        }
        if (cells.length > 0) {
            tableRows.push(cells);
        }
    }

    // First row might be header - check if it has bold formatting
    // For simplicity, we'll treat first row as potential header
    // User can determine this based on style or content
    if (tableRows.length > 0) {
        const firstRow = tableRows[0];
        const restRows = tableRows.slice(1);
        return {
            headers: firstRow.length > 0 ? firstRow : undefined,
            rows: restRows.length > 0 ? restRows : [],
        };
    }

    return { rows: tableRows };
}

/**
 * Get table style from w:tblPr/w:tblStyle/@w:val, or null if absent.
 */
export function getTableStyle(tbl: Element): string | null {
    const tblPr = tbl.getElementsByTagName('w:tblPr').item(0);
    if (!tblPr) return null;

    const tblStyle = tblPr.getElementsByTagName('w:tblStyle').item(0);
    if (!tblStyle) return null;

    return tblStyle.getAttribute('w:val');
}

// ═══════════════════════════════════════════════════════════════════════
// Image reference extraction
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract image reference from a w:drawing element.
 * Returns the relationship ID (rId) and media file path if found.
 */
export function getImageReference(drawing: Element): { rId: string | null; mediaPath: string | null } {
    // Find a:blip/@r:embed to get the relationship ID
    const blip = drawing.getElementsByTagName('a:blip').item(0);
    if (!blip) return { rId: null, mediaPath: null };

    const rId = blip.getAttribute('r:embed');
    if (!rId) return { rId: null, mediaPath: null };

    // Media path will be resolved from relationships file
    // For now, return the rId - the caller will resolve it from rels
    return { rId, mediaPath: null };
}

// ═══════════════════════════════════════════════════════════════════════
// Minimal text replacement
// ═══════════════════════════════════════════════════════════════════════

/**
 * Replace the text of a paragraph with minimal DOM changes.
 * Sets the FIRST w:t to `text`, clears every subsequent w:t.
 * Sets xml:space="preserve" so leading/trailing spaces survive.
 * Does NOT recreate runs or remove paragraph properties.
 */
export function setParagraphTextMinimal(p: Element, text: string): void {
    const tNodes = p.getElementsByTagName('w:t');
    if (tNodes.length === 0) return;

    const first = tNodes.item(0)!;
    first.textContent = text;
    first.setAttribute('xml:space', 'preserve');

    for (let i = 1; i < tNodes.length; i++) {
        tNodes.item(i)!.textContent = '';
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Run-level formatting helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Ensure a <w:r> element has w:rPr/w:color[@w:val=hex].
 * Creates w:rPr and w:color if they don't exist.
 * Only touches the colour — leaves every other run property intact.
 */
export function ensureRunColor(run: Element, hex: string): void {
    const doc = run.ownerDocument;
    if (!doc) return;

    let rPr = findDirectChild(run, 'w:rPr');
    if (!rPr) {
        rPr = doc.createElement('w:rPr');
        if (run.firstChild) {
            run.insertBefore(rPr, run.firstChild);
        } else {
            run.appendChild(rPr);
        }
    }

    let colorEl = findDirectChild(rPr, 'w:color');
    if (!colorEl) {
        colorEl = doc.createElement('w:color');
        rPr.appendChild(colorEl);
    }

    colorEl.setAttribute('w:val', hex);
}

/**
 * Apply run-level colour to every <w:r> in a paragraph.
 */
export function colorParagraphRuns(p: Element, color: string): void {
    const runs = nodeListToArray(p.getElementsByTagName('w:r'));
    for (const r of runs) {
        ensureRunColor(r as Element, color);
    }
}

/**
 * Apply bold / italic / color to every <w:r> in a paragraph.
 * Preserves all existing w:rPr children; only modifies specified props.
 */
export function styleParagraphRuns(
    p: Element,
    style: { color?: string; bold?: boolean; italic?: boolean },
): void {
    const doc = p.ownerDocument;
    if (!doc) return;

    const runs = nodeListToArray(p.getElementsByTagName('w:r'));
    for (const r of runs) {
        let rPr = findDirectChild(r as Element, 'w:rPr');
        if (!rPr) {
            rPr = doc.createElement('w:rPr');
            if (r.firstChild) {
                r.insertBefore(rPr, r.firstChild);
            } else {
                r.appendChild(rPr);
            }
        }

        if (style.color) {
            let colorNode = findDirectChild(rPr, 'w:color');
            if (!colorNode) {
                colorNode = doc.createElement('w:color');
                rPr.appendChild(colorNode);
            }
            colorNode.setAttribute('w:val', style.color);
        }

        if (style.bold !== undefined) {
            toggleElement(doc, rPr, 'w:b', style.bold);
        }

        if (style.italic !== undefined) {
            toggleElement(doc, rPr, 'w:i', style.italic);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Counting helpers
// ═══════════════════════════════════════════════════════════════════════

/** Count direct w:tbl children of body. */
export function countTables(children: Element[]): number {
    return children.filter((ch) => ch.nodeName === 'w:tbl').length;
}

/** Count <w:drawing> descendants (rough image count). */
export function countImages(body: Element): number {
    return body.getElementsByTagName('w:drawing').length;
}

// ═══════════════════════════════════════════════════════════════════════
// Private helpers (DRY: used by multiple public functions)
// ═══════════════════════════════════════════════════════════════════════

/** Find the first direct child element with the given nodeName. */
function findDirectChild(parent: Element, nodeName: string): Element | null {
    for (const child of nodeListToArray(parent.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === nodeName) {
            return child as Element;
        }
    }
    return null;
}

/** Add or remove a simple flag element (e.g. w:b, w:i) inside a parent. */
function toggleElement(
    doc: Document,
    parent: Element,
    nodeName: string,
    enabled: boolean,
): void {
    const existing = findDirectChild(parent, nodeName);
    if (enabled && !existing) {
        parent.appendChild(doc.createElement(nodeName));
    } else if (!enabled && existing) {
        parent.removeChild(existing);
    }
}
