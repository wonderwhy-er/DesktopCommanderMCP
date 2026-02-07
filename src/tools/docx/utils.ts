/**
 * DOCX Utility Functions
 * Helper functions for DOCX operations and data transformation
 */

import path from 'path';

/**
 * Check if a string is a valid data URL
 */
export function isDataUrl(src: string): boolean {
  return src.startsWith('data:') && src.includes('base64,');
}

/**
 * Check if a source is a URL (http/https)
 */
export function isUrl(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://');
}

/**
 * Resolve image path relative to base directory
 */
export function resolveImagePath(imagePath: string, baseDir?: string): string {
  if (path.isAbsolute(imagePath) || isUrl(imagePath) || isDataUrl(imagePath)) {
    return imagePath;
  }
  
  if (!baseDir) {
    return path.resolve(imagePath);
  }
  
  return path.join(baseDir, imagePath);
}

/**
 * Escape special regex characters for literal string matching
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get MIME type from file extension or data URL
 */
export function getMimeType(source: string): string | null {
  if (isDataUrl(source)) {
    const match = source.match(/^data:([^;]+);/);
    return match ? match[1] : null;
  }
  
  const ext = path.extname(source).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  
  return mimeTypes[ext] || null;
}

/**
 * Check if file path ends with .docx extension
 */
export function isDocxPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.docx');
}

/**
 * Generate the output path for a DOCX modification.
 * Always produces `{baseName}_v1.docx` — strips any existing `_vN` suffix first
 * so that repeated edits always target the same single file (no cascading).
 *
 * Example: demo.docx       → demo_v1.docx
 *          demo_v1.docx    → demo_v1.docx  (same file, will be overwritten)
 *          demo_v1_v1.docx → demo_v1.docx  (cleans up cascading legacy names)
 */
export function generateOutputPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  let baseName = path.basename(filePath, ext);

  // Strip any trailing _vN suffixes (e.g., demo_v1_v1 → demo)
  baseName = baseName.replace(/(_v\d+)+$/, '');

  return path.join(dir, `${baseName}_v1${ext}`);
}

/**
 * Convert markdown to HTML if the content appears to be markdown.
 * If content already contains HTML tags, returns it as-is.
 * Used by both filesystem.ts and DocxFileHandler to handle markdown input gracefully.
 */
export function convertToHtmlIfNeeded(content: string): string {
  const hasMarkdown = /^#{1,6}\s|^\*\*|^\[.*\]\(|^\|.*\|/.test(content);
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(content);
  
  if (hasMarkdown && !hasHtmlTags) {
    let html = content;
    html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.split('\n\n').map(p => p.trim()).filter(p => p).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
    return html;
  }
  
  return content;
}

