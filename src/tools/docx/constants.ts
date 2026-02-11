/**
 * DOCX constants — shared values used across the module.
 */

// ═══════════════════════════════════════════════════════════════════════
// Image MIME types
// ═══════════════════════════════════════════════════════════════════════

export const IMAGE_MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

export function getMimeType(ext: string): string {
    return IMAGE_MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

// ═══════════════════════════════════════════════════════════════════════
// EMU conversion (English Metric Units)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert pixels to EMU (English Metric Units).
 * 1 inch = 914400 EMU, 1 px ≈ 9525 EMU (at 96 DPI)
 */
export const PX_TO_EMU = 9525;

export function pixelsToEmu(px: number): number {
    return px * PX_TO_EMU;
}

// ═══════════════════════════════════════════════════════════════════════
// XML namespaces
// ═══════════════════════════════════════════════════════════════════════

export const NAMESPACES = {
    W: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    WP: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    PIC: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    RELS: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Default values
// ═══════════════════════════════════════════════════════════════════════

export const DEFAULT_IMAGE_WIDTH = 300;
export const DEFAULT_IMAGE_HEIGHT = 200;

// ═══════════════════════════════════════════════════════════════════════
// File paths
// ═══════════════════════════════════════════════════════════════════════

export const DOCX_PATHS = {
    CONTENT_TYPES: '[Content_Types].xml',
    DOCUMENT_XML: 'word/document.xml',
    DOCUMENT_RELS: 'word/_rels/document.xml.rels',
    ROOT_RELS: '_rels/.rels',
    STYLES_XML: 'word/styles.xml',
    SETTINGS_XML: 'word/settings.xml',
    WEB_SETTINGS_XML: 'word/webSettings.xml',
    FONT_TABLE_XML: 'word/fontTable.xml',
    MEDIA_FOLDER: 'word/media',
} as const;

