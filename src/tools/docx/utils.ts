/**
 * DOCX Utility Functions
 *
 * Shared helpers used across the DOCX module: path resolution, string escaping,
 * MIME detection, versioned output paths, and lightweight markdown-to-HTML conversion.
 *
 * @module docx/utils
 */

import fs from 'fs/promises';
import path from 'path';

// ─── String Escaping ─────────────────────────────────────────────────────────

const HTML_ESCAPE_MAP: Record<string, string> = {
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

// ─── URL / Path Detection ────────────────────────────────────────────────────

/** Check if a string is a base64 data URL. */
export function isDataUrl(src: string): boolean {
  return src.startsWith('data:') && src.includes('base64,');
}

/** Check if a string is an HTTP(S) URL. */
export function isUrl(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://');
}

/** Check if a file path has a `.docx` extension. */
export function isDocxPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.docx');
}

// ─── Image Helpers ───────────────────────────────────────────────────────────

/** Resolve an image path relative to a base directory (pass-through for absolute, URL, and data URLs). */
export function resolveImagePath(imagePath: string, baseDir?: string): string {
  if (path.isAbsolute(imagePath) || isUrl(imagePath) || isDataUrl(imagePath)) {
    return imagePath;
  }
  return baseDir ? path.join(baseDir, imagePath) : path.resolve(imagePath);
}

/** Derive MIME type from a file extension or data URL. Returns `null` if unrecognised. */
export function getMimeType(source: string): string | null {
  if (isDataUrl(source)) {
    const match = source.match(/^data:([^;]+);/);
    return match ? match[1] : null;
  }

  const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };

  return MIME_BY_EXT[path.extname(source).toLowerCase()] || null;
}

// ─── Versioned Output Path ───────────────────────────────────────────────────

/**
 * Generate the next versioned output path for a DOCX modification.
 *
 * Strips any existing `_vN` suffix, then finds the first unused version number.
 *
 *   demo.docx     → demo_v1.docx  (first edit)
 *   demo.docx     → demo_v2.docx  (if _v1 exists)
 *   demo_v1.docx  → demo_v2.docx  (strips _v1, finds next)
 */
export async function generateOutputPath(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext).replace(/(_v\d+)+$/, '');

  let version = 1;
  let outputPath: string;
  do {
    outputPath = path.join(dir, `${baseName}_v${version}${ext}`);
    try {
      await fs.access(outputPath);
      version++;
    } catch {
      break; // File doesn't exist — use this version
    }
  } while (version < 1000);

  return outputPath;
}

// ─── Lightweight Markdown → HTML ─────────────────────────────────────────────

/**
 * Convert simple markdown to HTML if the content appears to be markdown.
 * If it already contains HTML tags it is returned unchanged.
 *
 * Used by `filesystem.ts` and the DOCX file-handler for backward compatibility.
 */
export function convertToHtmlIfNeeded(content: string): string {
  const hasMarkdown = /^#{1,6}\s|^\*\*|^\[.*\]\(|^\|.*\|/.test(content);
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(content);

  if (!hasMarkdown || hasHtmlTags) return content;

  let html = content;
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
