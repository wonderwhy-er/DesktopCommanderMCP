/**
 * Paragraph builder — creates w:p elements with optional styles.
 */

import type { DocxContentParagraph } from '../types.js';

/**
 * Build a paragraph element from content structure.
 *
 * @param doc The XML document
 * @param item The paragraph content item
 * @returns A w:p element
 */
export function buildParagraph(doc: Document, item: DocxContentParagraph): Element {
    const p = doc.createElement('w:p');

    // Set style if provided
    if (item.style) {
        const pPr = doc.createElement('w:pPr');
        const pStyle = doc.createElement('w:pStyle');
        pStyle.setAttribute('w:val', item.style);
        pPr.appendChild(pStyle);
        p.appendChild(pPr);
    }

    // Add text run
    const r = doc.createElement('w:r');
    const t = doc.createElement('w:t');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = item.text;
    r.appendChild(t);
    p.appendChild(r);

    return p;
}

