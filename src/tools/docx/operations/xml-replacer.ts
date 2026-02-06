/**
 * XML Text Replacer
 * Handles direct XML manipulation for text replacements (preserves formatting)
 */

import fs from 'fs/promises';
import JSZip from 'jszip';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';

/**
 * Replace text directly in DOCX XML without converting to markdown
 * This preserves all formatting, tables, styles, etc.
 */
export async function replaceTextInDocxXml(
  docxPath: string,
  searchText: string,
  replaceText: string
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      const docxBuffer = await fs.readFile(docxPath);
      const zip = await JSZip.loadAsync(docxBuffer);
      
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) {
        throw new DocxError(
          'Invalid DOCX file: word/document.xml not found',
          DocxErrorCode.INVALID_DOCX,
          { path: docxPath }
        );
      }
      
      // Escape XML special characters
      const escapeXml = (str: string) => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      
      const escapedSearch = escapeXml(searchText);
      const escapedReplace = escapeXml(replaceText);
      
      // Simple replacement in text nodes
      const modifiedXml = documentXml.replace(
        new RegExp(escapedSearch, 'g'),
        escapedReplace
      );
      
      zip.file('word/document.xml', modifiedXml);
      const arrayBuffer = await zip.generateAsync({ type: 'uint8array' });
      return Buffer.from(arrayBuffer);
    },
    DocxErrorCode.DOCX_XML_REPLACE_FAILED,
    { searchText, replaceText }
  );
}

