/**
 * Image file handler
 * Handles reading image files and converting to base64
 */

import fs from "fs/promises";
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo
} from './base.js';

const SVG_MIME_TYPE = 'image/svg+xml';

/**
 * Whether content of this MIME type is answered as an image: every image type
 * but SVG, which is text (XML), read and written as text. Only the file preview
 * widget draws an SVG as an image (svgAsImage). Files and URLs both decide here.
 */
export function isImageAnswer(mimeType: string, svgAsImage = false): boolean {
    const type = mimeType.toLowerCase().split(';')[0].trim();
    return type.startsWith('image/') && (svgAsImage || type !== SVG_MIME_TYPE);
}

/**
 * Image file handler implementation
 * Supports: PNG, JPEG, GIF, WebP, BMP; an SVG only for the file preview widget
 * (isImageAnswer), everyone else reads and writes it as text.
 */
export class ImageFileHandler implements FileHandler {
    private static readonly IMAGE_MIME_TYPES: { [key: string]: string } = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml'
    };

    canHandle(path: string, options?: { svgAsImage?: boolean }): boolean {
        return isImageAnswer(this.getMimeType(path), options?.svgAsImage);
    }

    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        // Images are always read in full, ignoring offset and length
        const buffer = await fs.readFile(path, { signal: options?.signal });
        const content = buffer.toString('base64');
        const mimeType = this.getMimeType(path);

        return {
            content,
            mimeType,
            metadata: {
                isImage: true
            }
        };
    }

    async write(path: string, content: Buffer | string, mode?: 'rewrite' | 'append'): Promise<void> {
        // An image can't take text at its end: writing the content would replace the file
        if (mode === 'append') {
            throw new Error('Image append not supported.');
        }
        // If content is base64 string, convert to buffer
        if (typeof content === 'string') {
            const buffer = Buffer.from(content, 'base64');
            await fs.writeFile(path, buffer);
        } else {
            await fs.writeFile(path, content);
        }
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'image',
            metadata: {
                isImage: true
            }
        };
    }

    /**
     * Get MIME type for image based on file extension
     */
    private getMimeType(path: string): string {
        const lowerPath = path.toLowerCase();
        for (const [ext, mimeType] of Object.entries(ImageFileHandler.IMAGE_MIME_TYPES)) {
            if (lowerPath.endsWith(ext)) {
                return mimeType;
            }
        }
        return 'application/octet-stream'; // Fallback
    }
}
