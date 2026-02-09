/**
 * DOCX file manipulation tools
 * Provides utilities for reading, writing, and modifying DOCX files
 * while preserving formatting and styles
 */

export { readDocx, extractTextFromDocx, getDocxMetadata, extractBodyXml } from './read.js';
export { writeDocx, modifyDocxContent, replaceBodyXml } from './write.js';
export type { DocxMetadata, DocxParagraph, DocxRun, DocxModification } from './types.js';

