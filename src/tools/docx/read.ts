/**
 * DOCX reading utilities
 * Extracts text, metadata, and compact outlines from DOCX files.
 */

import fs from 'fs/promises';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type {
    DocxMetadata,
    DocxParagraph,
    ParagraphOutline,
    TableOutline,
    ImageOutline,
    ReadDocxResult,
} from './types.js';
import {
    nodeListToArray,
    getParagraphText,
    getParagraphStyle,
    getBody,
    getBodyChildren,
    countTables,
    countImages,
    getTableContent,
    getTableStyle,
    getImageReference,
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
 * Extract image relationship mappings from word/_rels/document.xml.rels.
 * Returns a map of rId -> mediaPath (e.g., "rId1" -> "word/media/image1.png").
 */
function extractImageRelationships(zip: PizZip): Map<string, string> {
    const relsPath = 'word/_rels/document.xml.rels';
    const relsFile = zip.file(relsPath);
    if (!relsFile) return new Map();

    const relsXml = relsFile.asText();
    const relsDom = new DOMParser().parseFromString(relsXml, 'application/xml');
    const relationships = relsDom.getElementsByTagName('Relationship');

    const imageMap = new Map<string, string>();
    for (const rel of nodeListToArray(relationships)) {
        const relEl = rel as Element;
        const type = relEl.getAttribute('Type');
        const id = relEl.getAttribute('Id');
        const target = relEl.getAttribute('Target');

        // Check if it's an image relationship
        if (
            type &&
            type.includes('/image') &&
            id &&
            target &&
            target.startsWith('media/')
        ) {
            imageMap.set(id, `word/${target}`);
        }
    }

    return imageMap;
}

/**
 * Extract alt text from wp:docPr/@descr or pic:cNvPr/@descr in a drawing element.
 */
function getImageAltText(drawing: Element): string | undefined {
    // Try wp:docPr/@descr first
    const docPr = drawing.getElementsByTagName('wp:docPr').item(0);
    if (docPr) {
        const descr = docPr.getAttribute('descr');
        if (descr) return descr;
    }

    // Fall back to pic:cNvPr/@descr
    const cNvPr = drawing.getElementsByTagName('pic:cNvPr').item(0);
    if (cNvPr) {
        const descr = cNvPr.getAttribute('descr');
        if (descr) return descr;
    }

    return undefined;
}

/**
 * Return a token-efficient outline of a DOCX file.
 * Extracts paragraphs, tables (with full cell content), and images (references only, not binary).
 * Every element gets a bodyChildIndex (among ALL w:body children).
 */
export async function readDocxOutline(filePath: string): Promise<ReadDocxResult> {
    const zip = await loadDocx(filePath);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = getBody(dom);
    const children = getBodyChildren(body);

    // Extract image relationships (rId -> mediaPath)
    const imageRelationships = extractImageRelationships(zip);

    const paragraphs: ParagraphOutline[] = [];
    const tables: TableOutline[] = [];
    const images: ImageOutline[] = [];
    const stylesSet = new Set<string>();

    let paragraphIndex = 0;
    let tableIndex = 0;
    let imageIndex = 0;

    for (let i = 0; i < children.length; i++) {
        const child = children[i];

        if (child.nodeName === 'w:p') {
            // Extract paragraph
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

            // Check if paragraph contains an image (w:drawing)
            const drawings = child.getElementsByTagName('w:drawing');
            for (let d = 0; d < drawings.length; d++) {
                const drawing = drawings.item(d) as Element;
                const imgRef = getImageReference(drawing);

                if (imgRef.rId) {
                    const mediaPath = imageRelationships.get(imgRef.rId);
                    if (mediaPath) {
                        const altText = getImageAltText(drawing);
                        images.push({
                            bodyChildIndex: i,
                            imageIndex,
                            mediaPath,
                            rId: imgRef.rId,
                            altText,
                        });
                        imageIndex++;
                    }
                }
            }
        } else if (child.nodeName === 'w:tbl') {
            // Extract table content
            const tableContent = getTableContent(child);
            const style = getTableStyle(child);

            if (style) stylesSet.add(style);

            tables.push({
                bodyChildIndex: i,
                tableIndex,
                style,
                headers: tableContent.headers,
                rows: tableContent.rows,
            });
            tableIndex++;
        }
    }

    return {
        path: filePath,
        paragraphs,
        tables,
        images,
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
