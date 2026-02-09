/**
 * DOCX reading utilities
 * Extracts text and metadata from DOCX files while preserving structure
 */

import fs from 'fs/promises';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { DocxMetadata, DocxParagraph } from './types.js';
import { nodeListToArray, getTextFromParagraph } from './utils.js';

/**
 * Load DOCX file and return ZIP archive
 */
async function loadDocx(path: string): Promise<PizZip> {
    const inputBuf = await fs.readFile(path);
    return new PizZip(inputBuf);
}

/**
 * Extract text content from DOCX document
 */
export async function extractTextFromDocx(path: string): Promise<string> {
    const zip = await loadDocx(path);
    const docFile = zip.file('word/document.xml');
    
    if (!docFile) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    
    if (!body) {
        throw new Error('Invalid DOCX: missing w:body');
    }

    const paragraphs: string[] = [];
    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1) continue; // element nodes only
        if ((child as Element).nodeName !== 'w:p') continue;

        const text = getTextFromParagraph(child as Element).trim();
        if (text) {
            paragraphs.push(text);
        }
    }

    return paragraphs.join('\n\n');
}

/**
 * Extract paragraphs from DOCX document
 */
export async function extractParagraphs(path: string): Promise<DocxParagraph[]> {
    const zip = await loadDocx(path);
    const docFile = zip.file('word/document.xml');
    
    if (!docFile) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    
    if (!body) {
        throw new Error('Invalid DOCX: missing w:body');
    }

    const paragraphs: DocxParagraph[] = [];
    let index = 0;

    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1) continue; // element nodes only
        if ((child as Element).nodeName !== 'w:p') continue;

        const text = getTextFromParagraph(child as Element).trim();
        paragraphs.push({
            index,
            text,
            hasText: text.length > 0
        });
        index++;
    }

    return paragraphs;
}

/**
 * Get DOCX metadata from core properties
 */
async function getCoreProperties(zip: PizZip): Promise<Partial<DocxMetadata>> {
    const corePropsFile = zip.file('docProps/core.xml');
    if (!corePropsFile) {
        return {};
    }

    const xmlStr = corePropsFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');

    const getProperty = (name: string): string | undefined => {
        const elements = dom.getElementsByTagName(name);
        if (elements.length > 0) {
            return elements[0].textContent || undefined;
        }
        return undefined;
    };

    return {
        title: getProperty('dc:title'),
        author: getProperty('dc:creator'),
        subject: getProperty('dc:subject'),
        creator: getProperty('cp:creator')
    };
}

/**
 * Get comprehensive DOCX metadata
 */
export async function getDocxMetadata(path: string): Promise<DocxMetadata> {
    const zip = await loadDocx(path);
    const paragraphs = await extractParagraphs(path);
    
    const coreProps = await getCoreProperties(zip);
    
    // Calculate word count (approximate)
    const fullText = paragraphs.map(p => p.text).join(' ');
    const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

    return {
        ...coreProps,
        paragraphCount: paragraphs.length,
        wordCount
    };
}

/**
 * Extract body XML from DOCX file
 * Returns the body element as XML string for LLM modification
 */
export async function extractBodyXml(path: string): Promise<string> {
    const inputBuf = await fs.readFile(path);
    const zip = new PizZip(inputBuf);
    
    const docFile = zip.file('word/document.xml');
    if (!docFile) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    
    // Locate body
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) {
        throw new Error('Invalid DOCX: missing w:body');
    }

    // Serialize body element to XML string
    const serializer = new XMLSerializer();
    return serializer.serializeToString(body);
}

/**
 * Read DOCX file and return structured content
 */
export async function readDocx(
    path: string,
    options?: { offset?: number; length?: number }
): Promise<{
    text: string;
    paragraphs: DocxParagraph[];
    metadata: DocxMetadata;
    bodyXml: string;
}> {
    const zip = await loadDocx(path);
    const docFile = zip.file('word/document.xml');
    
    if (!docFile) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const body = dom.getElementsByTagName('w:body').item(0);
    
    if (!body) {
        throw new Error('Invalid DOCX: missing w:body');
    }

    const allParagraphs: DocxParagraph[] = [];
    let index = 0;

    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType !== 1) continue;
        if ((child as Element).nodeName !== 'w:p') continue;

        const text = getTextFromParagraph(child as Element).trim();
        allParagraphs.push({
            index,
            text,
            hasText: text.length > 0
        });
        index++;
    }

    // Apply pagination if requested
    let paragraphs = allParagraphs;
    if (options?.offset !== undefined || options?.length !== undefined) {
        const offset = options.offset || 0;
        const length = options.length !== undefined ? options.length : allParagraphs.length;
        paragraphs = allParagraphs.slice(offset, offset + length);
    }

    const metadata = await getDocxMetadata(path);
    const text = paragraphs.map(p => p.text).join('\n\n');

    // Extract body XML for LLM modification
    const serializer = new XMLSerializer();
    const bodyXml = serializer.serializeToString(body);

    return {
        text,
        paragraphs,
        metadata,
        bodyXml
    };
}

