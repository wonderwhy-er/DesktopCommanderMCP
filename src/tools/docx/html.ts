/**
 * DOCX → HTML Conversion
 *
 * Primary:  Direct DOCX XML parsing (`styled-html-parser`) — preserves inline styles
 *           (font colours, sizes, families, alignment, highlights, etc.)
 * Fallback: mammoth.js — semantic-only conversion, strips visual styles.
 *
 * @module docx/html
 */

import fs from 'fs/promises';
import { createRequire } from 'module';
import type {
  DocxParseResult,
  DocxImage,
  DocxParseOptions,
  DocxDocumentDefaults,
} from './types.js';
import { DocxError, DocxErrorCode, withErrorContext } from './errors.js';
import { DEFAULT_CONVERSION_OPTIONS } from './constants.js';
import { isUrl } from './utils/paths.js';
import { convertDocxToStyledHtml } from './styled-html-parser.js';
import { extractDocxMetadata } from './extractors/metadata.js';
import { parseHtmlIntoSections } from './extractors/sections.js';
import { extractImagesFromHtml } from './extractors/images.js';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a DOCX file to styled HTML.
 *
 * Uses direct XML parsing when `preserveFormatting` is true (default).
 * Falls back to mammoth.js if direct parsing fails or a custom `styleMap` is provided.
 */
export async function parseDocxToHtml(
  source: string,
  options: DocxParseOptions = {}
): Promise<DocxParseResult> {
  return withErrorContext(
    async () => {
      const {
        includeImages = DEFAULT_CONVERSION_OPTIONS.includeImages,
        preserveFormatting = DEFAULT_CONVERSION_OPTIONS.preserveFormatting,
        styleMap = DEFAULT_CONVERSION_OPTIONS.styleMap,
      } = options;

      const buffer = await loadDocxToBuffer(source);

      let fileSize: number | undefined;
      if (!isUrl(source)) {
        try { fileSize = (await fs.stat(source)).size; } catch { /* ignore */ }
      }

      const { html: rawHtml, images, documentDefaults } = await convertToHtml(
        buffer, includeImages, preserveFormatting, styleMap
      );

      const metadata = await extractDocxMetadata(buffer, fileSize);
      const html = postProcessHtml(rawHtml);
      const sections = parseHtmlIntoSections(html);

      return { html, metadata, images, sections, documentDefaults };
    },
    DocxErrorCode.DOCX_READ_FAILED,
    { path: source }
  );
}

// ─── Buffer Loading ──────────────────────────────────────────────────────────

async function loadDocxToBuffer(source: string): Promise<Buffer> {
  return withErrorContext(
    async () => {
      if (isUrl(source)) {
        const response = await fetch(source);
        if (!response.ok) {
          throw new DocxError(
            `Failed to fetch DOCX from URL: ${response.statusText}`,
            DocxErrorCode.DOCX_READ_FAILED,
            { url: source, status: response.status }
          );
        }
        return Buffer.from(await response.arrayBuffer());
      }
      return await fs.readFile(source);
    },
    DocxErrorCode.DOCX_READ_FAILED,
    { source }
  );
}

// ─── Conversion Dispatch ─────────────────────────────────────────────────────

/**
 * Pick the best converter: direct XML parser (preserves styles) or mammoth.js (semantic only).
 */
async function convertToHtml(
  buffer: Buffer,
  includeImages: boolean,
  preserveFormatting: boolean,
  styleMap: readonly string[]
): Promise<{ html: string; images: DocxImage[]; documentDefaults?: DocxDocumentDefaults }> {
  // Use the styled XML parser when no custom styleMap is provided and formatting is requested
  if (preserveFormatting && styleMap.length === 0) {
    try {
      return await convertDocxToStyledHtml(buffer, includeImages);
    } catch {
      // Fall through to mammoth.js fallback
    }
  }
  const mammothResult = await convertWithMammoth(buffer, includeImages, styleMap, preserveFormatting);
  return { ...mammothResult, documentDefaults: undefined };
}

/** Fallback: mammoth.js (semantic-only — strips visual styles). */
async function convertWithMammoth(
  buffer: Buffer,
  includeImages: boolean,
  styleMap: readonly string[],
  preserveFormatting: boolean
): Promise<{ html: string; images: DocxImage[] }> {
  const mammothOptions: { convertImage?: any; styleMap?: string[] } = {};

  if (includeImages) {
    mammothOptions.convertImage = mammoth.images.imgElement((image: any) =>
      image.read('base64').then((base64Data: string) => ({
        src: `data:${image.contentType};base64,${base64Data}`,
      }))
    );
  }

  if (styleMap.length > 0) {
    mammothOptions.styleMap = [...styleMap];
  } else if (preserveFormatting) {
    mammothOptions.styleMap = [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
      "p[style-name='Heading 5'] => h5:fresh",
      "p[style-name='Heading 6'] => h6:fresh",
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => h2:fresh",
      "p[style-name='Quote'] => blockquote:fresh",
      "r[style-name='Strong'] => strong",
      "r[style-name='Emphasis'] => em",
    ];
  }

  const result = await mammoth.convertToHtml({ buffer }, mammothOptions);
  const html: string = result.value;
  const images = extractImagesFromHtml(html);

  return { html, images };
}


// ─── Post-Processing ─────────────────────────────────────────────────────────

/** Minimal whitespace cleanup — preserves all inline style attributes. */
function postProcessHtml(html: string): string {
  return html.replace(/>\s{2,}</g, '>\n<').trim();
}


