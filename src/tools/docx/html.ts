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
  DocxMetadata,
  DocxImage,
  DocxSection,
  DocxParseOptions,
  DocxDocumentDefaults,
} from './types.js';
import { DocxError, DocxErrorCode, withErrorContext } from './errors.js';
import { DEFAULT_CONVERSION_OPTIONS, CORE_PROPERTIES_PATH, DOCX_NAMESPACES } from './constants.js';
import { isUrl } from './utils.js';
import { convertDocxToStyledHtml } from './styled-html-parser.js';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
const { DOMParser } = require('@xmldom/xmldom');

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

      const metadata = await extractMetadata(source, buffer, fileSize);
      const html = postProcessHtml(rawHtml);
      const sections = parseIntoSections(html);

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
      // Fall through to mammoth
    }
  }
  return { ...await convertWithMammoth(buffer, includeImages, styleMap, preserveFormatting), documentDefaults: undefined };
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

// ─── Metadata Extraction ─────────────────────────────────────────────────────

async function extractMetadata(source: string, buffer: Buffer, fileSize?: number): Promise<DocxMetadata> {
  const metadata: DocxMetadata = { fileSize };

  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const corePropsFile = zip.file(CORE_PROPERTIES_PATH);
    if (!corePropsFile) return metadata;

    const corePropsXml = await corePropsFile.async('string');
    const doc = new DOMParser().parseFromString(corePropsXml, 'application/xml');

    const getText = (tag: string, nsList: string[] = [DOCX_NAMESPACES.DUBLIN_CORE, DOCX_NAMESPACES.CUSTOM_PROPERTIES]): string | undefined => {
      for (const ns of nsList) {
        const els = doc.getElementsByTagName(`${ns}:${tag}`);
        if (els.length > 0 && els[0].textContent) return els[0].textContent.trim();
      }
      return undefined;
    };

    const getDate = (tag: string): Date | undefined => {
      const els = doc.getElementsByTagName(`${DOCX_NAMESPACES.DCTERMS}:${tag}`);
      if (els.length > 0 && els[0].textContent) {
        const d = new Date(els[0].textContent.trim());
        if (!isNaN(d.getTime())) return d;
      }
      return undefined;
    };

    metadata.title = getText('title');
    metadata.author = getText('creator');
    metadata.subject = getText('subject');
    metadata.description = getText('description');
    metadata.lastModifiedBy = getText('lastModifiedBy', [DOCX_NAMESPACES.CUSTOM_PROPERTIES]);
    metadata.revision = getText('revision', [DOCX_NAMESPACES.CUSTOM_PROPERTIES]);
    metadata.creationDate = getDate('created');
    metadata.modificationDate = getDate('modified');
  } catch {
    // Non-critical
  }

  return metadata;
}

// ─── Post-Processing ─────────────────────────────────────────────────────────

/** Minimal whitespace cleanup — preserves all inline style attributes. */
function postProcessHtml(html: string): string {
  return html.replace(/>\s{2,}</g, '>\n<').trim();
}

// ─── Image Extraction (mammoth fallback) ─────────────────────────────────────

function extractImagesFromHtml(html: string): DocxImage[] {
  const images: DocxImage[] = [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imgElements = doc.getElementsByTagName('img');

    for (let i = 0; i < imgElements.length; i++) {
      const src = imgElements[i].getAttribute('src') || '';
      const alt = imgElements[i].getAttribute('alt') || '';
      const match = src.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        images.push({
          id: `img_${i}`,
          data: match[2],
          mimeType: match[1],
          altText: alt || undefined,
          originalSize: Buffer.from(match[2], 'base64').length,
        });
      }
    }
  } catch {
    // Non-critical
  }
  return images;
}

// ─── Section Parsing ─────────────────────────────────────────────────────────

function parseIntoSections(html: string): DocxSection[] {
  const sections: DocxSection[] = [];

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0];

    if (!body) {
      sections.push({ type: 'paragraph', content: html });
      return sections;
    }

    for (let i = 0; i < body.childNodes.length; i++) {
      const child = body.childNodes[i];
      if (child.nodeType !== 1) continue;

      const element = child as Element;
      const tag = element.tagName.toLowerCase();

      const headingMatch = tag.match(/^h([1-6])$/);
      if (headingMatch) {
        sections.push({ type: 'heading', level: parseInt(headingMatch[1], 10), content: element.outerHTML || element.innerHTML });
        continue;
      }

      if (tag === 'img') { sections.push({ type: 'image', content: element.outerHTML }); continue; }
      if (tag === 'table') { sections.push({ type: 'table', content: element.outerHTML }); continue; }
      if (tag === 'ul' || tag === 'ol') { sections.push({ type: 'list', content: element.outerHTML }); continue; }
      if (tag === 'p' || tag === 'div') { sections.push({ type: 'paragraph', content: element.outerHTML }); continue; }
    }
  } catch {
    sections.push({ type: 'paragraph', content: html });
  }

  return sections;
}
