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
    /** Output format: 'png' | 'jpeg' | 'webp' */
    format?: 'png' | 'jpeg' | 'webp';
    /** Quality for lossy formats (0-100, default 85) */
    quality?: number;
    /** PNG compression level (0-9, default 6) */
    compressionLevel?: number;
    /** Maximum dimension to resize to (maintains aspect ratio) */
    maxDimension?: number;
}

/**
 * Optimized image extraction from PDF using unpdf's built-in extractImages method
 * Much faster and more reliable than manual image object retrieval
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

                    const pageImages: ImageInfo[] = await Promise.all(
                        extractedImages.map(async (img, index) => {
                            const originalSize = img.data.length;
                            const compressionResult = await convertRawImageToBase64(
                                img.data,
                                img.width,
                                img.height,
                                img.channels,
                                compressionOptions
                            );

                            return {
                                objId: index, // Use index as objId since unpdf doesn't provide original objId
                                width: img.width,
                                height: img.height,
                                data: compressionResult.data,
                                mimeType: compressionResult.mimeType,
                                originalSize,
                                compressedSize: Math.round(compressionResult.data.length * 0.75) // Approximate base64 overhead
                            };
                        })
                    );

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
 * Convert raw image data to compressed base64 with smart compression
 * Only compresses when it actually reduces size
 * @param data Raw image data as Uint8ClampedArray
 * @param width Image width
 * @param height Image height  
 * @param channels Number of color channels (1=grayscale, 3=RGB, 4=RGBA)
 * @param options Compression options
 */
async function convertRawImageToBase64(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    channels: number,
    options: ImageCompressionOptions = {}
): Promise<{ data: string; mimeType: string }> {
    const {
        format = 'png',
        quality = 85,
        compressionLevel = 6,
        maxDimension = 1200
    } = options;

    const originalDataSize = data.length;
    const imagePixels = width * height;


    // For very small images, skip complex processing and use simple PNG
    if (imagePixels < 10000 || originalDataSize < 50000) { // Less than 100x100 or 50KB
        return await convertToSimplePNG(data, width, height, channels);
    }

    // Smart resizing - only resize large images
    let targetWidth = width;
    let targetHeight = height;
    let shouldResize = false;

    if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        targetWidth = Math.round(width * scale);
        targetHeight = Math.round(height * scale);
        shouldResize = true;
    }

    // Convert to RGBA format if needed
    let rgbaData: Uint8ClampedArray;
    if (channels === 4) {
        rgbaData = data;
    } else {
        rgbaData = new Uint8ClampedArray(width * height * 4);
        if (channels === 3) {
            // RGB → RGBA
            for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
                rgbaData[j] = data[i];     // R
                rgbaData[j + 1] = data[i + 1]; // G
                rgbaData[j + 2] = data[i + 2]; // B
                rgbaData[j + 3] = 255;     // A
            }
        } else if (channels === 1) {
            // Grayscale → RGBA
            for (let i = 0, j = 0; i < data.length; i++, j += 4) {
                const gray = data[i];
                rgbaData[j] = gray;     // R
                rgbaData[j + 1] = gray; // G
                rgbaData[j + 2] = gray; // B
                rgbaData[j + 3] = 255;  // A
            }
        } else {
            throw new Error(`Unsupported channel count: ${channels}`);
        }
    }

    // Resize if needed using nearest neighbor (for speed)
    if (shouldResize) {
        const resizedData = new Uint8ClampedArray(targetWidth * targetHeight * 4);
        const scaleX = width / targetWidth;
        const scaleY = height / targetHeight;

        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const srcX = Math.floor(x * scaleX);
                const srcY = Math.floor(y * scaleY);
                const srcIndex = (srcY * width + srcX) * 4;
                const destIndex = (y * targetWidth + x) * 4;

                resizedData[destIndex] = rgbaData[srcIndex];
                resizedData[destIndex + 1] = rgbaData[srcIndex + 1];
                resizedData[destIndex + 2] = rgbaData[srcIndex + 2];
                resizedData[destIndex + 3] = rgbaData[srcIndex + 3];
            }
        }
        rgbaData = resizedData;
        width = targetWidth;
        height = targetHeight;
    }

    // Try compression and compare with original
    const compressedResult = await convertToOptimizedPNG(rgbaData, width, height, compressionLevel, originalDataSize);

    if (format === 'jpeg') {
        return await convertToJPEG(rgbaData, width, height, quality);
    } else if (format === 'webp') {
        return await convertToWebP(rgbaData, width, height, quality);
    } else {
        return compressedResult;
    }
}

/**
 * Simple PNG conversion for small images without complex optimization
 */
async function convertToSimplePNG(data: Uint8ClampedArray, width: number, height: number, channels: number): Promise<{ data: string; mimeType: string }> {
    const { PNG } = await import('pngjs');

    const png = new PNG({
        width,
        height,
        colorType: channels === 1 ? 0 : (channels === 3 ? 2 : 6), // Auto-detect format
        deflateLevel: 1 // Light compression for speed
    });

    // Use original data directly if possible
    if (channels === 4) {
        png.data = Buffer.from(data);
    } else if (channels === 3) {
        // RGB to RGBA quickly
        const rgbaData = new Uint8ClampedArray(width * height * 4);
        for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
            rgbaData[j] = data[i];
            rgbaData[j + 1] = data[i + 1];
            rgbaData[j + 2] = data[i + 2];
            rgbaData[j + 3] = 255;
        }
        png.data = Buffer.from(rgbaData);
    } else {
        png.data = Buffer.from(data);
    }

    const pngBuffer = PNG.sync.write(png);

    return {
        data: pngBuffer.toString('base64'),
        mimeType: 'image/png'
    };
}

/**
 * Optimized PNG conversion with size comparison
 */
async function convertToOptimizedPNG(rgbaData: Uint8ClampedArray, width: number, height: number, compressionLevel: number, originalSize: number): Promise<{ data: string; mimeType: string }> {
    const { PNG } = await import('pngjs');

    // Try basic PNG first
    const basicPng = new PNG({
        width,
        height,
        colorType: 6, // RGBA
        deflateLevel: 1 // Light compression
    });
    basicPng.data = Buffer.from(rgbaData);
    const basicBuffer = PNG.sync.write(basicPng);
    const basicBase64 = basicBuffer.toString('base64');
    const basicSize = Math.round(basicBase64.length * 0.75); // Approximate binary size

    // If basic compression is already good, use it
    if (basicSize < originalSize * 0.8) {
        return {
            data: basicBase64,
            mimeType: 'image/png'
        };
    }

    // Try optimized compression
    const { isGrayscale, hasTransparency, optimizedData } = optimizeImageData(rgbaData, width, height);

    let colorType = 6; // Default RGBA
    if (isGrayscale && !hasTransparency) colorType = 0; // Grayscale
    else if (isGrayscale && hasTransparency) colorType = 4; // Grayscale + alpha
    else if (!hasTransparency) colorType = 2; // RGB

    const optimizedPng = new PNG({
        width,
        height,
        colorType: colorType as any,
        deflateLevel: Math.min(9, compressionLevel + 2), // Higher compression
        deflateStrategy: 1 as any
    });

    optimizedPng.data = Buffer.from(optimizedData);
    const optimizedBuffer = PNG.sync.write(optimizedPng);
    const optimizedBase64 = optimizedBuffer.toString('base64');
    const optimizedSize = Math.round(optimizedBase64.length * 0.75);

    // Use whichever is smaller
    if (optimizedSize < basicSize && optimizedSize < originalSize * 0.9) {
        return {
            data: optimizedBase64,
            mimeType: 'image/png'
        };
    } else {
        return {
            data: basicBase64,
            mimeType: 'image/png'
        };
    }
}

/**
 * Legacy function - kept for compatibility
 */
async function convertToPNG(rgbaData: Uint8ClampedArray, width: number, height: number, compressionLevel: number): Promise<{ data: string; mimeType: string }> {
    const { PNG } = await import('pngjs');

    // Detect if image is grayscale or has transparency to optimize format
    const { isGrayscale, hasTransparency, optimizedData } = optimizeImageData(rgbaData, width, height);

    let colorType = 2; // Default RGB with alpha
    let channels = 4;
    let outputData = rgbaData;

    if (isGrayscale && !hasTransparency) {
        colorType = 0; // Grayscale
        channels = 1;
        outputData = optimizedData;
    } else if (isGrayscale && hasTransparency) {
        colorType = 4; // Grayscale with alpha
        channels = 2;
        outputData = optimizedData;
    } else if (!hasTransparency) {
        colorType = 2; // RGB without alpha
        channels = 3;
        outputData = optimizedData;
    }

    const png = new PNG({
        width,
        height,
        colorType: colorType as any,
        deflateLevel: Math.max(6, compressionLevel), // Ensure good compression
        deflateStrategy: 1 as any, // Use filtered strategy for better compression
        inputColorType: colorType as any,
        inputHasAlpha: hasTransparency
    });

    png.data = Buffer.from(outputData);
    const pngBuffer = PNG.sync.write(png);

    return {
        data: pngBuffer.toString('base64'),
        mimeType: 'image/png'
    };
}

/**
 * Optimize image data by detecting format and removing unnecessary channels
 */
function optimizeImageData(rgbaData: Uint8ClampedArray, width: number, height: number): {
    isGrayscale: boolean;
    hasTransparency: boolean;
    optimizedData: Uint8ClampedArray;
} {
    let isGrayscale = true;
    let hasTransparency = false;

    // Analyze image properties
    for (let i = 0; i < rgbaData.length; i += 4) {
        const r = rgbaData[i];
        const g = rgbaData[i + 1];
        const b = rgbaData[i + 2];
        const a = rgbaData[i + 3];

        // Check if grayscale (R = G = B)
        if (r !== g || g !== b) {
            isGrayscale = false;
        }

        // Check for transparency
        if (a < 255) {
            hasTransparency = true;
        }

        // Early exit if we know it's color with alpha
        if (!isGrayscale && hasTransparency) {
            break;
        }
    }

    // Create optimized data based on detected format
    let optimizedData: Uint8ClampedArray;

    if (isGrayscale && !hasTransparency) {
        // Convert to grayscale (1 channel)
        optimizedData = new Uint8ClampedArray(width * height);
        for (let i = 0, j = 0; i < rgbaData.length; i += 4, j++) {
            optimizedData[j] = rgbaData[i]; // Use red channel as grayscale value
        }
    } else if (isGrayscale && hasTransparency) {
        // Convert to grayscale + alpha (2 channels)
        optimizedData = new Uint8ClampedArray(width * height * 2);
        for (let i = 0, j = 0; i < rgbaData.length; i += 4, j += 2) {
            optimizedData[j] = rgbaData[i];     // Gray value
            optimizedData[j + 1] = rgbaData[i + 3]; // Alpha
        }
    } else if (!hasTransparency) {
        // Convert to RGB (3 channels)
        optimizedData = new Uint8ClampedArray(width * height * 3);
        for (let i = 0, j = 0; i < rgbaData.length; i += 4, j += 3) {
            optimizedData[j] = rgbaData[i];     // R
            optimizedData[j + 1] = rgbaData[i + 1]; // G
            optimizedData[j + 2] = rgbaData[i + 2]; // B
        }
    } else {
        // Keep RGBA (4 channels)
        optimizedData = rgbaData;
    }

    return { isGrayscale, hasTransparency, optimizedData };
}

/**
 * Convert RGBA data to JPEG (removes alpha channel)
 */
async function convertToJPEG(rgbaData: Uint8ClampedArray, width: number, height: number, quality: number): Promise<{ data: string; mimeType: string }> {
    try {
        // Try to dynamically import sharp
        const sharpModule = await eval('import("sharp")') as any;
        const sharp = sharpModule.default;

        const jpegBuffer = await sharp(Buffer.from(rgbaData), {
            raw: {
                width,
                height,
                channels: 4
            }
        })
            .jpeg({ quality })
            .toBuffer();

        return {
            data: jpegBuffer.toString('base64'),
            mimeType: 'image/jpeg'
        };
    } catch (error) {
        // Fallback to canvas-based conversion if sharp is not available
        return await convertToJPEGFallback(rgbaData, width, height, quality);
    }
}

/**
 * Fallback JPEG conversion using canvas (for environments without sharp)
 */
async function convertToJPEGFallback(rgbaData: Uint8ClampedArray, width: number, height: number, quality: number): Promise<{ data: string; mimeType: string }> {
    // This would require a canvas implementation - for now, fallback to PNG
    console.warn('JPEG conversion requires sharp package - falling back to PNG');
    return await convertToPNG(rgbaData, width, height, 6);
}

/**
 * Convert RGBA data to WebP (if supported)
 */
async function convertToWebP(rgbaData: Uint8ClampedArray, width: number, height: number, quality: number): Promise<{ data: string; mimeType: string }> {
    try {
        // Try to dynamically import sharp
        const sharpModule = await eval('import("sharp")') as any;
        const sharp = sharpModule.default;

        const webpBuffer = await sharp(Buffer.from(rgbaData), {
            raw: {
                width,
                height,
                channels: 4
            }
        })
            .webp({ quality })
            .toBuffer();

        return {
            data: webpBuffer.toString('base64'),
            mimeType: 'image/webp'
        };
    } catch (error) {
        // Fallback to JPEG if WebP is not supported
        console.warn('WebP conversion requires sharp package - falling back to JPEG');
        return await convertToJPEG(rgbaData, width, height, quality);
    }
}