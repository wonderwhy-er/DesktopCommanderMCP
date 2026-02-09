/**
 * HTML Escaping Utilities
 *
 * Pure functions for escaping HTML special characters and regex patterns.
 *
 * @module docx/utils/escaping
 */

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

/** Escape HTML special characters in text content. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] || ch);
}

/** Escape a value for safe use inside an HTML attribute (double- and single-quoted). */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Escape special regex characters for literal string matching. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

