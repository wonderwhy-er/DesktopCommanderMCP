/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 */

import { FileHandler } from './base.js';
import { TextFileHandler } from './text.js';
import { ImageFileHandler } from './image.js';
import { BinaryFileHandler } from './binary.js';
import { EXCEL_EXTENSIONS, PDF_EXTENSIONS, DOCX_EXTENSIONS, hasExtension } from './extensions.js';

/**
 * Concurrent callers share one load and the single instance it produces.
 *
 * A rejected load is forgotten rather than kept: Node retries a failed dynamic
 * import, so remembering the rejection would turn one transient failure into a
 * permanent one for that file type.
 */
function shareOneLoad<T>(load: () => Promise<T>): () => Promise<T> {
    let shared: Promise<T> | null = null;
    return () => {
        if (!shared) {
            shared = load().catch((error) => {
                shared = null;
                throw error;
            });
        }
        return shared;
    };
}

// exceljs, md-to-pdf and puppeteer cost real time at process start and are of
// no use to a session that never opens such a file.
const getExcelHandler = shareOneLoad(async () => {
    const { ExcelFileHandler } = await import('./excel.js');
    return new ExcelFileHandler();
});

const getPdfHandler = shareOneLoad(async () => {
    const { PdfFileHandler } = await import('./pdf.js');
    return new PdfFileHandler();
});

const getDocxHandler = shareOneLoad(async () => {
    const { DocxFileHandler } = await import('./docx.js');
    return new DocxFileHandler();
});

const DOCUMENT_HANDLERS = [
    { extensions: DOCX_EXTENSIONS, get: getDocxHandler },
    { extensions: PDF_EXTENSIONS, get: getPdfHandler },
    { extensions: EXCEL_EXTENSIONS, get: getExcelHandler },
];

let imageHandler: ImageFileHandler | null = null;
let textHandler: TextFileHandler | null = null;
let binaryHandler: BinaryFileHandler | null = null;

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

/**
 * Get the appropriate file handler for a given file path
 *
 * Document types are matched by extension, which is what lets every other path
 * skip loading their modules. Binary detection reads the file, so it comes
 * last, before the text default.
 *
 * @param filePath File path to get handler for
 * @returns FileHandler instance that can handle this file
 */
export async function getFileHandler(filePath: string): Promise<FileHandler> {
    const document = DOCUMENT_HANDLERS.find(({ extensions }) => hasExtension(filePath, extensions));
    if (document) {
        return document.get();
    }

    if (getImageHandler().canHandle(filePath)) {
        return getImageHandler();
    }

    if (await getBinaryHandler().canHandle(filePath)) {
        return getBinaryHandler();
    }

    return getTextHandler();
}

/**
 * Check if a file path is an Excel file
 * @param path File path
 * @returns true if file is Excel format
 */
export function isExcelFile(path: string): boolean {
    return hasExtension(path, EXCEL_EXTENSIONS);
}

/**
 * Check if a file path is an image file
 * @param path File path
 * @returns true if file is an image format
 */
export function isImageFile(path: string): boolean {
    return getImageHandler().canHandle(path);
}
