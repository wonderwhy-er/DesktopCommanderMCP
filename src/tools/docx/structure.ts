/**
 * DOCX Structure Parser and Builder
 * 
 * Provides structure-preserving parsing and building of DOCX files.
 * This approach maintains tables, images, and formatting at the DOCX element level,
 * avoiding lossy markdown round-trips.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// @ts-ignore
import * as docx from 'docx';

const { Document, Packer } = docx as any;

import type { DocxStructure, DocxElement } from './types.js';

// Re-export types for convenience
export type { DocxElement, DocxStructure };
import { DocxError, DocxErrorCode, withErrorContext } from './errors.js';
import {
  createZipFromBuffer,
  readZipFileText,
} from './parsers/zip-reader.js';
import {
  parseXml,
  getElementChildren,
  extractRelationshipMap,
  getHeadingLevelFromParagraph,
} from './parsers/xml-parser.js';
import { extractImagesFromZip } from './parsers/image-extractor.js';
import { parseParagraphElement } from './parsers/paragraph-parser.js';
import { parseTableElement } from './parsers/table-parser.js';

/**
 * Parse a DOCX file into structured elements that can be manipulated and rebuilt
 * 
 * @param buffer - DOCX file buffer
 * @returns Structured representation of the DOCX document
 * @throws {DocxError} If the DOCX file is invalid or cannot be parsed
 */
export async function parseDocxStructure(buffer: Buffer): Promise<DocxStructure> {
  return withErrorContext(
    async () => {
      const zip = createZipFromBuffer(buffer);
      const documentXml = readZipFileText(zip, 'word/document.xml');
      
      if (!documentXml) {
        throw new DocxError(
          'Invalid DOCX file: word/document.xml not found',
          DocxErrorCode.INVALID_DOCX,
          {}
        );
      }

      const relsXml = readZipFileText(zip, 'word/_rels/document.xml.rels');
      const relMap = extractRelationshipMap(relsXml);
      
      // Extract all images
      const images = extractImagesFromZip(zip, relMap);

      // Parse document body
      const doc = parseXml(documentXml);
      const body = doc.getElementsByTagName('w:body')[0];
      
      if (!body) {
        throw new DocxError(
          'Invalid DOCX file: <w:body> not found',
          DocxErrorCode.INVALID_DOCX_XML,
          {}
        );
      }

      // Parse all elements
      const elements: DocxElement[] = [];
      const children = getElementChildren(body);

      for (const child of children) {
        const nodeName = child.nodeName;
        
        if (nodeName === 'w:p') {
          const headingLevel = getHeadingLevelFromParagraph(child);
          const para = parseParagraphElement(child, images, headingLevel);
          
          if (para) {
            if (headingLevel) {
              elements.push({
                type: 'heading',
                level: headingLevel,
                content: para,
              });
            } else {
              elements.push({
                type: 'paragraph',
                content: para,
              });
            }
          }
        } else if (nodeName === 'w:tbl') {
          const table = parseTableElement(child, images);
          
          if (table) {
            elements.push({
              type: 'table',
              content: table,
            });
          }
        }
      }

      return {
        elements,
        images,
        relationships: relMap,
      };
    },
    DocxErrorCode.DOCX_READ_FAILED,
    { bufferSize: buffer.length }
  );
}

/**
 * Build a DOCX file from structured elements
 * 
 * @param structure - Structured DOCX representation
 * @returns Buffer containing the DOCX file
 * @throws {DocxError} If document building fails
 */
export async function buildDocxFromStructure(structure: DocxStructure): Promise<Buffer> {
  return withErrorContext(
    async () => {
      const children = structure.elements.map(el => el.content);
      
      const doc = new Document({
        sections: [{
          properties: {},
          children: children,
        }],
      });

      return await Packer.toBuffer(doc);
    },
    DocxErrorCode.DOCX_CREATE_FAILED,
    { elementCount: structure.elements.length }
  );
}
