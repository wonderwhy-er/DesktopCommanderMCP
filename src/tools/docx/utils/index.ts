/**
 * DOCX Utilities — Re-exports
 *
 * Centralized re-exports for all utility modules.
 *
 * @module docx/utils
 */

// Escaping
export { escapeHtml, escapeHtmlAttribute, escapeRegExp } from './escaping.js';

// Paths & URLs
export { isDataUrl, isUrl, isDocxPath, resolveImagePath } from './paths.js';

// Images
export { getMimeType } from './images.js';

// Markdown
export { convertToHtmlIfNeeded } from './markdown.js';

// Versioning
export { generateOutputPath } from './versioning.js';

