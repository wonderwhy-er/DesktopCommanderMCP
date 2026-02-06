import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// @ts-ignore
import * as docx from 'docx';

const {
  AlignmentType,
  Document,
  HeadingLevel,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  Packer,
} = docx as any;

import type { DocxBuildOptions } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import {
  normalizeLineEndings,
  prepareImageForDocx,
  createImageRun,
} from '../utils.js';

export async function createDocxFromMarkdown(
  markdown: string,
  options: DocxBuildOptions = {},
): Promise<Buffer> {
  return withErrorContext(
    async () => {
      const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
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

        // 1) Markdown table detection
        const isHeader = isTableHeaderLine(line);
        const hasSeparator = i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]);
        
        if (isHeader && hasSeparator) {
          const tableLines: string[] = [line];
          i++;
          tableLines.push(lines[i]); // Add separator line
          i++;
          
          // Collect all subsequent table rows
          while (i < lines.length) {
            const nextLine = lines[i].trim();
            if (!nextLine || !isTableRowLine(nextLine)) {
              break;
            }
            tableLines.push(nextLine);
            i++;
          }

          try {
            const table = createTableFromMarkdown(tableLines);
            children.push(table);
          } catch (error) {
            console.error('[DOCX Build] Failed to create table:', error);
            // Fallback: add table lines as plain text
            for (const tableLine of tableLines) {
              children.push(new Paragraph({ text: tableLine }));
            }
          }
          continue;
        }

        // 2) Images
        const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (imageMatch) {
          const altText = imageMatch[1] || '';
          const src = imageMatch[2];
          
          try {
            const imageData = await prepareImageForDocx(src, altText, baseDir);
            const imageRun = createImageRun(imageData);
            const paragraph = new Paragraph({
              children: [imageRun],
              alignment: AlignmentType.CENTER,
            });
            children.push(paragraph);
          } catch (error) {
            console.warn(`Failed to embed image ${src}:`, error);
            children.push(new Paragraph({
              text: `[Image: ${altText || src}]`,
            }));
          }
          i++;
          continue;
        }

        // 3) Headings
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

        // 4) Regular paragraphs
        const textRuns = parseInlineFormatting(rawLine);
        const paragraph = new Paragraph({
          children: textRuns,
        });
        
        children.push(paragraph);
        i++;
      }

      const doc = new Document({
        sections: [{
          properties: {},
          children: children,
        }],
      });

      return await Packer.toBuffer(doc);
    },
    DocxErrorCode.DOCX_CREATE_FAILED,
    { markdownLength: markdown.length }
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function isTableHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  
  const startsWithPipe = trimmed.startsWith('|');
  const endsWithPipe = trimmed.endsWith('|');
  const pipeCount = (trimmed.match(/\|/g) || []).length;
  
  if (startsWithPipe && endsWithPipe) {
    return pipeCount >= 2;
  }
  return pipeCount >= 1;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  
  let content = trimmed;
  if (content.startsWith('|')) content = content.substring(1);
  if (content.endsWith('|')) content = content.substring(0, content.length - 1);
  
  const parts = content.split('|');
  let validParts = 0;
  
  for (const part of parts) {
    const cleaned = part.trim();
    if (cleaned.length === 0) continue;
    if (/^:?-+:?$/.test(cleaned)) {
      validParts++;
    } else {
      return false;
    }
  }
  
  return validParts > 0;
}

function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (isTableSeparatorLine(trimmed)) return false;
  const pipeCount = (trimmed.match(/\|/g) || []).length;
  return pipeCount >= 1;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  let withoutBorders = trimmed;
  if (withoutBorders.startsWith('|')) {
    withoutBorders = withoutBorders.substring(1);
  }
  if (withoutBorders.endsWith('|')) {
    withoutBorders = withoutBorders.substring(0, withoutBorders.length - 1);
  }
  return withoutBorders.split('|').map(cell => cell.trim());
}

function createTableFromMarkdown(lines: string[]): InstanceType<typeof Table> {
  if (lines.length < 2) {
    return new Table({ rows: [] });
  }

  const headerCells = splitTableRow(lines[0]);
  const rows: InstanceType<typeof TableRow>[] = [];

  // Header row
  rows.push(
    new TableRow({
      children: headerCells.map((cell) => {
        const textRuns = parseInlineFormatting(cell.trim());
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
      }),
    }),
  );

  // Data rows (skip separator at index 1)
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    rows.push(
      new TableRow({
        children: cells.map((cell) => {
          const textRuns = parseInlineFormatting(cell.trim());
          return new TableCell({
            children: [
              new Paragraph({
                children: textRuns,
              }),
            ],
          });
        }),
      }),
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

function parseInlineFormatting(text: string): InstanceType<typeof TextRun>[] {
  const runs: InstanceType<typeof TextRun>[] = [];
  let currentText = '';
  let i = 0;
  
  while (i < text.length) {
    // Check for **bold**
    if (text.substring(i, i + 2) === '**') {
      if (currentText) {
        runs.push(new TextRun({ text: currentText }));
        currentText = '';
      }
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
      if (currentText) {
        runs.push(new TextRun({ text: currentText }));
        currentText = '';
      }
      const closeIndex = text.indexOf('*', i + 1);
      if (closeIndex !== -1) {
        const italicText = text.substring(i + 1, closeIndex);
        runs.push(new TextRun({ text: italicText, italics: true }));
        i = closeIndex + 1;
        continue;
      }
    }
    
    currentText += text[i];
    i++;
  }
  
  if (currentText) {
    runs.push(new TextRun({ text: currentText }));
  }
  
  return runs.length > 0 ? runs : [new TextRun({ text: text })];
}

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

