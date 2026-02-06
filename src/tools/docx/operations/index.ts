import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { DocxEditOptions, DocxOperation } from '../types.js';
import { DocxError, DocxErrorCode, withErrorContext } from '../errors.js';
import { parseDocxStructure, buildDocxFromStructure } from '../structure.js';
import { replaceTextInDocxXml } from './xml-replacer.js';
import { applyOperationToStructure } from './operation-handlers.js';
import {
  DocxReplaceTextOperationSchema,
  DocxOperationSchema,
} from '../../schemas.js';

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

      const allTextReplacements = operations.every(op => op.type === 'replaceText');

      if (allTextReplacements && operations.length > 0) {
        let modifiedBuffer: Buffer = await fs.readFile(docxPath);
        
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          const validatedOp = DocxReplaceTextOperationSchema.parse(op);
          const tempPath = `${docxPath}.tmp${i}`;
          
          await fs.writeFile(tempPath, modifiedBuffer);
          modifiedBuffer = await replaceTextInDocxXml(
            tempPath,
            validatedOp.search,
            validatedOp.replace
          );
          
          await fs.unlink(tempPath).catch(() => {});
        }
        
        return modifiedBuffer;
      }

      const docxBuffer = await fs.readFile(docxPath);
      const structure = await parseDocxStructure(docxBuffer);

      for (const op of operations) {
        const validatedOp = DocxOperationSchema.parse(op);
        await applyOperationToStructure(structure, validatedOp, baseDir);
      }
      
      return await buildDocxFromStructure(structure);
    },
    DocxErrorCode.DOCX_EDIT_FAILED,
    { path: docxPath, operationCount: operations.length }
  );
}

