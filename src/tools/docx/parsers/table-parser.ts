/**
 * Table Parser
 * Parses DOCX table elements to DOCX library Table objects
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// @ts-ignore
import * as docx from 'docx';

const { Table, TableRow, TableCell, Paragraph, WidthType } = docx as any;

import type { DocxTable } from '../types.js';
import { parseParagraphElement } from './paragraph-parser.js';

/**
 * Parse a table element to DOCX Table
 */
export function parseTableElement(
  table: Element,
  images: Map<string, Buffer>
): DocxTable | null {
  const rows: InstanceType<typeof TableRow>[] = [];
  const rowNodes = table.getElementsByTagName('w:tr');

  for (let i = 0; i < rowNodes.length; i++) {
    const rowNode = rowNodes[i];
    const row = parseTableRow(rowNode, images);
    if (row) {
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    return null;
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

/**
 * Parse a table row element
 */
function parseTableRow(
  rowNode: Element,
  images: Map<string, Buffer>
): InstanceType<typeof TableRow> | null {
  const cells: InstanceType<typeof TableCell>[] = [];
  const cellNodes = rowNode.getElementsByTagName('w:tc');

  for (let j = 0; j < cellNodes.length; j++) {
    const cellNode = cellNodes[j];
    const cell = parseTableCell(cellNode, images);
    if (cell) {
      cells.push(cell);
    }
  }

  if (cells.length === 0) {
    return null;
  }

  return new TableRow({
    children: cells,
  });
}

/**
 * Parse a table cell element
 */
function parseTableCell(
  cellNode: Element,
  images: Map<string, Buffer>
): InstanceType<typeof TableCell> | null {
  const cellParagraphs: InstanceType<typeof Paragraph>[] = [];
  const paragraphNodes = cellNode.getElementsByTagName('w:p');

  for (let k = 0; k < paragraphNodes.length; k++) {
    const paraNode = paragraphNodes[k];
    const para = parseParagraphElement(paraNode, images, null);
    
    if (para) {
      cellParagraphs.push(para);
    }
  }

  // Ensure at least one paragraph per cell
  if (cellParagraphs.length === 0) {
    cellParagraphs.push(new Paragraph({ text: '' }));
  }

  return new TableCell({
    children: cellParagraphs,
  });
}

