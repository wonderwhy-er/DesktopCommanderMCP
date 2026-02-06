/**
 * HTML to DOCX Conversion using html-to-docx
 * Uses html-to-docx library for creating Word documents from HTML
 */

import { createRequire } from 'module';
import type { DocxBuildOptions } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';

const require = createRequire(import.meta.url);
const HTMLtoDOCX = require('html-to-docx');

/**
 * Create DOCX from HTML using html-to-docx library
 * @param html HTML content to convert
 * @param options Build options
 * @returns Buffer containing the DOCX file
 */
export async function createDocxFromHtml(
  html: string,
  options: DocxBuildOptions = {},
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      // Ensure HTML has proper structure
      let processedHtml = html.trim();
      
      // If HTML doesn't have body tags, wrap it
      if (!processedHtml.includes('<body') && !processedHtml.includes('<html')) {
        processedHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body>
${processedHtml}
</body>
</html>`;
      }

      // Configure html-to-docx options
      const docxOptions: any = {
        table: { row: { cantSplit: true } },
        footer: true,
        pageNumber: false,
        font: 'Calibri',
        fontSize: 11,
        orientation: 'portrait',
        margins: {
          top: 1440,
          right: 1440,
          bottom: 1440,
          left: 1440,
          header: 720,
          footer: 720,
          gutter: 0
        }
      };

      // Convert HTML to DOCX buffer
      const docxBuffer = await HTMLtoDOCX(processedHtml, null, docxOptions);
      
      return Buffer.from(docxBuffer);
    },
    DocxErrorCode.DOCX_CREATE_FAILED,
    { htmlLength: html.length }
  );
}

