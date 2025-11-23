import { createRequire } from 'module';
import { PNG } from 'pngjs';

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

export interface Pdf2MdResult {
    text: string;
    metadata: PdfMetadata;
    images: ImageInfo[];
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
 * Extracts images from a PDF document.
 * @param pdfDocument The PDF document to extract images from.
 * @returns An array of ImageInfo objects containing the extracted images.
 */
async function extractImages({ pdfDocument }: ParseResult) {
    const images: ImageInfo[] = [];
    if (pdfDocument) {
        try {
            const numPages = pdfDocument.numPages;
            for (let i = 1; i <= numPages; i++) {
                const page = await pdfDocument.getPage(i);
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
                            const pngBuffer = pdfImageObjToPng(imgObj);


                            images.push({
                                objId,
                                width: imgObj.width,
                                height: imgObj.height,
                                data: pngBuffer.toString('base64'),
                                mimeType: 'image/png',
                                page: i
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Image extraction failed:', e);
        }

    }

    return images

}

/**
 * Reads a PDF and converts it to Markdown, returning structured data.
 */
export async function pdf2md(pdfBuffer: Uint8Array): Promise<Pdf2MdResult> {
    const result = await parse(pdfBuffer);
    const { fonts, pages, pdfDocument } = result;
    const transformations = makeTransformations(fonts.map);
    const parseResult = transform(pages, transformations);
    const text = parseResult.pages
        .map((page: any) => page.items.join('\n') + '\n')
        .join('');



    const images = await extractImages(result);
    const metadata = extractMetadata(result);

    try {
        return { text, metadata, images };
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
