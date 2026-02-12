/**
 * DOCX file manipulation tools — barrel exports.
 */

// Patch-based tools (read_docx / write_docx)
export { readDocxOutline } from './read.js';
export { writeDocxPatched } from './write.js';
export { createDocxNew } from './create.js';

// Types
export type {
    DocxContentStructure,
    DocxContentItem,
    DocxContentParagraph,
    DocxContentTable,
    DocxContentImage,
} from './types.js';

// Legacy functions (used by read_file, write_file, edit_block handlers)
export { readDocx, extractTextFromDocx, getDocxMetadata, extractBodyXml } from './read.js';
export { writeDocx, modifyDocxContent, replaceBodyXml } from './modify.js';

// Types
export type {
    DocxMetadata,
    DocxParagraph,
    DocxRun,
    DocxModification,
    ParagraphOutline,
    TableOutline,
    ImageOutline,
    ReadDocxResult,
    WriteDocxStats,
    WriteDocxResult,
    BodySnapshot,
    DocxOp,
    OpResult,
} from './types.js';
