/**
 * DOCX element builders — Single Responsibility: build XML elements
 * for paragraphs, tables, and images.
 *
 * These builders are shared between create.ts and ops/ modules to
 * eliminate code duplication and ensure consistency.
 */

export { buildParagraph } from './paragraph.js';
export { buildTable } from './table.js';
export { buildImageElement } from './image.js';
export { escapeXml, escapeXmlAttr } from './utils.js';

