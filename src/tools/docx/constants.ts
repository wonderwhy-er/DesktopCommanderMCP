/**
 * DOCX Constants
 *
 * Centralised constants shared across the DOCX module.
 *
 * @module docx/constants
 */

// ─── Conversion Defaults ─────────────────────────────────────────────────────

export const DEFAULT_CONVERSION_OPTIONS = {
  includeImages: true,
  preserveFormatting: true,
  styleMap: [] as readonly string[],
} as const;

// ─── Build (html-to-docx) Defaults ──────────────────────────────────────────

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

// ─── DOCX Internal XML Namespaces ────────────────────────────────────────────

export const DOCX_NAMESPACES = {
  DUBLIN_CORE: 'dc',
  CUSTOM_PROPERTIES: 'cp',
  DCTERMS: 'dcterms',
} as const;

// ─── DOCX Archive Paths ─────────────────────────────────────────────────────

export const CORE_PROPERTIES_PATH = 'docProps/core.xml';

// ─── Image MIME Types (extension → MIME) ─────────────────────────────────────

export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  png: 'image/png',
} as const;

// ─── HTML Wrapper Template ───────────────────────────────────────────────────

export const HTML_WRAPPER_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body>
{content}
</body>
</html>`;
