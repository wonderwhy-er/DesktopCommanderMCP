/**
 * DOCX ZIP I/O — Single Responsibility: file ↔ zip ↔ xml.
 *
 * Every other module depends on these three functions for disk I/O;
 * none of them touch the file system directly.
 */

import fs from 'fs/promises';
import PizZip from 'pizzip';

/**
 * Read a .docx file from disk and return a PizZip instance.
 */
export async function loadDocxZip(filePath: string): Promise<PizZip> {
    const buf = await fs.readFile(filePath);
    return new PizZip(buf);
}

/**
 * Extract the raw XML string from word/document.xml inside the zip.
 * Throws if the entry is missing.
 */
export function getDocumentXml(zip: PizZip): string {
    const entry = zip.file('word/document.xml');
    if (!entry) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }
    return entry.asText();
}

/**
 * Replace word/document.xml in the zip with new XML,
 * then write the whole archive to outputPath.
 */
export async function saveDocxZip(
    zip: PizZip,
    newDocumentXml: string,
    outputPath: string,
): Promise<void> {
    zip.file('word/document.xml', newDocumentXml);
    const buf = zip.generate({ type: 'nodebuffer' });
    await fs.writeFile(outputPath, buf);
}

