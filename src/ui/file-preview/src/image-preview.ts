export const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    // Intentional product decision: allow SVG rendering in preview UI.
    // This is currently unsanitized and should be revisited if threat model changes.
    'image/svg',
    'image/svg+xml'
]);

export function normalizeImageMimeType(mimeType: string | undefined): string {
    if (!mimeType) {
        return '';
    }
    return mimeType.toLowerCase().split(';', 1)[0].trim();
}

export function isAllowedImageMimeType(mimeType: string | undefined): boolean {
    const normalizedMimeType = normalizeImageMimeType(mimeType);
    return normalizedMimeType.length > 0 && ALLOWED_IMAGE_MIME_TYPES.has(normalizedMimeType);
}
