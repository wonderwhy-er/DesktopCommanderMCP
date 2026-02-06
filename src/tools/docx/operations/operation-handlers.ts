import type { DocxStructure } from '../types.js';
import type {
  DocxAppendMarkdownOperation,
  DocxInsertTableOperation,
  DocxInsertImageOperation,
  DocxOperation,
} from '../types.js';
import { DocxError, DocxErrorCode } from '../errors.js';
import { createDocxFromMarkdown } from '../builders/markdown-builder.js';
import { parseDocxStructure } from '../structure.js';
import {
  buildMarkdownTableFromRows,
  prepareImageForDocx,
  createImageRun,
} from '../utils.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// @ts-ignore
import * as docx from 'docx';

const { Paragraph, AlignmentType } = docx as any;

export async function applyOperationToStructure(
  structure: DocxStructure,
  op: DocxOperation,
  baseDir: string
): Promise<void> {
  switch (op.type) {
    case 'replaceText':
      throw new DocxError(
        'replaceText should use XML manipulation',
        DocxErrorCode.UNSUPPORTED_OPERATION
      );
    
    case 'appendMarkdown':
      await handleAppendMarkdown(structure, op, baseDir);
      break;
    
    case 'insertTable':
      await handleInsertTable(structure, op);
      break;
    
    case 'insertImage':
      await handleInsertImage(structure, op, baseDir);
      break;
    
    default:
      throw new DocxError(
        `Unknown operation: ${(op as any).type}`,
        DocxErrorCode.UNKNOWN_OPERATION
      );
  }
}

async function handleAppendMarkdown(
  structure: DocxStructure,
  op: DocxAppendMarkdownOperation,
  baseDir: string
): Promise<void> {
  if (!op.markdown?.trim()) return;

  const appendBuffer = await createDocxFromMarkdown(op.markdown, { baseDir });
  const appendStructure = await parseDocxStructure(appendBuffer);
  
  structure.elements.push(...appendStructure.elements);
  
  for (const [relId, imgBuffer] of appendStructure.images.entries()) {
    structure.images.set(relId, imgBuffer);
  }
  
  for (const [relId, rel] of appendStructure.relationships.entries()) {
    structure.relationships.set(relId, rel);
  }
}

async function handleInsertTable(
  structure: DocxStructure,
  op: DocxInsertTableOperation
): Promise<void> {
  let tableMarkdown = op.markdownTable;
  
  if (!tableMarkdown && op.rows?.length) {
    tableMarkdown = buildMarkdownTableFromRows(op.rows);
  }
  
  if (!tableMarkdown?.trim()) return;

  const tableBuffer = await createDocxFromMarkdown(tableMarkdown, {});
  const tableStructure = await parseDocxStructure(tableBuffer);
  
  const tableElement = tableStructure.elements.find(el => el.type === 'table');
  if (tableElement) {
    structure.elements.push(tableElement);
  } else {
    structure.elements.push(...tableStructure.elements);
  }
}

async function handleInsertImage(
  structure: DocxStructure,
  op: DocxInsertImageOperation,
  baseDir: string
): Promise<void> {
  if (!op.imagePath?.trim()) return;

  const imageData = await prepareImageForDocx(op.imagePath, op.altText || '', baseDir);
  const imageRun = createImageRun(imageData);
  
  const paragraph = new Paragraph({
    children: [imageRun],
    alignment: AlignmentType.CENTER,
  });
  
  structure.elements.push({ type: 'paragraph', content: paragraph });
}

