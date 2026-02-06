/**
 * DOCX Constants
 * Centralized constants for DOCX operations
 */

/**
 * Default DOCX conversion options
 */
export const DEFAULT_CONVERSION_OPTIONS = {
  includeImages: true,
  preserveFormatting: true,
  styleMap: [] as string[],
} as const;

/**
 * Default DOCX build options
 */
export const DEFAULT_BUILD_OPTIONS = {
  font: 'Calibri',
  fontSize: 11,
  orientation: 'portrait' as const,
  margins: {
    top: 1440,
    right: 1440,
    bottom: 1440,
    left: 1440,
    header: 720,
    footer: 720,
    gutter: 0,
  },
  footer: true,
  pageNumber: false,
} as const;

/**
 * Supported image MIME types
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp',
  'image/svg+xml',
] as const;

/**
 * Supported image file extensions
 */
export const SUPPORTED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
] as const;

/**
 * XML namespaces used in DOCX files
 */
export const DOCX_NAMESPACES = {
  DUBLIN_CORE: 'dc',
  CUSTOM_PROPERTIES: 'cp',
  DCTERMS: 'dcterms',
} as const;

/**
 * DOCX core properties file path
 */
export const CORE_PROPERTIES_PATH = 'docProps/core.xml';

/**
 * HTML wrapper template for incomplete HTML
 */
export const HTML_WRAPPER_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body>
{content}
</body>
</html>`;

