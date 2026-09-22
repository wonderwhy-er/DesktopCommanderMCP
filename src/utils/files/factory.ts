/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 *
 * Routing is decided by extension for the document handlers, so a path that is
 * not a spreadsheet, PDF or DOCX never loads those modules. The remaining
 * handlers are asked directly: ImageFileHandler.canHandle() is sync, and
 * BinaryFileHandler.canHandle() is async, using content-based isBinaryFile.
 */

import { FileHandler } from './base.js';
import { TextFileHandler } from './text.js';
import { ImageFileHandler } from './image.js';
import { BinaryFileHandler } from './binary.js';

// Excel, PDF and DOCX handlers are imported as TYPES only. Loading their
// modules pulls in exceljs, md-to-pdf and puppeteer, which cost real time at
// process start and are useless to a session that never opens such a file.
// They are loaded on demand below, in the async getters. A type import is
// erased at compile time and loads nothing.
import type { ExcelFileHandler } from './excel.js';
import type { PdfFileHandler } from './pdf.js';
import type { DocxFileHandler } from './docx.js';

// Routing decides by extension so it can rule a handler out without loading it.
// The handlers read the same lists, so routing and handler cannot disagree.
import { EXCEL_EXTENSIONS, PDF_EXTENSIONS, DOCX_EXTENSIONS, hasExtension } from './extensions.js';

// One instance of each handler. The on-demand ones hold a promise rather than
// an instance: it is stored before the first await, so two concurrent callers
// share one load and one instance instead of racing to build a second. A
// rejected load clears its slot again — Node retries a failed dynamic import,
// and caching the rejection would turn one transient failure into a permanent
// one for that file type.
let imageHandler: ImageFileHandler | null = null;
let textHandler: TextFileHandler | null = null;
let binaryHandler: BinaryFileHandler | null = null;
let excelHandler: Promise<ExcelFileHandler> | null = null;
let pdfHandler: Promise<PdfFileHandler> | null = null;
let docxHandler: Promise<DocxFileHandler> | null = null;

/**
 * Initialize handlers (lazy initialization)
 */
function getExcelHandler(): Promise<ExcelFileHandler> {
    if (!excelHandler) {
        excelHandler = import('./excel.js')
            .then(({ ExcelFileHandler }) => new ExcelFileHandler())
            .catch((error) => {
                excelHandler = null;
                throw error;
            });
    }
    return excelHandler;
}

function getImageHandler(): ImageFileHandler {
    if (!imageHandler) imageHandler = new ImageFileHandler();
    return imageHandler;
}

function getTextHandler(): TextFileHandler {
    if (!textHandler) textHandler = new TextFileHandler();
    return textHandler;
}

function getBinaryHandler(): BinaryFileHandler {
    if (!binaryHandler) binaryHandler = new BinaryFileHandler();
    return binaryHandler;
}

function getPdfHandler(): Promise<PdfFileHandler> {
    if (!pdfHandler) {
        pdfHandler = import('./pdf.js')
            .then(({ PdfFileHandler }) => new PdfFileHandler())
            .catch((error) => {
                pdfHandler = null;
                throw error;
            });
    }
    return pdfHandler;
}

function getDocxHandler(): Promise<DocxFileHandler> {
    if (!docxHandler) {
        docxHandler = import('./docx.js')
            .then(({ DocxFileHandler }) => new DocxFileHandler())
            .catch((error) => {
                docxHandler = null;
                throw error;
            });
    }
    return docxHandler;
}

/**
 * Get the appropriate file handler for a given file path
 *
 * Routing is decided by extension first, so a path that is not a DOCX, PDF or
 * spreadsheet never loads those handlers' modules. Only the matching handler is
 * imported, and only then.
 * BinaryFileHandler uses async isBinaryFile for content-based detection.
 *
 * Priority order:
 * 1. DOCX files (extension based)
 * 2. PDF files (extension based)
 * 3. Excel files (xlsx, xls, xlsm) - extension based
 * 4. Image files (png, jpg, gif, webp) - extension based
 * 5. Binary files - content-based detection via isBinaryFile
 * 6. Text files (default)
 *
 * @param filePath File path to get handler for
 * @returns FileHandler instance that can handle this file
 */
export async function getFileHandler(filePath: string): Promise<FileHandler> {
    // Check DOCX first (extension-based)
    if (hasExtension(filePath, DOCX_EXTENSIONS)) {
        return await getDocxHandler();
    }

    // Check PDF (extension-based)
    if (hasExtension(filePath, PDF_EXTENSIONS)) {
        return await getPdfHandler();
    }

    // Check Excel (extension-based)
    if (hasExtension(filePath, EXCEL_EXTENSIONS)) {
        return await getExcelHandler();
    }

    // Check Image (extension-based, sync - images are binary but handled specially)
    if (getImageHandler().canHandle(filePath)) {
        return getImageHandler();
    }

    // Check Binary (content-based, async via isBinaryFile)
    if (await getBinaryHandler().canHandle(filePath)) {
        return getBinaryHandler();
    }

    // Default to text handler
    return getTextHandler();
}

/**
 * Check if a file path is an Excel file
 * Extension check only: callers use this to ask a question about a filename,
 * and answering it must not load exceljs.
 * @param path File path
 * @returns true if file is Excel format
 */
export function isExcelFile(path: string): boolean {
    return hasExtension(path, EXCEL_EXTENSIONS);
}

/**
 * Check if a file path is an image file
 * Delegates to ImageFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is an image format
 */
export function isImageFile(path: string): boolean {
    return getImageHandler().canHandle(path);
}
