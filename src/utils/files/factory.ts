/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 *
 * Each handler implements canHandle() which can be sync (extension-based)
 * or async (content-based like BinaryFileHandler using isBinaryFile)
 */

import path from 'path';
import { FileHandler } from './base.js';
import { TextFileHandler } from './text.js';
import { ImageFileHandler } from './image.js';
import { BinaryFileHandler } from './binary.js';
import { ExcelFileHandler, exceljsPackage } from './excel.js';
import { PdfFileHandler } from './pdf.js';
import { DocxFileHandler, pizzipPackage } from './docx.js';
import { pdfLibPackage } from '../../tools/pdf/manipulations.js';
import { pdf2mdPackage } from '../../tools/pdf/lib/pdf2md.js';
import { unpdfPackage } from '../../tools/pdf/extract-images.js';
import { mdToPdfPackage } from '../../tools/pdf/markdown.js';
import type { LazyPackage } from '../lazy-package.js';

// Singleton instances of each handler
let excelHandler: ExcelFileHandler | null = null;
let imageHandler: ImageFileHandler | null = null;
let textHandler: TextFileHandler | null = null;
let binaryHandler: BinaryFileHandler | null = null;
let pdfHandler: PdfFileHandler | null = null;
let docxHandler: DocxFileHandler | null = null;

/**
 * Initialize handlers (lazy initialization)
 */
function getExcelHandler(): ExcelFileHandler {
    if (!excelHandler) excelHandler = new ExcelFileHandler();
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

function getPdfHandler(): PdfFileHandler {
    if (!pdfHandler) pdfHandler = new PdfFileHandler();
    return pdfHandler;
}

function getDocxHandler(): DocxFileHandler {
    if (!docxHandler) docxHandler = new DocxFileHandler();
    return docxHandler;
}

/**
 * Get the appropriate file handler for a given file path
 *
 * Each handler's canHandle() determines if it can process the file.
 * Extension-based handlers (Excel, Image) return sync boolean.
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
 * @param options svgAsImage: an SVG goes to the image handler, for the file preview widget
 * @returns FileHandler instance that can handle this file
 */
export async function getFileHandler(filePath: string, options?: { svgAsImage?: boolean }): Promise<FileHandler> {
    // Check DOCX first (extension-based, sync)
    if (getDocxHandler().canHandle(filePath)) {
        return getDocxHandler();
    }

    // Check PDF (extension-based, sync)
    if (getPdfHandler().canHandle(filePath)) {
        return getPdfHandler();
    }

    // Check Excel (extension-based, sync)
    if (getExcelHandler().canHandle(filePath)) {
        return getExcelHandler();
    }

    // Check Image (extension-based, sync - images are binary but handled specially)
    if (getImageHandler().canHandle(filePath, options)) {
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
 * Delegates to ExcelFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is Excel format
 */
export function isExcelFile(path: string): boolean {
    return getExcelHandler().canHandle(path);
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

export type FileAction = 'read' | 'write' | 'edit';

/**
 * Right after initialize (#777): the packages Excel, DOCX and PDF files need,
 * loaded in the background one at a time, smaller first, so each pause of the
 * main thread is one package.
 */
export function preloadFileSupport(): void {
    void (async () => {
        for (const pkg of [pizzipPackage, pdfLibPackage, pdf2mdPackage, unpdfPackage, exceljsPackage, mdToPdfPackage]) {
            await pkg.preload();
        }
    })();
}

/** The packages a file needs for `action`, by the handlers' canHandle() (its name, no disk access) */
function packagesFor(filePath: string, action: FileAction, isPdf: boolean, isUrl: boolean): LazyPackage<unknown>[] {
    if (isPdf) {
        // Editing a PDF can insert markdown pages, which are rendered
        return action === 'read' ? [pdf2mdPackage, unpdfPackage] : action === 'write' ? [mdToPdfPackage] : [pdfLibPackage, mdToPdfPackage];
    }
    // A URL is fetched, not opened by a file handler: only a PDF one is parsed
    if (isUrl) return [];
    if (getDocxHandler().canHandle(filePath)) return [pizzipPackage];
    if (getExcelHandler().canHandle(filePath)) return [exceljsPackage];
    return [];
}

/**
 * The answer for a tool call that would `action` `filePath` while a package it
 * needs is still loading, naming the file; undefined once loaded. A package
 * not preloading yet (before initialize, or after a failure) starts here,
 * after the call has answered. `isPdf` for a PDF whatever its name (write_pdf),
 * `isUrl` for a URL read.
 */
export function stillLoadingError(
    filePath: string,
    action: FileAction,
    { isPdf = getPdfHandler().canHandle(filePath), isUrl = false }: { isPdf?: boolean; isUrl?: boolean } = {}
): string | undefined {
    const pending = packagesFor(filePath, action, isPdf, isUrl).find((pkg) => !pkg.loaded);
    if (!pending) return undefined;
    const file = path.basename(filePath);
    const { error, needsRestart, support } = pending;
    if (!needsRestart) void pending.preload();
    if (!error) {
        return `Can't ${action} ${file} yet: Desktop Commander is still loading its ${support} (it starts right after launch). Try again in a few seconds.`;
    }
    return needsRestart
        ? `Can't ${action} ${file}: Desktop Commander couldn't load its ${support} (${error}). Restart Desktop Commander to load it again.`
        : `Can't ${action} ${file}: Desktop Commander couldn't load its ${support} (${error}). It's loading it again; try again in a few seconds.`;
}
