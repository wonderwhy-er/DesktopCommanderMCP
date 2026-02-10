/**
 * Legacy DOCX modification operations.
 *
 * These functions support the older write_file / edit_block paths that
 * modify DOCX via simple operations (replace, insert, delete, style).
 * They are distinct from the new patch-based writeDocxPatched pipeline.
 *
 * Single Responsibility: create / modify DOCX content using the legacy
 * DocxModification interface.  Delegates XML parsing and element
 * manipulation to the shared dom.ts module.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { DocxModification } from './types.js';
import {
    nodeListToArray,
    getParagraphText,
    setParagraphTextMinimal,
    colorParagraphRuns,
    styleParagraphRuns,
} from './dom.js';

// ═══════════════════════════════════════════════════════════════════════
// Helpers (private to this module)
// ═══════════════════════════════════════════════════════════════════════

/** Get all direct w:p children of body in document order. */
function getParagraphs(body: Element): Element[] {
    const paragraphs: Element[] = [];
    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:p') {
            paragraphs.push(child as Element);
        }
    }
    return paragraphs;
}

/** Parse DOCX and return { zip, dom, body }. */
function parseDocument(inputBuf: Buffer): {
    zip: PizZip;
    dom: Document;
    body: Element;
} {
    const zip = new PizZip(inputBuf);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const dom = new DOMParser().parseFromString(docFile.asText(), 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) throw new Error('Invalid DOCX: missing w:body');

    return { zip, dom, body };
}

// ═══════════════════════════════════════════════════════════════════════
// modifyDocxContent — apply legacy modifications
// ═══════════════════════════════════════════════════════════════════════

/**
 * Open an existing DOCX, apply an ordered list of modifications to
 * word/document.xml, and write the result to outputPath.
 * Every other file in the ZIP (styles, images, rels, …) is preserved.
 */
export async function modifyDocxContent(
    inputPath: string,
    outputPath: string,
    modifications: DocxModification[],
): Promise<void> {
    const inputBuf = await fs.readFile(inputPath);
    const { zip, dom, body } = parseDocument(inputBuf);

    for (const mod of modifications) {
        switch (mod.type) {
            case 'replace':
                applyReplace(body, mod);
                break;
            case 'insert':
                applyInsert(body, mod);
                break;
            case 'delete':
                applyDelete(body, mod);
                break;
            case 'style':
                applyStyle(body, mod);
                break;
        }
    }

    const outXml = new XMLSerializer().serializeToString(dom);
    zip.file('word/document.xml', outXml);
    const outBuf = zip.generate({ type: 'nodebuffer' });
    await fs.writeFile(outputPath, outBuf);
}

// ═══════════════════════════════════════════════════════════════════════
// replaceBodyXml — wholesale body replacement
// ═══════════════════════════════════════════════════════════════════════

/**
 * Replace the entire w:body content of a DOCX with new body XML.
 * Used by the body-XML replacement mode of write_file.
 */
export async function replaceBodyXml(
    inputPath: string,
    outputPath: string,
    newBodyXml: string,
): Promise<void> {
    const tempDir = os.tmpdir();
    const tempDocxPath = path.join(tempDir, `docx_temp_${Date.now()}_${Math.random().toString(36).substring(7)}.docx`);
    const tempXmlPath = path.join(tempDir, `docx_dom_${Date.now()}_${Math.random().toString(36).substring(7)}.xml`);

    try {
        const inputBuf = await fs.readFile(inputPath);
        await fs.writeFile(tempDocxPath, inputBuf);

        const { zip, dom, body } = parseDocument(inputBuf);
        await fs.writeFile(tempXmlPath, zip.file('word/document.xml')!.asText());

        // Parse the new body XML
        const newBodyDom = new DOMParser().parseFromString(
            `<root>${newBodyXml}</root>`,
            'application/xml',
        );
        const newBodyElement = newBodyDom.documentElement.firstChild as Element;
        if (!newBodyElement || newBodyElement.nodeName !== 'w:body') {
            throw new Error('Invalid body XML: must start with <w:body>');
        }

        // Import children from new body into original document
        const doc = body.ownerDocument;
        if (!doc) throw new Error('Document owner not found');

        while (body.firstChild) body.removeChild(body.firstChild);

        for (const child of nodeListToArray(newBodyElement.childNodes)) {
            body.appendChild(doc.importNode(child, true));
        }

        const outXml = new XMLSerializer().serializeToString(dom);
        zip.file('word/document.xml', outXml);
        const outBuf = zip.generate({ type: 'nodebuffer' });
        await fs.writeFile(outputPath, outBuf);
    } finally {
        try { await fs.unlink(tempDocxPath); } catch { /* ignore */ }
        try { await fs.unlink(tempXmlPath); } catch { /* ignore */ }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// writeDocx — create minimal DOCX from plain text
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a brand-new minimal DOCX from a plain-text string.
 * Double-newlines are treated as paragraph separators.
 */
export async function writeDocx(
    outputPath: string,
    content: string | DocxModification[],
): Promise<void> {
    if (typeof content !== 'string') {
        throw new Error(
            'Modifications require an existing DOCX file. Use modifyDocxContent() instead.',
        );
    }

    const zip = new PizZip();

    const escaped = (s: string) =>
        s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${content
    .split('\n\n')
    .map(
        (para) => `    <w:p>
      <w:r>
        <w:t>${escaped(para)}</w:t>
      </w:r>
    </w:p>`,
    )
    .join('\n')}
  </w:body>
</w:document>`;

    zip.file('word/document.xml', docXml);

    zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    );

    zip.folder('_rels')?.file(
        '.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );

    zip.folder('word')?.folder('_rels')?.file(
        'document.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`,
    );

    const outBuf = zip.generate({ type: 'nodebuffer' });
    await fs.writeFile(outputPath, outBuf);
}

// ═══════════════════════════════════════════════════════════════════════
// Private modification appliers (SRP: one function per modification type)
// ═══════════════════════════════════════════════════════════════════════

function applyReplace(body: Element, mod: DocxModification): void {
    if (mod.findText === undefined) return;
    const target = mod.findText.trim();

    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1 || (child as Element).nodeName !== 'w:p') continue;
        if (getParagraphText(child as Element).trim() !== target) continue;

        if (mod.replaceText !== undefined) {
            setParagraphTextMinimal(child as Element, mod.replaceText);
        }
        if (mod.style) {
            if (mod.style.color) colorParagraphRuns(child as Element, mod.style.color);
            if (mod.style.bold !== undefined || mod.style.italic !== undefined) {
                styleParagraphRuns(child as Element, mod.style);
            }
        }
        break; // first match only
    }
}

function applyInsert(body: Element, mod: DocxModification): void {
    if (mod.paragraphIndex === undefined || mod.insertText === undefined) return;

    const doc = body.ownerDocument;
    if (!doc) return;

    const newP = doc.createElement('w:p');
    const newR = doc.createElement('w:r');
    const newT = doc.createElement('w:t');
    newT.textContent = mod.insertText;
    newR.appendChild(newT);
    newP.appendChild(newR);

    const paragraphs = getParagraphs(body);
    const idx = mod.paragraphIndex < 0
        ? paragraphs.length + mod.paragraphIndex + 1
        : mod.paragraphIndex;

    if (idx < 0 || idx > paragraphs.length) return;

    if (idx === paragraphs.length) {
        body.appendChild(newP);
    } else {
        let current = 0;
        for (const child of nodeListToArray(body.childNodes)) {
            if (child.nodeType !== 1 || (child as Element).nodeName !== 'w:p') continue;
            if (current === idx) {
                body.insertBefore(newP, child);
                break;
            }
            current++;
        }
    }
}

function applyDelete(body: Element, mod: DocxModification): void {
    if (mod.paragraphIndex === undefined) return;

    const paragraphs = getParagraphs(body);
    const idx = mod.paragraphIndex < 0
        ? paragraphs.length + mod.paragraphIndex
        : mod.paragraphIndex;

    if (idx < 0 || idx >= paragraphs.length) return;

    let current = 0;
    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1 || (child as Element).nodeName !== 'w:p') continue;
        if (current === idx) {
            body.removeChild(child);
            break;
        }
        current++;
    }
}

function applyStyle(body: Element, mod: DocxModification): void {
    if (mod.paragraphIndex === undefined || !mod.style) return;

    const paragraphs = getParagraphs(body);
    const idx = mod.paragraphIndex < 0
        ? paragraphs.length + mod.paragraphIndex
        : mod.paragraphIndex;

    if (idx < 0 || idx >= paragraphs.length) return;

    let current = 0;
    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1 || (child as Element).nodeName !== 'w:p') continue;
        if (current === idx) {
            if (mod.style.color) colorParagraphRuns(child as Element, mod.style.color);
            if (mod.style.bold !== undefined || mod.style.italic !== undefined) {
                styleParagraphRuns(child as Element, mod.style);
            }
            break;
        }
        current++;
    }
}

