import { createRequire } from 'module';

import { generatePageNumbers } from '../utils.js';
import { extractImagesFromPdf, ImageInfo } from '../extract-images.js';
const require = createRequire(import.meta.url);

/** What @opendocsg/pdf2md's parse() returns: its modules are loaded untyped, with require() */
type ParseResult = any;


/**
 * PDF metadata structure
 */
export interface PdfMetadata {
    fileSize?: number;
    totalPages: number;
    title?: string;
    author?: string;
    creator?: string;
    producer?: string;
    version?: string;
    creationDate?: string;
    modificationDate?: string;
    isEncrypted?: boolean;
}

export interface PdfPageItem {
    text: string;
    images: ImageInfo[];
    pageNumber: number;
}

export interface PdfParseResult {
    pages: PdfPageItem[];
    metadata: PdfMetadata;
}


/**
 * Extracts metadata from a PDF document.
 * @param pdfDocument The PDF document to extract metadata from.
 * @returns A PdfMetadata object containing the extracted metadata.
 */
const extractMetadata = ({ pdfDocument, metadata }: ParseResult): PdfMetadata => ({
    totalPages: pdfDocument.numPages,
    title: metadata.Title,
    author: metadata.Author,
    creator: metadata.Creator,
    producer: metadata.Producer,
    version: metadata.PDFFormatVersion,
    creationDate: metadata.CreationDate,
    modificationDate: metadata.ModDate,
    isEncrypted: metadata.IsEncrypted,
});


export type PageRange = {
    offset: number;
    length: number;
};

/**
 * Reads a PDF and converts it to Markdown, returning structured data.
 * @param pdfBuffer The PDF buffer to convert.
 * @param pageNumbers The page numbers to extract. If an empty array, all pages are extracted;
 * a range that selects no pages (offset past the last page, length 0) extracts none.
 * @returns A Promise that resolves to a PdfParseResult object containing the parsed data.
 */
export async function pdf2md(pdfBuffer: Uint8Array, pageNumbers: number[] | PageRange = []): Promise<PdfParseResult> {
    // @opendocsg/pdf2md is loaded here, on first use, not with this module: the
    // server loads the PDF tools at startup, and most sessions never read a PDF (#715)
    const { parse } = require('@opendocsg/pdf2md/lib/util/pdf');
    const { makeTransformations, transform } = require('@opendocsg/pdf2md/lib/util/transformations');

    const result = await parse(pdfBuffer);
    const { fonts, pages, pdfDocument } = result;

    // Calculate which pages to process
    const allPages = Array.isArray(pageNumbers) && pageNumbers.length === 0;
    const filterPageNumbers = Array.isArray(pageNumbers) ?
        pageNumbers :
        generatePageNumbers(pageNumbers.offset, pageNumbers.length, pages.length);

    // Filter and transform pages
    const pagesToProcess = allPages ?
        pages :
        pages.filter((_: any, index: number) => filterPageNumbers.includes(index + 1));

    const pageNumberMap = allPages ?
        pages.map((_: any, index: number) => index + 1) :
        filterPageNumbers.filter(pageNum => pageNum >= 1 && pageNum <= pages.length);

    const transformations = makeTransformations(fonts.map);
    const parseResult = transform(pagesToProcess, transformations);

    // Extract images
    const imagesByPage = await extractImagesFromPdf(pdfBuffer, pageNumberMap, { format: 'webp', quality: 85 });

    // Create pages without images for now
    const processedPages: PdfPageItem[] = parseResult.pages.map((page: any, index: number) => {
        const pageNumber = pageNumberMap[index];
        return {
            pageNumber,
            text: page.items.join('\n') + '\n',
            images: imagesByPage[pageNumber] || [],
        };
    });

    const metadata = extractMetadata(result);

    try {
        return { pages: processedPages, metadata };
    } finally {
        if (pdfDocument) {
            try {
                if (typeof pdfDocument.cleanup === 'function') {
                    await pdfDocument.cleanup(false);
                }
            } catch (e) { }
            try {
                if (typeof pdfDocument.destroy === 'function') {
                    await pdfDocument.destroy();
                }
            } catch (e) { }
        }
    }
}