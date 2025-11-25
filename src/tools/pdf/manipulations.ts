import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { normalizePageIndexes } from './utils.js';
import { parseMarkdownToPdf } from './markdown.js';
import type { PdfInsertOperationSchema, PdfDeleteOperationSchema, PdfOperationSchema } from '../schemas.js';
import { z } from 'zod';

// Infer TypeScript types from Zod schemas for consistency
type PdfInsertOperation = z.infer<typeof PdfInsertOperationSchema>;
type PdfDeleteOperation = z.infer<typeof PdfDeleteOperationSchema>;
type PdfOperations = z.infer<typeof PdfOperationSchema>;

export type { PdfOperations, PdfInsertOperation, PdfDeleteOperation };

async function loadPdfDocumentFromBuffer(filePathOrBuffer: string | Buffer | Uint8Array): Promise<PDFDocument> {
    const buffer = typeof filePathOrBuffer === 'string' ? await fs.readFile(filePathOrBuffer) : filePathOrBuffer;
    const pdfBytes = new Uint8Array(buffer);
    return await PDFDocument.load(pdfBytes);
}

/**
 * Delete pages from a PDF document
 * @param pdfDoc PDF document to delete pages from
 * @param pageIndexes Page indices to delete, negative indices are from end
 */
function deletePages(pdfDoc: PDFDocument, pageIndexes: number[]): PDFDocument {
    const pageCount = pdfDoc.getPageCount();

    // Transform negative indices to absolute and filter valid ones
    const normalizedIndexes = normalizePageIndexes(pageIndexes, pageCount).sort((a, b) => b - a);

    for (const pageIndex of normalizedIndexes) {
        pdfDoc.removePage(pageIndex);
    }

    return pdfDoc;
}

async function insertPages(destPdfDocument: PDFDocument, pageIndex: number, sourcePdfDocument: PDFDocument): Promise<PDFDocument> {
    let insertPosition = pageIndex < 0 ? destPdfDocument.getPageCount() + pageIndex : pageIndex;

    if (insertPosition < 0 || insertPosition > destPdfDocument.getPageCount()) {
        throw new Error('Invalid page index');
    }

    const copiedPages = await destPdfDocument.copyPages(sourcePdfDocument, sourcePdfDocument.getPageIndices());

    for (let i = 0; i < copiedPages.length; i++) {
        destPdfDocument.insertPage(insertPosition + i, copiedPages[i]);
    }

    return destPdfDocument;
}

/**
 * Edit an existing PDF by deleting or inserting pages
 * @param pdfPath Path to the PDF file to edit
 * @param operations List of operations to perform
 * @returns The modified PDF as a Uint8Array
 */
export async function editPdf(
    pdfPath: string,
    operations: PdfOperations[]
): Promise<Uint8Array> {
    const pdfDoc = await loadPdfDocumentFromBuffer(pdfPath);
    for (const op of operations) {
        if (op.type === 'delete') {
            deletePages(pdfDoc, op.pageIndexes);
        }
        else if (op.type == 'insert') {
            let sourcePdfDocument: PDFDocument;
            if (op.markdown) {
                const pdfBuffer = await parseMarkdownToPdf(op.markdown);
                sourcePdfDocument = await loadPdfDocumentFromBuffer(pdfBuffer);
            } else if (op.sourcePdfPath) {
                sourcePdfDocument = await loadPdfDocumentFromBuffer(op.sourcePdfPath);
            }
            else {
                throw new Error('No source provided for insert operation');
            }

            await insertPages(pdfDoc, op.pageIndex, sourcePdfDocument);
        }
    }

    return await pdfDoc.save();
}