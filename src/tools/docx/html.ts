/**
 * DOCX → HTML Conversion
 *
 * Primary: Direct DOCX XML parsing (`styled-html-parser`) — preserves inline styles
 *          (font colors, sizes, families, alignment, highlights, etc.)
 * Fallback: mammoth.js — semantic-only conversion, strips visual styles.
 *
 * @module docx/html
 */

import fs from 'fs/promises';
import { createRequire } from 'module';
import type { DocxParseResult, DocxMetadata, DocxImage, DocxSection, DocxParseOptions } from './types.js';
import { DocxError, DocxErrorCode, withErrorContext } from './errors.js';
import { DEFAULT_CONVERSION_OPTIONS, CORE_PROPERTIES_PATH, DOCX_NAMESPACES } from './constants.js';
import { isUrl } from './utils.js';
import { convertDocxToStyledHtml } from './styled-html-parser.js';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
const { DOMParser } = require('@xmldom/xmldom');

/**
 * Load DOCX file as buffer from file path or URL
 * @param source - File path or URL
 * @returns Buffer containing DOCX file data
 * @throws {DocxError} If file cannot be loaded
 */
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
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      return await fs.readFile(source);
    },
    DocxErrorCode.DOCX_READ_FAILED,
    { source }
  );
}

/**
 * Extract images from HTML content
 * @param html - HTML content with embedded images
 * @returns Array of extracted image information
 */
function extractImagesFromHtml(html: string): DocxImage[] {
  const images: DocxImage[] = [];

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imgElements = doc.getElementsByTagName('img');

    for (let i = 0; i < imgElements.length; i++) {
      const img = imgElements[i];
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';

      // Extract base64 data from data URL
      const dataUrlMatch = src.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUrlMatch) {
        const [, mimeType, base64Data] = dataUrlMatch;
        const imageBuffer = Buffer.from(base64Data, 'base64');

        images.push({
          id: `img_${i}`,
          data: base64Data,
          mimeType,
          altText: alt || undefined,
          originalSize: imageBuffer.length,
        });
      }
    }
  } catch (error) {
    // If image extraction fails, continue without images
    // This is non-critical, so we silently continue
    // Error details are available in the catch block if needed for debugging
  }

  return images;
}

/**
 * Extract metadata from DOCX file buffer
 * @param source - Source path (for context)
 * @param buffer - DOCX file buffer
 * @param fileSize - File size in bytes (optional)
 * @returns Extracted metadata
 */
async function extractMetadata(
  source: string,
  buffer: Buffer,
  fileSize?: number
): Promise<DocxMetadata> {
  const metadata: DocxMetadata = { fileSize };

  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);

    const corePropsFile = zip.file(CORE_PROPERTIES_PATH);
    if (!corePropsFile) {
      return metadata;
    }

    const corePropsXml = await corePropsFile.async('string');
    const doc = new DOMParser().parseFromString(corePropsXml, 'application/xml');

    // Helper to extract text content from elements with namespace handling
    const getTextContent = (
      tagName: string,
      namespaces: string[] = [DOCX_NAMESPACES.DUBLIN_CORE, DOCX_NAMESPACES.CUSTOM_PROPERTIES]
    ): string | undefined => {
      for (const ns of namespaces) {
        const elements = doc.getElementsByTagName(`${ns}:${tagName}`);
        if (elements.length > 0 && elements[0].textContent) {
          return elements[0].textContent.trim();
        }
      }
      return undefined;
    };

    // Helper to extract date from dcterms elements
    const getDateContent = (tagName: string): Date | undefined => {
      const elements = doc.getElementsByTagName(`${DOCX_NAMESPACES.DCTERMS}:${tagName}`);
      if (elements.length > 0 && elements[0].textContent) {
        try {
          const dateStr = elements[0].textContent.trim();
          const date = new Date(dateStr);
          // Validate date
          if (!isNaN(date.getTime())) {
            return date;
          }
        } catch {
          // Invalid date format - ignore
        }
      }
      return undefined;
    };

    // Extract standard Dublin Core properties
    metadata.title = getTextContent('title');
    metadata.author = getTextContent('creator');
    metadata.subject = getTextContent('subject');
    metadata.description = getTextContent('description');

    // Extract custom properties (cp namespace)
    metadata.lastModifiedBy = getTextContent('lastModifiedBy', [DOCX_NAMESPACES.CUSTOM_PROPERTIES]);
    metadata.revision = getTextContent('revision', [DOCX_NAMESPACES.CUSTOM_PROPERTIES]);

    // Extract dates from dcterms namespace
    metadata.creationDate = getDateContent('created');
    metadata.modificationDate = getDateContent('modified');
  } catch (metaError) {
    // Metadata extraction is optional, don't fail if it doesn't work
    // Return metadata with only fileSize if extraction fails
  }

  return metadata;
}

/** Minimal whitespace cleanup — preserves all inline style attributes. */
function postProcessHtml(html: string): string {
  return html.replace(/>\s{2,}</g, '>\n<').trim();
}

/**
 * Parse HTML into structured sections
 * @param html - HTML content
 * @param images - Extracted images
 * @returns Array of structured sections
 */
function parseIntoSections(html: string, images: DocxImage[]): DocxSection[] {
  const sections: DocxSection[] = [];

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0];

    if (!body) {
      // If no body tag, treat entire HTML as one section
      sections.push({
        type: 'paragraph',
        content: html,
      });
      return sections;
    }

    const children = body.childNodes;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child.nodeType === 1) {
        // Element node
        const element = child as Element;
        const tagName = element.tagName.toLowerCase();

        // Detect headings
        const headingMatch = tagName.match(/^h([1-6])$/);
        if (headingMatch) {
          const level = parseInt(headingMatch[1], 10);
          sections.push({
            type: 'heading',
            level,
            content: element.outerHTML || element.innerHTML,
          });
          continue;
        }

        // Detect images
        if (tagName === 'img') {
          sections.push({
            type: 'image',
            content: element.outerHTML,
          });
          continue;
        }

        // Detect tables
        if (tagName === 'table') {
          sections.push({
            type: 'table',
            content: element.outerHTML,
          });
          continue;
        }

        // Detect lists
        if (tagName === 'ul' || tagName === 'ol') {
          sections.push({
            type: 'list',
            content: element.outerHTML,
          });
          continue;
        }

        // Regular paragraphs
        if (tagName === 'p' || tagName === 'div') {
          sections.push({
            type: 'paragraph',
            content: element.outerHTML,
          });
          continue;
        }
      }
    }
  } catch (error) {
    // If parsing fails, return entire HTML as one section
    // This is a fallback to ensure we always return valid sections
    sections.push({
      type: 'paragraph',
      content: html,
    });
  }

  return sections;
}

/**
 * Convert DOCX to HTML with full style preservation.
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

      // Load DOCX file
      const buffer = await loadDocxToBuffer(source);

      // Get file size (for local files)
      let fileSize: number | undefined;
      if (!isUrl(source)) {
        try {
          const stats = await fs.stat(source);
          fileSize = stats.size;
        } catch {
          // Ignore stat errors
        }
      }

      let html: string;
      let images: DocxImage[];

      // Primary: direct XML parsing (preserves inline styles)
      if (preserveFormatting && styleMap.length === 0) {
        try {
          const result = await convertDocxToStyledHtml(buffer, includeImages);
          html = result.html;
          images = result.images;
        } catch {
          // Fall back to mammoth if XML parsing fails
          const fallback = await convertWithMammoth(buffer, includeImages, styleMap, preserveFormatting);
          html = fallback.html;
          images = fallback.images;
        }
      } else {
        // Mammoth fallback (custom styleMap or preserveFormatting off)
        const fallback = await convertWithMammoth(buffer, includeImages, styleMap, preserveFormatting);
        html = fallback.html;
        images = fallback.images;
      }

      // Extract metadata
      const metadata = await extractMetadata(source, buffer, fileSize);

      // Post-process HTML
      html = postProcessHtml(html);

      // Parse into sections
      const sections = parseIntoSections(html, images);

      return {
        html,
        metadata,
        images,
        sections,
      };
    },
    DocxErrorCode.DOCX_READ_FAILED,
    { path: source }
  );
}

/** Fallback: mammoth.js (strips visual styles — only semantic conversion). */
async function convertWithMammoth(
  buffer: Buffer,
  includeImages: boolean,
  styleMap: readonly string[],
  preserveFormatting: boolean
): Promise<{ html: string; images: DocxImage[] }> {
  const mammothOptions: {
    convertImage?: (image: any) => Promise<{ src: string }>;
    styleMap?: string[];
  } = {};

  if (includeImages) {
    mammothOptions.convertImage = mammoth.images.imgElement((image: any) => {
      return image.read('base64').then((imageBuffer: Buffer) => {
        const base64 = imageBuffer.toString('base64');
        return {
          src: `data:${image.contentType};base64,${base64}`,
        };
      });
    });
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
  const html = result.value;
  const images = extractImagesFromHtml(html);

  return { html, images };
}
