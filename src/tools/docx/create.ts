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
import PizZip from 'pizzip';
import { parseXml, serializeXml, getBody } from './dom.js';
import { buildParagraph, buildTable, buildImageElement } from './builders/index.js';
import type {
    DocxContentStructure,
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

// ─── Content builders are now in ./builders/index.js ───────────────────

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
            const imgP = await buildImageElement(doc, zip, item);
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
