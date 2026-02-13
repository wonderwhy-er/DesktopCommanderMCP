/**
 * Table builder — creates w:tbl elements with headers, rows, and styling.
 * Supports multiple paragraphs per cell with different styles.
 */

import type { DocxContentTable, InsertTableOp, DocxContentParagraph } from '../types.js';
import { buildParagraph } from './paragraph.js';

/**
 * Build a table element from content structure or operation.
 * Supports cells with multiple paragraphs, each with its own style.
 */
export function buildTable(
    doc: Document,
    spec: DocxContentTable | InsertTableOp,
): Element {
    const tbl = doc.createElement('w:tbl');

    // Table properties
    const tblPr = doc.createElement('w:tblPr');
    if (spec.style) {
        const tblStyle = doc.createElement('w:tblStyle');
        tblStyle.setAttribute('w:val', spec.style);
        tblPr.appendChild(tblStyle);
    }
    const tblW = doc.createElement('w:tblW');
    tblW.setAttribute('w:w', '0');
    tblW.setAttribute('w:type', 'auto');
    tblPr.appendChild(tblW);

    // Table borders
    const tblBorders = doc.createElement('w:tblBorders');
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] as const) {
        const border = doc.createElement(`w:${side}`);
        border.setAttribute('w:val', 'single');
        border.setAttribute('w:sz', '4');
        border.setAttribute('w:space', '0');
        border.setAttribute('w:color', '000000');
        tblBorders.appendChild(border);
    }
    tblPr.appendChild(tblBorders);
    tbl.appendChild(tblPr);

    // Determine column count
    const colCount = spec.headers
        ? spec.headers.length
        : spec.rows.length > 0
            ? spec.rows[0].length
            : 0;

    // Table grid
    if (colCount > 0) {
        const tblGrid = doc.createElement('w:tblGrid');
        for (let c = 0; c < colCount; c++) {
            const gridCol = doc.createElement('w:gridCol');
            const w = spec.colWidths?.[c] ?? Math.floor(9000 / colCount);
            gridCol.setAttribute('w:w', String(w));
            tblGrid.appendChild(gridCol);
        }
        tbl.appendChild(tblGrid);
    }

    /**
     * Build a cell from content.
     * Content can be:
     * - A string: creates one paragraph with that text
     * - An array of DocxContentParagraph: creates multiple paragraphs, each with its own style
     */
    const buildCell = (
        content: string | DocxContentParagraph[],
        isHeader: boolean,
        widthTwips?: number,
    ): Element => {
        const tc = doc.createElement('w:tc');

        // Cell properties (width)
        if (widthTwips) {
            const tcPr = doc.createElement('w:tcPr');
            const tcW = doc.createElement('w:tcW');
            tcW.setAttribute('w:w', String(widthTwips));
            tcW.setAttribute('w:type', 'dxa');
            tcPr.appendChild(tcW);
            tc.appendChild(tcPr);
        }

        // Handle content: string or array of paragraphs
        if (typeof content === 'string') {
            // Simple case: single paragraph
            const p = doc.createElement('w:p');
            const r = doc.createElement('w:r');

            // Header cells get bold
            if (isHeader) {
                const rPr = doc.createElement('w:rPr');
                const b = doc.createElement('w:b');
                rPr.appendChild(b);
                r.appendChild(rPr);
            }

            const t = doc.createElement('w:t');
            t.setAttribute('xml:space', 'preserve');
            t.textContent = content;
            r.appendChild(t);
            p.appendChild(r);
            tc.appendChild(p);
        } else {
            // Complex case: multiple paragraphs with different styles
            for (const paraSpec of content) {
                const p = buildParagraph(doc, paraSpec);

                // If header and first paragraph, ensure bold on runs
                if (isHeader) {
                    const runs = p.getElementsByTagName('w:r');
                    for (let i = 0; i < runs.length; i++) {
                        const run = runs.item(i) as Element;
                        let rPr = run.getElementsByTagName('w:rPr').item(0);
                        if (!rPr) {
                            rPr = doc.createElement('w:rPr');
                            if (run.firstChild) {
                                run.insertBefore(rPr, run.firstChild);
                            } else {
                                run.appendChild(rPr);
                            }
                        }
                        // Add bold if not already present
                        if (!rPr.getElementsByTagName('w:b').length) {
                            const b = doc.createElement('w:b');
                            rPr.appendChild(b);
                        }
                    }
                }

                tc.appendChild(p);
            }
        }

        return tc;
    };

    // Header row
    if (spec.headers && spec.headers.length > 0) {
        const tr = doc.createElement('w:tr');
        for (let i = 0; i < spec.headers.length; i++) {
            const width = spec.colWidths?.[i];
            tr.appendChild(buildCell(spec.headers[i], true, width));
        }
        tbl.appendChild(tr);
    }

    // Data rows
    for (const row of spec.rows) {
        const tr = doc.createElement('w:tr');
        for (let i = 0; i < row.length; i++) {
            const width = spec.colWidths?.[i];
            tr.appendChild(buildCell(row[i], false, width));
        }
        tbl.appendChild(tr);
    }

    return tbl;
}
