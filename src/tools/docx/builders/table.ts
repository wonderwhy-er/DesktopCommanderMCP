/**
 * Table builder — creates w:tbl elements with headers, rows, and styling.
 */

import type { DocxContentTable, InsertTableOp } from '../types.js';

/**
 * Build a table element from content structure or operation.
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

    // Table grid
    const colCount = spec.headers
        ? spec.headers.length
        : spec.rows.length > 0
            ? spec.rows[0].length
            : 0;

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

    // Helper to build a cell
    const buildCell = (text: string, isHeader: boolean, widthTwips?: number): Element => {
        const tc = doc.createElement('w:tc');
        if (widthTwips) {
            const tcPr = doc.createElement('w:tcPr');
            const tcW = doc.createElement('w:tcW');
            tcW.setAttribute('w:w', String(widthTwips));
            tcW.setAttribute('w:type', 'dxa');
            tcPr.appendChild(tcW);
            tc.appendChild(tcPr);
        }
        const p = doc.createElement('w:p');
        const r = doc.createElement('w:r');
        if (isHeader) {
            const rPr = doc.createElement('w:rPr');
            const b = doc.createElement('w:b');
            rPr.appendChild(b);
            r.appendChild(rPr);
        }
        const t = doc.createElement('w:t');
        t.setAttribute('xml:space', 'preserve');
        t.textContent = text;
        r.appendChild(t);
        p.appendChild(r);
        tc.appendChild(p);
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

