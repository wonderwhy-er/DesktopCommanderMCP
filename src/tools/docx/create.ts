/**
 * createDocxNew - Create a brand-new professional DOCX file from scratch.
 *
 * Single Responsibility: Build a complete, professional DOCX structure
 * with proper styles, document defaults, and content from styled DOM structure.
 *
 * This function does NOT read any existing files - it creates everything
 * from scratch with a professional structure.
 */

import fs from 'fs/promises';
import path from 'path';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseXml, serializeXml, getBody } from './dom.js';
import type {
    DocxContentStructure,
    DocxContentItem,
    DocxContentParagraph,
    DocxContentTable,
    DocxContentImage,
    WriteDocxStats,
    WriteDocxResult,
} from './types.js';

/**
 * Create a professional DOCX ZIP structure with:
 * - Complete styles.xml (Normal, Heading1-9, etc.)
 * - Document defaults (fonts, spacing, colors)
 * - Proper relationships
 * - Content types
 * - Empty document body ready for content
 */
function createProfessionalDocxZip(): PizZip {
    const zip = new PizZip();

    // ─── [Content_Types].xml ──────────────────────────────────────────
    zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="bmp" ContentType="image/bmp"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    );

    // ─── _rels/.rels ──────────────────────────────────────────────────
    zip.folder('_rels')?.file(
        '.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );

    // ─── word/_rels/document.xml.rels ────────────────────────────────
    zip.folder('word')?.folder('_rels')?.file(
        'document.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`,
    );

    // ─── word/styles.xml ───────────────────────────────────────────────
    zip.file(
        'word/styles.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <!-- Document Defaults -->
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="000000"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="200" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>

  <!-- Normal Style -->
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="200" w:line="276" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="000000"/>
    </w:rPr>
  </w:style>

  <!-- Heading Styles -->
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="480" w:after="0"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="32"/>
      <w:szCs w:val="32"/>
      <w:color w:val="2F5496"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="Heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="1"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
      <w:color w:val="2F5496"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="Heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="2"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="Heading 4"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="3"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="Heading 5"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="4"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="Heading 6"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="5"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading7">
    <w:name w:val="Heading 7"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="6"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading8">
    <w:name w:val="Heading 8"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="7"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading9">
    <w:name w:val="Heading 9"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="0"/>
      <w:outlineLvl w:val="8"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="1F3763"/>
    </w:rPr>
  </w:style>

  <!-- List Styles -->
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:left="720"/>
    </w:pPr>
  </w:style>

  <!-- Table Styles -->
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:basedOn w:val="NormalTable"/>
    <w:qFormat/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>`,
    );

    // ─── word/document.xml ─────────────────────────────────────────────
    zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
  </w:body>
</w:document>`,
    );

    // ─── word/settings.xml ────────────────────────────────────────────
    zip.file(
        'word/settings.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
  </w:compat>
</w:settings>`,
    );

    // ─── word/webSettings.xml ────────────────────────────────────────
    zip.file(
        'word/webSettings.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:optimizeForBrowser/>
</w:webSettings>`,
    );

    // ─── word/fontTable.xml ───────────────────────────────────────────
    zip.file(
        'word/fontTable.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:font w:name="Calibri">
    <w:panose1 w:val="020F0502020204030204"/>
    <w:charset w:val="00"/>
    <w:family w:val="swiss"/>
    <w:pitch w:val="variable"/>
    <w:sig w:usb0="E00002FF" w:usb1="4000ACFF" w:usb2="00000001" w:usb3="00000000" w:csb0="0000019F" w:csb1="00000000"/>
  </w:font>
  <w:font w:name="Calibri Light">
    <w:panose1 w:val="020F0302020204030204"/>
    <w:charset w:val="00"/>
    <w:family w:val="swiss"/>
    <w:pitch w:val="variable"/>
    <w:sig w:usb0="E00002FF" w:usb1="4000ACFF" w:usb2="00000001" w:usb3="00000000" w:csb0="0000019F" w:csb1="00000000"/>
  </w:font>
  <w:font w:name="Times New Roman">
    <w:panose1 w:val="02020603050405020304"/>
    <w:charset w:val="00"/>
    <w:family w:val="roman"/>
    <w:pitch w:val="variable"/>
    <w:sig w:usb0="E0002AFF" w:usb1="C0007841" w:usb2="00000009" w:usb3="00000000" w:csb0="000001FF" w:csb1="00000000"/>
  </w:font>
</w:fonts>`,
    );

    // ─── Create media folder ───────────────────────────────────────────
    zip.folder('word')?.folder('media');

    return zip;
}

// ─── Content builders ──────────────────────────────────────────────────

function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build a paragraph element from content structure.
 */
function buildParagraph(doc: Document, item: DocxContentParagraph): Element {
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

/**
 * Build a table element from content structure.
 */
function buildTable(doc: Document, item: DocxContentTable): Element {
    const tbl = doc.createElement('w:tbl');

    // Table properties
    const tblPr = doc.createElement('w:tblPr');
    if (item.style) {
        const tblStyle = doc.createElement('w:tblStyle');
        tblStyle.setAttribute('w:val', item.style);
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
    const colCount = item.headers ? item.headers.length : item.rows.length > 0 ? item.rows[0].length : 0;
    if (colCount > 0) {
        const tblGrid = doc.createElement('w:tblGrid');
        for (let c = 0; c < colCount; c++) {
            const gridCol = doc.createElement('w:gridCol');
            const w = item.colWidths?.[c] ?? Math.floor(9000 / colCount);
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
    if (item.headers && item.headers.length > 0) {
        const tr = doc.createElement('w:tr');
        for (let i = 0; i < item.headers.length; i++) {
            const width = item.colWidths?.[i];
            tr.appendChild(buildCell(item.headers[i], true, width));
        }
        tbl.appendChild(tr);
    }

    // Data rows
    for (const row of item.rows) {
        const tr = doc.createElement('w:tr');
        for (let i = 0; i < row.length; i++) {
            const width = item.colWidths?.[i];
            tr.appendChild(buildCell(row[i], false, width));
        }
        tbl.appendChild(tr);
    }

    return tbl;
}

/**
 * Build image drawing XML and add to ZIP.
 */
async function buildImage(
    doc: Document,
    zip: PizZip,
    item: DocxContentImage,
): Promise<Element> {
    // Validate image exists
    try {
        await fs.access(item.imagePath);
    } catch {
        throw new Error(`Image file not found: ${item.imagePath}`);
    }

    // Read image
    const imgBuffer = await fs.readFile(item.imagePath);
    const ext = path.extname(item.imagePath).toLowerCase();
    const baseName = path.basename(item.imagePath);

    // Find next available media filename
    let mediaIndex = 1;
    while (zip.file(`word/media/image${mediaIndex}${ext}`)) {
        mediaIndex++;
    }
    const mediaFileName = `image${mediaIndex}${ext}`;

    // Add image to ZIP
    zip.file(`word/media/${mediaFileName}`, imgBuffer);

    // Add relationship
    const relsPath = 'word/_rels/document.xml.rels';
    const relsEntry = zip.file(relsPath);
    if (!relsEntry) throw new Error('Missing document.xml.rels');

    const relsXml = relsEntry.asText();
    const relsDom = new DOMParser().parseFromString(relsXml, 'application/xml');
    const relationships = relsDom.getElementsByTagName('Relationship');

    // Find max existing rId
    let maxId = 0;
    for (const rel of Array.from(relationships)) {
        const id = (rel as Element).getAttribute('Id') || '';
        const match = id.match(/^rId(\d+)$/);
        if (match) {
            maxId = Math.max(maxId, parseInt(match[1], 10));
        }
    }

    const newRId = `rId${maxId + 1}`;
    const newRel = relsDom.createElement('Relationship');
    newRel.setAttribute('Id', newRId);
    newRel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');
    newRel.setAttribute('Target', `media/${mediaFileName}`);
    relsDom.documentElement.appendChild(newRel);

    const newRelsXml = new XMLSerializer().serializeToString(relsDom);
    zip.file(relsPath, newRelsXml);

    // Ensure Content_Types entry
    const ctPath = '[Content_Types].xml';
    const ctEntry = zip.file(ctPath);
    if (ctEntry) {
        const ctXml = ctEntry.asText();
        const extNoDot = ext.replace(/^\./, '');
        if (!ctXml.includes(`Extension="${extNoDot}"`)) {
            const ctDom = new DOMParser().parseFromString(ctXml, 'application/xml');
            const types = ctDom.documentElement;
            const defaultEl = ctDom.createElement('Default');
            defaultEl.setAttribute('Extension', extNoDot);
            const mimeMap: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.bmp': 'image/bmp',
            };
            defaultEl.setAttribute('ContentType', mimeMap[ext] ?? 'application/octet-stream');
            types.appendChild(defaultEl);
            const newCtXml = new XMLSerializer().serializeToString(ctDom);
            zip.file(ctPath, newCtXml);
        }
    }

    // Compute dimensions (EMU)
    const PX_TO_EMU = 9525;
    const widthPx = item.width ?? 300;
    const heightPx = item.height ?? 200;
    const widthEmu = widthPx * PX_TO_EMU;
    const heightEmu = heightPx * PX_TO_EMU;

    // Build drawing XML
    const drawingXmlStr =
        `<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
        `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
        `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
        `<wp:docPr id="1" name="${mediaFileName}" descr="${escapeXmlAttr(item.altText ?? baseName)}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr>` +
        `<pic:cNvPr id="0" name="${mediaFileName}" descr="${escapeXmlAttr(item.altText ?? baseName)}"/>` +
        `<pic:cNvPicPr/>` +
        `</pic:nvPicPr>` +
        `<pic:blipFill>` +
        `<a:blip r:embed="${newRId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</pic:blipFill>` +
        `<pic:spPr>` +
        `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `</pic:spPr>` +
        `</pic:pic>` +
        `</a:graphicData>` +
        `</a:graphic>` +
        `</wp:inline>` +
        `</w:drawing>`;

    // Parse drawing XML into a paragraph
    const drawingFragment = new DOMParser().parseFromString(
        `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:r>${drawingXmlStr}</w:r></w:p>`,
        'application/xml',
    );

    return doc.importNode(drawingFragment.documentElement, true) as Element;
}

/**
 * Create a new professional DOCX file from content structure.
 *
 * This function creates a complete DOCX structure from scratch with:
 * - Professional styles (Normal, Heading1-9, ListParagraph, TableGrid)
 * - Document defaults (Calibri font, proper spacing)
 * - Complete ZIP structure
 *
 * Then builds content from the provided structure.
 */
export async function createDocxNew(
    outputPath: string,
    content: DocxContentStructure,
): Promise<WriteDocxResult> {
    // 1. Create professional DOCX ZIP structure
    const zip = createProfessionalDocxZip();

    // 2. Parse empty document.xml
    const xmlStr = zip.file('word/document.xml')!.asText();
    const doc = parseXml(xmlStr);
    const body = getBody(doc);

    // 3. Build content from structure
    let tableCount = 0;
    for (const item of content.items) {
        if (item.type === 'paragraph') {
            const p = buildParagraph(doc, item);
            body.appendChild(p);
        } else if (item.type === 'table') {
            const tbl = buildTable(doc, item);
            body.appendChild(tbl);
            tableCount++;
        } else if (item.type === 'image') {
            const imgP = await buildImage(doc, zip, item);
            body.appendChild(imgP);
        }
    }

    // 4. Serialize and save
    const newXml = serializeXml(doc);
    zip.file('word/document.xml', newXml);
    const buf = zip.generate({ type: 'nodebuffer' });
    await fs.writeFile(outputPath, buf);

    // 5. Build stats
    const bodyChildCount = content.items.length;
    const stats: WriteDocxStats = {
        tablesBefore: 0,
        tablesAfter: tableCount,
        bodyChildrenBefore: 0,
        bodyChildrenAfter: bodyChildCount,
        bodySignatureBefore: '',
        bodySignatureAfter: '', // Could compute if needed
    };

    return {
        outputPath,
        results: [], // No ops were applied
        stats,
        warnings: [],
    };
}
