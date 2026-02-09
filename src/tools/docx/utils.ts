/**
 * Utility functions for DOCX manipulation
 */

/**
 * Convert NodeList or HTMLCollection to array
 */
export function nodeListToArray<T extends Node>(nl: NodeListOf<T> | NodeList | HTMLCollectionOf<Element> | { length: number; item(index: number): T | null }): T[] {
    const arr: T[] = [];
    for (let i = 0; i < nl.length; i++) {
        const item = nl.item(i);
        if (item) {
            arr.push(item as T);
        }
    }
    return arr;
}

/**
 * Get all text from a paragraph by concatenating w:t nodes in document order
 * Follows exact same pattern as reference implementation
 */
export function getTextFromParagraph(pNode: Element): string {
    // Concatenate w:t text in document order
    const tNodes = pNode.getElementsByTagName('w:t');
    let out = '';
    for (const t of nodeListToArray(tNodes)) {
        out += t.textContent || '';
    }
    return out;
}

/**
 * Set paragraph text with minimal changes (preserves formatting structure)
 * Replaces text in the first w:t; clear remaining w:t nodes (minimal change)
 * Follows exact same pattern as reference implementation
 */
export function setParagraphTextMinimal(pNode: Element, newText: string): void {
    // Replace text in the first w:t; clear remaining w:t nodes (minimal change)
    const tNodes = nodeListToArray(pNode.getElementsByTagName('w:t'));
    if (tNodes.length === 0) return;

    tNodes[0].textContent = newText;
    for (let i = 1; i < tNodes.length; i++) {
        tNodes[i].textContent = '';
    }
}

/**
 * Ensure a run node has color formatting
 * Follows exact same pattern as reference implementation
 * Preserves all existing w:rPr children, only modifies/adds w:color
 */
export function ensureRunColorRed(runNode: Element, color: string = 'FF0000'): void {
    const doc = runNode.ownerDocument;
    if (!doc) return;

    // Find or create w:rPr under this w:r
    let rPr: Element | null = null;
    for (const child of nodeListToArray(runNode.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:rPr') {
            rPr = child as Element;
            break;
        }
    }
    
    if (!rPr) {
        rPr = doc.createElement('w:rPr');
        // Insert rPr as the first element child of w:r (standard structure)
        if (runNode.firstChild) {
            runNode.insertBefore(rPr, runNode.firstChild);
        } else {
            runNode.appendChild(rPr);
        }
    }

    // Find existing w:color
    let colorNode: Element | null = null;
    for (const child of nodeListToArray(rPr.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:color') {
            colorNode = child as Element;
            break;
        }
    }

    if (!colorNode) {
        colorNode = doc.createElement('w:color');
        rPr.appendChild(colorNode);
    }

    // Set w:val attribute (namespace handling: xmldom will keep prefix)
    colorNode.setAttribute('w:val', color);
}

/**
 * Apply color formatting to all runs in a paragraph
 * Follows exact same pattern as reference implementation
 */
export function colorParagraphRuns(pNode: Element, color: string = 'FF0000'): void {
    // For each w:r in the paragraph, add/set w:color to specified color
    const rNodes = nodeListToArray(pNode.getElementsByTagName('w:r'));
    for (const r of rNodes) {
        ensureRunColorRed(r as Element, color);
    }
}

/**
 * Apply style to all runs in a paragraph
 * Follows exact same pattern as reference implementation
 * Preserves all existing w:rPr children, only modifies/adds specified style properties
 */
export function styleParagraphRuns(
    pNode: Element,
    style: { color?: string; bold?: boolean; italic?: boolean }
): void {
    const doc = pNode.ownerDocument;
    if (!doc) return;

    // For each w:r in the paragraph, apply styles
    const rNodes = nodeListToArray(pNode.getElementsByTagName('w:r'));
    for (const r of rNodes) {
        // Find or create w:rPr under this w:r (same pattern as ensureRunColorRed)
        let rPr: Element | null = null;
        for (const child of nodeListToArray(r.childNodes)) {
            if (child.nodeType === 1 && (child as Element).nodeName === 'w:rPr') {
                rPr = child as Element;
                break;
            }
        }

        if (!rPr) {
            rPr = doc.createElement('w:rPr');
            // Insert rPr as the first element child of w:r (standard structure)
            if (r.firstChild) {
                r.insertBefore(rPr, r.firstChild);
            } else {
                r.appendChild(rPr);
            }
        }

        // Apply color (same pattern as ensureRunColorRed)
        if (style.color) {
            let colorNode: Element | null = null;
            for (const child of nodeListToArray(rPr.childNodes)) {
                if (child.nodeType === 1 && (child as Element).nodeName === 'w:color') {
                    colorNode = child as Element;
                    break;
                }
            }
            if (!colorNode) {
                colorNode = doc.createElement('w:color');
                rPr.appendChild(colorNode);
            }
            // Set w:val attribute (namespace handling: xmldom will keep prefix)
            colorNode.setAttribute('w:val', style.color);
        }

        // Apply bold
        if (style.bold !== undefined) {
            let boldNode: Element | null = null;
            for (const child of nodeListToArray(rPr.childNodes)) {
                if (child.nodeType === 1 && (child as Element).nodeName === 'w:b') {
                    boldNode = child as Element;
                    break;
                }
            }
            if (style.bold) {
                if (!boldNode) {
                    boldNode = doc.createElement('w:b');
                    rPr.appendChild(boldNode);
                }
            } else if (boldNode) {
                rPr.removeChild(boldNode);
            }
        }

        // Apply italic
        if (style.italic !== undefined) {
            let italicNode: Element | null = null;
            for (const child of nodeListToArray(rPr.childNodes)) {
                if (child.nodeType === 1 && (child as Element).nodeName === 'w:i') {
                    italicNode = child as Element;
                    break;
                }
            }
            if (style.italic) {
                if (!italicNode) {
                    italicNode = doc.createElement('w:i');
                    rPr.appendChild(italicNode);
                }
            } else if (italicNode) {
                rPr.removeChild(italicNode);
            }
        }
    }
}

