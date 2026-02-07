/**
 * DOCX Utility Functions
 * Helper functions for DOCX operations and data transformation
 */

import fs from 'fs/promises';
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
 * Generate the next versioned output path for a DOCX modification.
 * Strips any existing `_vN` suffix from the input, then finds the next
 * available version number by scanning the directory.
 *
 * Example: demo.docx   → demo_v1.docx  (first edit)
 *          demo.docx   → demo_v2.docx  (second edit, _v1 already exists)
 *          demo_v1.docx → demo_v2.docx (strips _v1, finds next)
 */
export async function generateOutputPath(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  let baseName = path.basename(filePath, ext);

  // Strip any trailing _vN suffixes (e.g., demo_v1_v1 → demo)
  baseName = baseName.replace(/(_v\d+)+$/, '');

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

