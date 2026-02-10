/**
 * DOCX reading utilities
 * Extracts text, metadata, and compact outlines from DOCX files.
 */

import fs from 'fs/promises';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { DocxMetadata, DocxParagraph, ParagraphOutline, ReadDocxResult } from './types.js';
import {
    nodeListToArray,
    getParagraphText,
    getParagraphStyle,
    getBody,
    getBodyChildren,
    countTables,
    countImages,
} from './dom.js';

// ═══════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════

async function loadDocx(path: string): Promise<PizZip> {
    const inputBuf = await fs.readFile(path);
    return new PizZip(inputBuf);
}

// ═══════════════════════════════════════════════════════════════════════
// readDocxOutline — compact JSON outline (used by read_docx tool)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a token-efficient outline of a DOCX file.
 * Every paragraph gets a bodyChildIndex (among ALL w:body children)
 * plus a paragraphIndex (counting only w:p), style id, and text.
 */
export async function readDocxOutline(filePath: string): Promise<ReadDocxResult> {
    const zip = await loadDocx(filePath);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = getBody(dom);
    const children = getBodyChildren(body);

    const paragraphs: ParagraphOutline[] = [];
    const stylesSet = new Set<string>();
    let paragraphIndex = 0;

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeName !== 'w:p') continue;

        const text = getParagraphText(child).trim();
        const style = getParagraphStyle(child);

        if (style) stylesSet.add(style);

        paragraphs.push({
            bodyChildIndex: i,
            paragraphIndex,
            style,
            text,
        });
        paragraphIndex++;
    }

    return {
        path: filePath,
        paragraphs,
        stylesSeen: [...stylesSet].sort(),
        counts: {
            tables: countTables(children),
            images: countImages(body),
            bodyChildren: children.length,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Legacy read functions (used by read_file handler / file handler)
// ═══════════════════════════════════════════════════════════════════════

/** Extract plain text from DOCX. */
export async function extractTextFromDocx(path: string): Promise<string> {
    const zip = await loadDocx(path);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) throw new Error('Invalid DOCX: missing w:body');

    const paragraphs: string[] = [];
    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1) continue;
        if ((child as Element).nodeName !== 'w:p') continue;
        const text = getParagraphText(child as Element).trim();
        if (text) paragraphs.push(text);
    }

    return paragraphs.join('\n\n');
}

/** Extract paragraphs from DOCX. */
async function extractParagraphs(path: string): Promise<DocxParagraph[]> {
    const zip = await loadDocx(path);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) throw new Error('Invalid DOCX: missing w:body');

    const paragraphs: DocxParagraph[] = [];
    let index = 0;

    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1) continue;
        if ((child as Element).nodeName !== 'w:p') continue;

        const text = getParagraphText(child as Element).trim();
        paragraphs.push({ index, text, hasText: text.length > 0 });
        index++;
    }

    return paragraphs;
}

/** Get core properties from DOCX. */
async function getCoreProperties(zip: PizZip): Promise<Partial<DocxMetadata>> {
    const corePropsFile = zip.file('docProps/core.xml');
    if (!corePropsFile) return {};

    const xmlStr = corePropsFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');

    const getProperty = (name: string): string | undefined => {
        const elements = dom.getElementsByTagName(name);
        if (elements.length > 0) return elements[0].textContent || undefined;
        return undefined;
    };

    return {
        title: getProperty('dc:title'),
        author: getProperty('dc:creator'),
        subject: getProperty('dc:subject'),
        creator: getProperty('cp:creator'),
    };
}

/** Get comprehensive metadata. */
export async function getDocxMetadata(path: string): Promise<DocxMetadata> {
    const zip = await loadDocx(path);
    const paragraphs = await extractParagraphs(path);
    const coreProps = await getCoreProperties(zip);
    const fullText = paragraphs.map((p) => p.text).join(' ');
    const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;

    return { ...coreProps, paragraphCount: paragraphs.length, wordCount };
}

/** Extract body XML. */
export async function extractBodyXml(path: string): Promise<string> {
    const inputBuf = await fs.readFile(path);
    const zip = new PizZip(inputBuf);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) throw new Error('Invalid DOCX: missing w:body');

    return new XMLSerializer().serializeToString(body);
}

/** Read DOCX file with optional pagination. */
export async function readDocx(
    path: string,
    options?: { offset?: number; length?: number },
): Promise<{
    text: string;
    paragraphs: DocxParagraph[];
    metadata: DocxMetadata;
    bodyXml: string;
}> {
    const zip = await loadDocx(path);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) throw new Error('Invalid DOCX: missing w:body');

    const allParagraphs: DocxParagraph[] = [];
    let index = 0;

    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1) continue;
        if ((child as Element).nodeName !== 'w:p') continue;

        const text = getParagraphText(child as Element).trim();
        allParagraphs.push({ index, text, hasText: text.length > 0 });
        index++;
    }

    let paragraphs = allParagraphs;
    if (options?.offset !== undefined || options?.length !== undefined) {
        const offset = options.offset || 0;
        const length = options.length !== undefined ? options.length : allParagraphs.length;
        paragraphs = allParagraphs.slice(offset, offset + length);
    }

    const metadata = await getDocxMetadata(path);
    const text = paragraphs.map((p) => p.text).join('\n\n');
    const bodyXml = new XMLSerializer().serializeToString(body);

    return { text, paragraphs, metadata, bodyXml };
}
