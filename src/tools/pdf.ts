import { pdf2md, Pdf2MdResult } from './lib/pdf2md-patched.js';
import { mdToPdf } from 'md-to-pdf';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Check if source is a URL
 */
function isUrl(source: string): boolean {
    return source.startsWith('http://') || source.startsWith('https://');
}

/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function pdfToMarkdown(source: string): Promise<Pdf2MdResult> {
    try {
        let data: Buffer | ArrayBuffer;

        if (isUrl(source)) {
            const response = await fetch(source);
            data = await response.arrayBuffer();
        } else {
            data = await fs.readFile(source);
        }

        // @ts-ignore: Type definition mismatch for ESM usage
        const result = await pdf2md(new Uint8Array(data));

        return result;

    } catch (error) {
        console.error("Error converting PDF to Markdown (v3):", error);
        throw error;
    }
}

export async function markdownToPdf(markdown: string, outputPath: string, options: any = {}): Promise<Buffer> {
    try {
        const pdf = await mdToPdf({ content: markdown }, options)


        return pdf.content;
    } catch (error) {
        console.error('Error creating PDF:', error);
        throw error;
    }
}

/**
 * PDF edit operation types
 */
export interface PdfEditOperation {
    type: 'delete' | 'insert';
    pageIndex: number;
    markdown?: string;
    sourcePdf?: string;
    sourcePageIndices?: number[];
    pdfOptions?: any;
}

/**
 * Edit an existing PDF by deleting or inserting pages
 * @param pdfPath Path to the PDF file to edit
 * @param operations List of operations to perform
 * @returns The modified PDF as a Uint8Array
 */
export async function editPdf(
    pdfPath: string,
    operations: PdfEditOperation[]
): Promise<Uint8Array> {
    const buffer = await fs.readFile(pdfPath);
    const pdfBytes = new Uint8Array(buffer);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Sort operations to handle deletions correctly (from end to start)
    // and insertions (from start to end to maintain order)
    const deleteOps = operations
        .filter(op => op.type === 'delete')
        .sort((a, b) => b.pageIndex - a.pageIndex);

    const insertOps = operations
        .filter(op => op.type === 'insert')
        .sort((a, b) => a.pageIndex - b.pageIndex);

    // Execute delete operations
    for (const op of deleteOps) {
        const totalPages = pdfDoc.getPageCount();
        if (op.pageIndex < 0 || op.pageIndex >= totalPages) {
            throw new Error(`Delete operation: page index ${op.pageIndex} is out of range`);
        }
        pdfDoc.removePage(op.pageIndex);
    }

    // Execute insert operations
    for (const op of insertOps) {
        let sourcePdfDoc: PDFDocument;
        let pagesToCopy: number[];
        let tempFilePath: string | null = null;

        try {
            if (op.markdown) {
                // Generate PDF from markdown
                // We ignore outputPath in markdownToPdf as it returns buffer, but we need to save it to temp file
                // to be consistent with the requirement "save it to /tmp file and use to insert pdf generated from that"
                // Although we could load directly from buffer, the requirement is specific.

                const pdfBuffer = await markdownToPdf(op.markdown, '', op.pdfOptions);

                // Create temp file
                const tempDir = os.tmpdir();
                const tempFileName = `temp_pdf_${crypto.randomUUID()}.pdf`;
                tempFilePath = path.join(tempDir, tempFileName);

                await fs.writeFile(tempFilePath, pdfBuffer);

                // Load from temp file
                const tempPdfBytes = await fs.readFile(tempFilePath);
                sourcePdfDoc = await PDFDocument.load(tempPdfBytes);
                pagesToCopy = sourcePdfDoc.getPageIndices();

            } else if (op.sourcePdf) {
                const buffer = await fs.readFile(op.sourcePdf);
                const sourcePdfBytes = new Uint8Array(buffer);
                sourcePdfDoc = await PDFDocument.load(sourcePdfBytes);
                const sourceTotalPages = sourcePdfDoc.getPageCount();
                pagesToCopy = op.sourcePageIndices ?? Array.from({ length: sourceTotalPages }, (_, i) => i);
            } else {
                throw new Error('Insert operation requires either markdown or sourcePdf');
            }

            // Copy pages from source document
            const copiedPages = await pdfDoc.copyPages(sourcePdfDoc, pagesToCopy);
            const totalPages = pdfDoc.getPageCount();

            // Ensure insert position is valid (append if out of bounds)
            const insertPosition = Math.min(Math.max(0, op.pageIndex), totalPages);

            for (let i = 0; i < copiedPages.length; i++) {
                pdfDoc.insertPage(insertPosition + i, copiedPages[i]);
            }
        } finally {
            // Clean up temp file if created
            if (tempFilePath) {
                try {
                    await fs.unlink(tempFilePath);
                } catch (e) {
                    console.error(`Failed to delete temp file ${tempFilePath}:`, e);
                }
            }
        }
    }

    return await pdfDoc.save();
}