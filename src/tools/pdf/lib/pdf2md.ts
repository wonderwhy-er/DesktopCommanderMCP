import { createRequire } from 'module';
import { PNG } from 'pngjs';
import { generatePageNumbers } from '../utils.js';

const require = createRequire(import.meta.url);

const { parse } = require('@opendocsg/pdf2md/lib/util/pdf');
const { makeTransformations, transform } = require('@opendocsg/pdf2md/lib/util/transformations');

type ParseResult = ReturnType<typeof parse>;


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

/** Image information extracted from PDF */
export interface ImageInfo {
    /** Object ID within PDF */
    objId: number;

    width: number;
    height: number;

    /** Raw image data (Uint8Array) */
    data: string;

    /** MIME type of the image */
    mimeType: string;

    /** Page number of image */
    page: number;
}


/**
 * Converts a PDF image object to a PNG buffer.
 * @param imgObj The PDF image object to convert.
 * @returns A Buffer containing the PNG image data.
 */
function pdfImageObjToPng(imgObj: any): Buffer {
    const { width, height, data, kind } = imgObj;

    const png = new PNG({
        width,
        height,
        colorType: kind === 1 ? 0 : 2, // 0=grayscale, 2=RGB/RGBA
        inputColorType: kind === 1 ? 0 : 2,
        inputHasAlpha: kind === 3,
    });

    if (kind === 3) {
        // Already RGBA → direct copy
        png.data = Buffer.from(data);
    }
    else if (kind === 2) {
        // RGB → must expand to RGBA
        png.data = Buffer.alloc(width * height * 4);
        for (let i = 0, j = 0; i < data.length;) {
            png.data[j++] = data[i++]; // R
            png.data[j++] = data[i++]; // G
            png.data[j++] = data[i++]; // B
            png.data[j++] = 255;       // A
        }
    }
    else if (kind === 1) {
        // Grayscale 1 byte per pixel → need to convert to RGBA
        png.data = Buffer.alloc(width * height * 4);
        for (let i = 0, j = 0; i < data.length; i++) {
            const g = data[i];
            png.data[j++] = g;  // R
            png.data[j++] = g;  // G
            png.data[j++] = g;  // B
            png.data[j++] = 255; // A
        }
    }
    else {
        throw new Error(`Unsupported PDF.js image kind: ${kind}`);
    }

    return PNG.sync.write(png);
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

/**
 * Extracts images from a specific PDF page.
 * @param page The PDF page object.
 * @param pageNum The page number (1-based).
 * @returns An array of ImageInfo objects containing the extracted images.
 */
async function extractImages(page: any, pageNum: number): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    try {
        const ops = await page.getOperatorList();
        const paintImageOp = 85; // OPS.paintImageXObject
        for (let j = 0; j < ops.fnArray.length; j++) {
            if (ops.fnArray[j] === paintImageOp) {
                const args = ops.argsArray[j];
                const objId = args[0];
                // Retrieve image object via page.objs.get
                const imgObj: any = await new Promise((resolve, reject) => {
                    if (page.objs && typeof page.objs.get === 'function') {
                        page.objs.get(objId, (img: any) => {
                            if (img) resolve(img);
                            else reject(new Error('Image object not found'));
                        });
                    } else {
                        reject(new Error('page.objs.get not available'));
                    }
                });
                if (imgObj && imgObj.data) {
                    images.push({
                        objId,
                        width: imgObj.width,
                        height: imgObj.height,
                        data: pdfImageObjToPng(imgObj).toString('base64'),
                        mimeType: 'image/png',
                        page: pageNum
                    });
                }
            }
        }
    } catch (e) {
        console.warn(`Image extraction failed for page ${pageNum}:`, e);
    }
    return images;
}

export type PageRange = {
    offset: number;
    length: number;
};

/**
 * Reads a PDF and converts it to Markdown, returning structured data.
 * @param pdfBuffer The PDF buffer to convert.
 * @param pageNumbers The page numbers to extract. If empty, all pages are extracted.
 * @returns A Promise that resolves to a PdfParseResult object containing the parsed data.
 */
export async function pdf2md(pdfBuffer: Uint8Array, pageNumbers: number[] | PageRange = []): Promise<PdfParseResult> {
    const result = await parse(pdfBuffer);
    const { fonts, pages, pdfDocument } = result;
    const transformations = makeTransformations(fonts.map);
    const parseResult = transform(pages, transformations);

    const filterPageNumbers = Array.isArray(pageNumbers) ?
        pageNumbers :
        generatePageNumbers(pageNumbers.offset, pageNumbers.length, parseResult.pages.length);

    const pagesWithIndex = parseResult.pages.map((page: any, index: number) => ({
        page,
        pageNumber: index + 1
    }));

    const filteredPages = pagesWithIndex.filter((item: { page: any, pageNumber: number }) => {
        return filterPageNumbers.length === 0 || filterPageNumbers.includes(item.pageNumber);
    });

    // Process pages and extract images per page
    const processedPages: PdfPageItem[] = await Promise.all(filteredPages.map(async (item: { page: any, pageNumber: number }) => {
        const { page, pageNumber } = item;

        // Get the raw page object from pdfDocument to pass to extractImages
        // Note: pdfDocument.getPage is 1-based
        let rawPage = null;
        if (pdfDocument) {
            try {
                rawPage = await pdfDocument.getPage(pageNumber);
            } catch (e) {
                console.warn(`Could not get raw page ${pageNumber} for image extraction`, e);
            }
        }

        const images = rawPage ? await extractImages(rawPage, pageNumber) : [];

        return {
            pageNumber,
            text: page.items.join('\n') + '\n',
            images: images
        };
    }));

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
