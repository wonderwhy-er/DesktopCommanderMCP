import { getDocumentProxy, extractImages } from 'unpdf';

export interface ImageInfo {
    /** Object ID within PDF */
    objId: number;
    width: number;
    height: number;
    /** Raw image data as base64 */
    data: string;
    /** MIME type of the image */
    mimeType: string;
    /** Original size in bytes before compression */
    originalSize?: number;
    /** Compressed size in bytes */
    compressedSize?: number;
}

export interface PageImages {
    pageNumber: number;
    images: ImageInfo[];
}

export interface ImageCompressionOptions {
    /** Output format: 'jpeg' | 'webp' */
    format?: 'jpeg' | 'webp';
    /** Quality for lossy formats (0-100, default 85) */
    quality?: number;
    /** Maximum dimension to resize to (maintains aspect ratio) */
    maxDimension?: number;
}

/**
 * Optimized image extraction from PDF using unpdf's built-in extractImages method
 * @param pdfBuffer PDF file as Uint8Array
 * @param pageNumbers Optional array of specific page numbers to process
 * @param compressionOptions Image compression settings
 * @returns Record of page numbers to extracted images
 */
export async function extractImagesFromPdf(
    pdfBuffer: Uint8Array,
    pageNumbers?: number[],
    compressionOptions: ImageCompressionOptions = {}
): Promise<Record<number, ImageInfo[]>> {
    const pdfDocument = await getDocumentProxy(pdfBuffer);

    const pagesToProcess = pageNumbers || Array.from({ length: pdfDocument.numPages }, (_, i) => i + 1);

    const pageResults: Record<number, ImageInfo[]> = {};

    try {
        // Process pages in parallel batches for better performance
        const batchSize = 5; // Process 5 pages at a time
        const batches: number[][] = [];
        for (let i = 0; i < pagesToProcess.length; i += batchSize) {
            batches.push(pagesToProcess.slice(i, i + batchSize));
        }

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];

            const batchPromises = batch.map(async (pageNum) => {
                if (pageNum < 1 || pageNum > pdfDocument.numPages) {
                    return { pageNum, images: [] };
                }

                try {
                    // Use unpdf's built-in extractImages
                    const extractedImages = await extractImages(pdfDocument, pageNum);

                    const pageImages: ImageInfo[] = [];

                    for (let index = 0; index < extractedImages.length; index++) {
                        const img = extractedImages[index];
                        const originalSize = img.data.length;

                        try {
                            const compressionResult = await convertRawImageToBase64(
                                img.data,
                                img.width,
                                img.height,
                                img.channels,
                                compressionOptions
                            );

                            if (compressionResult) {
                                pageImages.push({
                                    objId: index, // Use index as objId since unpdf doesn't provide original objId
                                    width: img.width,
                                    height: img.height,
                                    data: compressionResult.data,
                                    mimeType: compressionResult.mimeType,
                                    originalSize,
                                    compressedSize: Math.round(compressionResult.data.length * 0.75) // Approximate base64 overhead
                                });
                            }
                        } catch (err) {
                            // Ignore conversion errors as requested
                            console.warn(`Failed to convert image ${index} on page ${pageNum}:`, err instanceof Error ? err.message : String(err));
                        }
                    }

                    return { pageNum, images: pageImages };
                } catch (error) {
                    console.warn(`Failed to extract images from page ${pageNum}:`, error instanceof Error ? error.message : String(error));
                    return { pageNum, images: [] };
                }
            });

            // Wait for the current batch to complete
            const batchResults = await Promise.all(batchPromises);

            // Store results
            for (const { pageNum, images } of batchResults) {
                pageResults[pageNum] = images;
            }
        }
    } finally {
        // Clean up document
        try {
            if (typeof pdfDocument.cleanup === 'function') {
                await pdfDocument.cleanup(false);
            }
        } catch (e) { /* Ignore cleanup errors */ }
        try {
            if (typeof pdfDocument.destroy === 'function') {
                await pdfDocument.destroy();
            }
        } catch (e) { /* Ignore cleanup errors */ }
    }

    return pageResults;
}

/**
 * Convert raw image data to compressed base64 using sharp
 */
async function convertRawImageToBase64(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    channels: number,
    options: ImageCompressionOptions = {}
): Promise<{ data: string; mimeType: string } | null> {
    const {
        format = 'webp',
        quality = 85,
        maxDimension = 1200
    } = options;

    // Smart resizing - only resize large images
    let targetWidth = width;
    let targetHeight = height;

    if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        targetWidth = Math.round(width * scale);
        targetHeight = Math.round(height * scale);
    }

    try {
        // Try to dynamically import sharp
        const sharp = (await import('sharp')).default;

        // sharp takes Buffer, Uint8Array, etc.
        // unpdf returns Uint8ClampedArray, which works with Buffer.from()
        let pipeline = sharp(Buffer.from(data), {
            raw: {
                width,
                height,
                channels: channels as 1 | 2 | 3 | 4
            }
        });

        if (targetWidth !== width || targetHeight !== height) {
            pipeline = pipeline.resize(targetWidth, targetHeight);
        }

        let outputBuffer: Buffer;
        let mimeType: string;

        if (format === 'jpeg') {
            outputBuffer = await pipeline.jpeg({ quality }).toBuffer();
            mimeType = 'image/jpeg';
        } else {
            // Default to webp
            outputBuffer = await pipeline.webp({ quality }).toBuffer();
            mimeType = 'image/webp';
        }

        return {
            data: outputBuffer.toString('base64'),
            mimeType
        };
    } catch (error) {
        console.warn('Image conversion failed (likely missing sharp or invalid data):', error instanceof Error ? error.message : String(error));
        return null;
    }
}