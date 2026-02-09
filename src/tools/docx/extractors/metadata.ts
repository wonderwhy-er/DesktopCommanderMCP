/**
 * DOCX Metadata Extractor
 *
 * Extracts document metadata (title, author, dates, etc.) from DOCX core properties.
 * Follows Single Responsibility Principle — only handles metadata extraction.
 *
 * @module docx/extractors/metadata
 */

import { createRequire } from 'module';
import type { DocxMetadata } from '../types.js';
import { CORE_PROPERTIES_PATH, DOCX_NAMESPACES } from '../constants.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');

/**
 * Extract metadata from a DOCX buffer.
 * Returns minimal metadata if extraction fails (non-critical operation).
 */
export async function extractDocxMetadata(buffer: Buffer, fileSize?: number): Promise<DocxMetadata> {
  const metadata: DocxMetadata = { fileSize };

  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const corePropsFile = zip.file(CORE_PROPERTIES_PATH);
    if (!corePropsFile) return metadata;

    const corePropsXml = await corePropsFile.async('string');
    const doc = new DOMParser().parseFromString(corePropsXml, 'application/xml');

    /** Extract text content from a namespaced tag. */
    const getText = (
      tag: string,
      nsList: readonly string[] = [DOCX_NAMESPACES.DUBLIN_CORE, DOCX_NAMESPACES.CUSTOM_PROPERTIES]
    ): string | undefined => {
      for (const ns of nsList) {
        const els = doc.getElementsByTagName(`${ns}:${tag}`);
        if (els.length > 0 && els[0].textContent) {
          const text = els[0].textContent.trim();
          return text || undefined;
        }
      }
      return undefined;
    };

    /** Extract date from a DCTERMS namespaced tag. */
    const getDate = (tag: string): Date | undefined => {
      const els = doc.getElementsByTagName(`${DOCX_NAMESPACES.DCTERMS}:${tag}`);
      if (els.length > 0 && els[0].textContent) {
        const dateStr = els[0].textContent.trim();
        if (dateStr) {
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) return d;
        }
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
    // Non-critical — return metadata with fileSize only
  }

  return metadata;
}

