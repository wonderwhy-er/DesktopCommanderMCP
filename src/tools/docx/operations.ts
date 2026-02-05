/**
 * DOCX Creation and Editing Operations
 *
 * Provides high-level operations for creating and modifying Word documents:
 * - Create DOCX from markdown
 * - Edit existing DOCX via operations (replace text, append content, insert tables/images)
 *
 * Architecture:
 * - For editing, we convert DOCX → markdown → apply operations → rebuild DOCX
 * - This round-trip approach prioritizes reliability over preserving complex formatting
 * - Complex formatting may be simplified, which is acceptable for maintainability
 *
 * @module docx/operations
 */

import fs from 'fs/promises';
import path from 'path';
// @ts-ignore - docx library has incomplete type definitions but exports exist at runtime
import * as docx from 'docx';
import { z } from 'zod';

// Extract types and classes from the docx namespace
const {
  AlignmentType,
  Document,
  HeadingLevel,
  Media,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = docx as any;

import { parseDocxToMarkdown } from './markdown.js';
import {
  DocxReplaceTextOperationSchema,
  DocxAppendMarkdownOperationSchema,
  DocxInsertTableOperationSchema,
  DocxInsertImageOperationSchema,
  DocxOperationSchema,
} from '../schemas.js';
import {
  escapeRegExp,
  buildMarkdownTableFromRows,
  isValidMarkdownTable,
  resolveImagePath,
  validateImageFile,
  parseDataUrl,
  isDataUrl,
  normalizeLineEndings,
  DocxError,
  withErrorContext,
  prepareImageForDocx,
  createImageRun,
} from './utils.js';

// Infer TypeScript types from Zod schemas for type safety
export type DocxReplaceTextOperation = z.infer<typeof DocxReplaceTextOperationSchema>;
export type DocxAppendMarkdownOperation = z.infer<typeof DocxAppendMarkdownOperationSchema>;
export type DocxInsertTableOperation = z.infer<typeof DocxInsertTableOperationSchema>;
export type DocxInsertImageOperation = z.infer<typeof DocxInsertImageOperationSchema>;
export type DocxOperation = z.infer<typeof DocxOperationSchema>;

/**
 * Options for DOCX creation and editing
 */
export interface DocxBuildOptions {
  /** Base directory for resolving relative image paths */
  baseDir?: string;
  /** Include images during parsing (default: true) */
  includeImages?: boolean;
  /** Preserve text formatting like bold/italic (default: true) */
  preserveFormatting?: boolean;
}

/**
 * Options for editing existing DOCX files
 */
export interface DocxEditOptions extends DocxBuildOptions {
  /** Output path for the edited DOCX (defaults to overwriting input) */
  outputPath?: string;
}

/**
 * Create a DOCX file buffer from markdown content.
 *
 * Supported markdown features:
 * - Headings (# through ######)
 * - Paragraphs
 * - Markdown tables (with header row and separator)
 * - Images via ![alt](path) syntax (local files, data URLs)
 * - Basic text formatting (bold, italic) if present in markdown
 *
 * @param markdown - Markdown content to convert
 * @param options - Build options including baseDir for image resolution
 * @returns Buffer containing the DOCX file
 * @throws {DocxError} If markdown parsing or DOCX generation fails
 */
export async function createDocxFromMarkdown(
  markdown: string,
  options: DocxBuildOptions = {},
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      // Build blocks from markdown into an array
      const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
      
      // We need to build blocks first to know what we're creating
      // For images, we'll create a temporary document to register them
      const baseDir = options.baseDir;
      const lines = normalizeLineEndings(markdown).split('\n');

      let i = 0;
      while (i < lines.length) {
        const rawLine = lines[i];
        const line = rawLine.trimEnd();

        // Skip empty lines
        if (!line.trim()) {
          i++;
          continue;
        }

        // 1) Markdown table
        if (isTableHeaderLine(line) && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
          const tableLines: string[] = [line];
          i++;
          tableLines.push(lines[i]);
          i++;
          
          while (i < lines.length && isTableRowLine(lines[i])) {
            tableLines.push(lines[i]);
            i++;
          }

          const table = createTableFromMarkdown(tableLines);
          children.push(table);
          continue;
        }

        // 2) Images - embed using utility function
        const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (imageMatch) {
          const altText = imageMatch[1] || '';
          const src = imageMatch[2];
          
          try {
            // Prepare image data
            const imageData = await prepareImageForDocx(src, altText, baseDir);
            
            // Create image run
            const imageRun = createImageRun(imageData);
            
            // Create paragraph with image
            const paragraph = new Paragraph({
              children: [imageRun],
              alignment: AlignmentType.CENTER,
            });
            
            children.push(paragraph);
            i++;
            continue;
          } catch (error) {
            // If image fails, add placeholder text
            console.warn(`Failed to embed image ${src}:`, error);
            const paragraph = new Paragraph({
              text: `[Image: ${altText || src}]`,
              alignment: AlignmentType.LEFT,
            });
            children.push(paragraph);
            i++;
            continue;
          }
        }

         // 3) Heading with inline formatting
         const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
         if (headingMatch) {
           const level = headingMatch[1].length;
           const text = headingMatch[2].trim();
           const textRuns = parseInlineFormatting(text);
           
           const heading = new Paragraph({
             children: textRuns,
             heading: getHeadingLevel(level),
           });
           
           children.push(heading);
           i++;
           continue;
         }

         // 4) Regular paragraph with inline formatting support
         const textRuns = parseInlineFormatting(rawLine);
         const paragraph = new Paragraph({
           children: textRuns,
           alignment: AlignmentType.LEFT,
         });
         
         children.push(paragraph);
         i++;
       }

      // Create the document with all the built children
      const doc = new Document({
        sections: [
          {
            properties: {},
            children: children,
          },
        ],
      });

      return await Packer.toBuffer(doc);
    },
    'DOCX_CREATE_FAILED',
    { markdownLength: markdown.length }
  );
}

/**
 * Edit an existing DOCX file using high-level operations.
 *
 * Implementation strategy:
 * 1. Parse existing DOCX to markdown representation
 * 2. Apply operations sequentially to the markdown
 * 3. Rebuild DOCX from the modified markdown
 *
 * This approach ensures reliability but may simplify complex formatting.
 *
 * @param docxPath - Path to the existing DOCX file
 * @param operations - Array of operations to apply (validated against schemas)
 * @param options - Edit options including output path and baseDir
 * @returns Buffer containing the edited DOCX file
 * @throws {DocxError} If validation, parsing, or operation application fails
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
          'INVALID_PATH',
          { path: docxPath }
        );
      }

      const baseDir = options.baseDir ?? path.dirname(docxPath);

      // Parse existing DOCX to markdown
      const parsed = await parseDocxToMarkdown(docxPath, {
        includeImages: options.includeImages ?? true,
        preserveFormatting: options.preserveFormatting ?? true,
      });

      let markdown = parsed.markdown ?? '';

      // Apply each operation sequentially
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        
        try {
          // Validate operation against schema
          const validatedOp = DocxOperationSchema.parse(op);
          
          // Apply operation
          markdown = await applyOperation(markdown, validatedOp, baseDir);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new DocxError(
            `Operation ${i + 1} failed: ${message}`,
            'OPERATION_FAILED',
            { operationIndex: i, operationType: op.type }
          );
        }
      }

      // Rebuild DOCX from modified markdown
      return await createDocxFromMarkdown(markdown, { baseDir });
    },
    'DOCX_EDIT_FAILED',
    { path: docxPath, operationCount: operations.length }
  );
}

/**
 * Apply a single operation to markdown content
 */
async function applyOperation(
  markdown: string,
  op: DocxOperation,
  baseDir: string
): Promise<string> {
  switch (op.type) {
    case 'replaceText':
      return applyReplaceText(markdown, op);
    
    case 'appendMarkdown':
      return applyAppendMarkdown(markdown, op);
    
    case 'insertTable':
      return applyInsertTable(markdown, op);
    
    case 'insertImage':
      return await applyInsertImage(markdown, op, baseDir);
    
    default:
      // TypeScript should prevent this, but handle gracefully
      throw new DocxError(
        `Unknown operation type`,
        'UNKNOWN_OPERATION',
        { operation: op }
      );
  }
}

/**
 * Apply replace text operation
 */
function applyReplaceText(
  markdown: string,
  op: DocxReplaceTextOperation
): string {
  const { search, replace, matchCase = true, global = true } = op;
  
  if (!search) {
    return markdown; // No-op if search is empty
  }

  const flags = (global ? 'g' : '') + (matchCase ? '' : 'i');
  const regex = new RegExp(escapeRegExp(search), flags);
  
  return markdown.replace(regex, replace);
}

/**
 * Apply append markdown operation
 */
function applyAppendMarkdown(
  markdown: string,
  op: DocxAppendMarkdownOperation
): string {
  const toAppend = op.markdown || '';
  
  if (!toAppend.trim()) {
    return markdown; // No-op if nothing to append
  }

  // Ensure proper line separation
  let result = markdown;
  if (!result.endsWith('\n')) {
    result += '\n';
  }
  result += '\n' + toAppend.trim() + '\n';
  
  return result;
}

/**
 * Apply insert table operation
 */
function applyInsertTable(
  markdown: string,
  op: DocxInsertTableOperation
): string {
  let tableMarkdown = op.markdownTable;
  
  // Build from rows if markdown table not provided
  if (!tableMarkdown && op.rows && op.rows.length > 0) {
    tableMarkdown = buildMarkdownTableFromRows(op.rows);
  }
  
  if (!tableMarkdown || !tableMarkdown.trim()) {
    return markdown; // No-op if no table content
  }

  // Validate table format
  if (!isValidMarkdownTable(tableMarkdown)) {
    throw new DocxError(
      'Invalid markdown table format',
      'INVALID_TABLE',
      { table: tableMarkdown.substring(0, 100) }
    );
  }

  // Append table with proper spacing
  let result = markdown;
  if (!result.endsWith('\n')) {
    result += '\n';
  }
  result += '\n' + tableMarkdown.trim() + '\n';
  
  return result;
}

/**
 * Apply insert image operation
 */
async function applyInsertImage(
  markdown: string,
  op: DocxInsertImageOperation,
  baseDir: string
): Promise<string> {
  const imagePath = op.imagePath?.trim();
  
  if (!imagePath) {
    return markdown; // No-op if no image path
  }

  // Resolve path
  const resolved = resolveImagePath(imagePath, baseDir);
  
  // Validate image (unless it's a data URL, which we'll validate during creation)
  if (!isDataUrl(resolved)) {
    const validation = await validateImageFile(resolved);
    if (!validation.valid) {
      throw new DocxError(
        validation.error || 'Invalid image',
        'INVALID_IMAGE',
        { imagePath: resolved }
      );
    }
  }

  const altText = op.altText || path.basename(resolved);
  const imageMarkdown = `![${altText}](${resolved})`;
  
  // Append image with proper spacing
  let result = markdown;
  if (!result.endsWith('\n')) {
    result += '\n';
  }
  result += '\n' + imageMarkdown + '\n';
  
  return result;
}

/**
 * Parse inline markdown formatting (bold, italic) into TextRun array
 * Supports: **bold**, __bold__, *italic*, _italic_
 */
function parseInlineFormatting(text: string): InstanceType<typeof TextRun>[] {
  const runs: InstanceType<typeof TextRun>[] = [];
  
  // Pattern to match bold (**text** or __text__) and italic (*text* or _text_)
  // Using a more precise regex that handles nested and adjacent formatting
  const pattern = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|([^*_]+)/g;
  
  let match;
  let lastIndex = 0;
  
  // Simpler approach: process character by character with state tracking
  let currentText = '';
  let i = 0;
  
  while (i < text.length) {
    // Check for **bold**
    if (text.substring(i, i + 2) === '**') {
      // Save any accumulated text
      if (currentText) {
        runs.push(new TextRun({ text: currentText }));
        currentText = '';
      }
      
      // Find the closing **
      const closeIndex = text.indexOf('**', i + 2);
      if (closeIndex !== -1) {
        const boldText = text.substring(i + 2, closeIndex);
        runs.push(new TextRun({ text: boldText, bold: true }));
        i = closeIndex + 2;
        continue;
      }
    }
    
    // Check for *italic*
    if (text[i] === '*' && text[i + 1] !== '*') {
      // Save any accumulated text
      if (currentText) {
        runs.push(new TextRun({ text: currentText }));
        currentText = '';
      }
      
      // Find the closing *
      const closeIndex = text.indexOf('*', i + 1);
      if (closeIndex !== -1) {
        const italicText = text.substring(i + 1, closeIndex);
        runs.push(new TextRun({ text: italicText, italics: true }));
        i = closeIndex + 1;
        continue;
      }
    }
    
    // Regular character
    currentText += text[i];
    i++;
  }
  
  // Add any remaining text
  if (currentText) {
    runs.push(new TextRun({ text: currentText }));
  }
  
  return runs.length > 0 ? runs : [new TextRun({ text: text })];
}

/**
 * Get DOCX heading level from markdown level (1-6)
 */
function getHeadingLevel(level: number): any {
  const levelMap: Record<number, any> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };
  
  return levelMap[level] ?? HeadingLevel.HEADING_1;
}

/**
 * Check if line is a markdown table header
 */
function isTableHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|');
}

/**
 * Check if line is a markdown table separator (| --- | --- |)
 */
function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;
  
  // Match patterns like | --- | or |:---|---:|
  return /^(\|\s*:?-{2,}\s*:?\s*)+\|$/.test(trimmed);
}

/**
 * Check if line is a markdown table row
 */
function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|');
}

/**
 * Create DOCX table from markdown table lines
 */
function createTableFromMarkdown(lines: string[]): InstanceType<typeof Table> {
  if (lines.length < 2) {
    // Invalid table, return empty table
    return new Table({ rows: [] });
  }

  const headerCells = splitTableRow(lines[0]);
  const rows: InstanceType<typeof TableRow>[] = [];

  // Header row (with center alignment and bold formatting)
  rows.push(
    new TableRow({
      children: headerCells.map(
        (cell) => {
          const cellText = cell.trim();
          const textRuns = parseInlineFormatting(cellText);
          
          // Make all runs bold (in addition to any existing formatting)
          textRuns.forEach(run => {
            (run as any).bold = true;
          });
          
          return new TableCell({
            children: [
              new Paragraph({
                children: textRuns,
                alignment: AlignmentType.CENTER,
              }),
            ],
          });
        }
      ),
    }),
  );

  // Data rows (skip separator at index 1) with inline formatting
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    rows.push(
      new TableRow({
        children: cells.map(
          (cell) => {
            const cellText = cell.trim();
            const textRuns = parseInlineFormatting(cellText);
            
            return new TableCell({
              children: [
                new Paragraph({
                  children: textRuns,
                }),
              ],
            });
          }
        ),
      }),
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

/**
 * Split markdown table row into cells
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutBorders = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutBorders.split('|');
}

