/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 */

import { FileHandler } from './base.js';
import { TextFileHandler } from './text.js';
import { ImageFileHandler } from './image.js';
import { BinaryFileHandler } from './binary.js';
import { ExcelFileHandler } from './excel.js';
import { PdfFileHandler } from './pdf.js';

// Singleton instances of each handler
let handlers: FileHandler[] | null = null;

/**
 * Initialize handlers (lazy initialization)
 */
function initializeHandlers(): FileHandler[] {
    if (handlers) {
        return handlers;
    }

    handlers = [
        // Order matters! More specific handlers first
        new PdfFileHandler(),      // Check PDF first
        new ExcelFileHandler(),    // Check Excel (before binary)
        new ImageFileHandler(),    // Then images
        new TextFileHandler(),     // Then text (handles most files)
        new BinaryFileHandler(),   // Finally binary (catch-all)
    ];

    return handlers;
}

/**
 * Get the appropriate file handler for a given file path
 *
 * This function checks each handler in priority order and returns the first
 * handler that can handle the file type.
 *
 * Priority order:
 * 1. Excel files (xlsx, xls, xlsm)
 * 2. Image files (png, jpg, gif, webp)
 * 3. Text files (most other files)
 * 4. Binary files (catch-all for unsupported formats)
 *
 * @param path File path (can be before or after validation)
 * @returns FileHandler instance that can handle this file
 */
export function getFileHandler(path: string): FileHandler {
    const allHandlers = initializeHandlers();

    // Try each handler in order
    for (const handler of allHandlers) {
        if (handler.canHandle(path)) {
            return handler;
        }
    }

    // Fallback to binary handler (should never reach here due to binary catch-all)
    return allHandlers[allHandlers.length - 1];
}

/**
 * Check if a file path is an Excel file
 * @param path File path
 * @returns true if file is Excel format
 */
export function isExcelFile(path: string): boolean {
    const ext = path.toLowerCase();
    return ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.xlsm');
}

/**
 * Check if a file path is an image file
 * @param path File path
 * @returns true if file is an image format
 */
export function isImageFile(path: string): boolean {
    // This will be implemented by checking MIME type
    // For now, use extension-based check
    const ext = path.toLowerCase();
    return ext.endsWith('.png') ||
           ext.endsWith('.jpg') ||
           ext.endsWith('.jpeg') ||
           ext.endsWith('.gif') ||
           ext.endsWith('.webp') ||
           ext.endsWith('.bmp') ||
           ext.endsWith('.svg');
}
