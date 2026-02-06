import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { DocxEditOptions, DocxOperation } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { parseDocxToHtml } from '../html.js';
import { createDocxFromHtml } from '../builders/html-builder.js';
import {
  DocxReplaceTextOperationSchema,
  DocxOperationSchema,
} from '../../schemas.js';

/**
 * Convert markdown to HTML for backward compatibility
 */
function markdownToHtml(markdown: string): string {
  let html = markdown;
  
  // Headings
  html = html.replace(/^###### (.*)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.*)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.*)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  
  // Paragraphs
  const paragraphs = html.split('\n\n').map(p => p.trim()).filter(p => p);
  html = paragraphs.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  
  return html;
}

/**
 * Convert markdown table to HTML table
 */
function markdownTableToHtml(markdown: string): string {
  const lines = markdown.split('\n').filter(line => line.trim());
  if (lines.length < 2) return '';
  
  let html = '<table>';
  
  // Header row
  const headerLine = lines[0];
  const headerCells = headerLine.split('|').map(cell => cell.trim()).filter(cell => cell);
  html += '<thead><tr>';
  for (const cell of headerCells) {
    html += `<th>${cell}</th>`;
  }
  html += '</tr></thead>';
  
  // Data rows (skip separator line at index 1)
  html += '<tbody>';
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split('|').map(cell => cell.trim()).filter(cell => cell);
    html += '<tr>';
    for (const cell of cells) {
      html += `<td>${cell}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  
  return html;
}

/**
 * Edit DOCX file using HTML-based operations
 * Uses mammoth to read DOCX → HTML, modifies HTML, then html-to-docx to write back
 */
export async function editDocxWithOperations(
  docxPath: string,
  operations: DocxOperation[],
  options: DocxEditOptions = {},
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      // Validate input path
      if (!docxPath || !docxPath.toLowerCase().endsWith('.docx')) {
        throw new DocxError(
          'Invalid DOCX path: must end with .docx',
          DocxErrorCode.INVALID_PATH,
          { path: docxPath }
        );
      }

      const baseDir = options.baseDir ?? path.dirname(docxPath);

      // Read existing DOCX and convert to HTML
      const docxResult = await parseDocxToHtml(docxPath, {
        includeImages: true,
        preserveFormatting: true
      });
      
      let html = docxResult.html;

      // Apply operations to HTML
      for (const op of operations) {
        const validatedOp = DocxOperationSchema.parse(op);
        
        switch (validatedOp.type) {
          case 'replaceText':
            // Simple text replacement in HTML (preserves HTML structure)
            const searchRegex = validatedOp.matchCase 
              ? new RegExp(escapeRegExp(validatedOp.search), validatedOp.global ? 'g' : '')
              : new RegExp(escapeRegExp(validatedOp.search), validatedOp.global ? 'gi' : 'i');
            html = html.replace(searchRegex, validatedOp.replace);
            break;
            
          case 'appendMarkdown':
            // Convert markdown to HTML and append
            const appendHtml = markdownToHtml(validatedOp.markdown);
            html += '\n' + appendHtml;
            break;
            
          case 'insertTable':
            // Convert table to HTML and append
            let tableHtml = '';
            if (validatedOp.markdownTable) {
              tableHtml = markdownTableToHtml(validatedOp.markdownTable);
            } else if (validatedOp.rows && validatedOp.rows.length > 0) {
              // Convert rows array to markdown table first
              const markdownTable = buildMarkdownTableFromRows(validatedOp.rows);
              tableHtml = markdownTableToHtml(markdownTable);
            }
            if (tableHtml) {
              html += '\n' + tableHtml;
            }
            break;
            
          case 'insertImage':
            // Insert image as HTML img tag
            const imageSrc = validatedOp.imagePath.startsWith('data:') || validatedOp.imagePath.startsWith('http')
              ? validatedOp.imagePath
              : `file://${path.resolve(baseDir, validatedOp.imagePath)}`;
            const altText = validatedOp.altText || '';
            const width = validatedOp.width ? ` width="${validatedOp.width}"` : '';
            const height = validatedOp.height ? ` height="${validatedOp.height}"` : '';
            html += `\n<img src="${imageSrc}" alt="${altText}"${width}${height} />`;
            break;
        }
      }
      
      // Convert modified HTML back to DOCX
      return await createDocxFromHtml(html, { baseDir });
    },
    DocxErrorCode.DOCX_EDIT_FAILED,
    { path: docxPath, operationCount: operations.length }
  );
}

/**
 * Escape special regex characters
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build markdown table from rows array
 */
function buildMarkdownTableFromRows(rows: string[][]): string {
  if (rows.length === 0) return '';
  
  const lines: string[] = [];
  
  // Header row
  if (rows.length > 0) {
    lines.push('| ' + rows[0].join(' | ') + ' |');
    lines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
  }
  
  // Data rows
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + rows[i].join(' | ') + ' |');
  }
  
  return lines.join('\n');
}
