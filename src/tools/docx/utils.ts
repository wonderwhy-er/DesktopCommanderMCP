/**
 * DOCX Utility Functions
 * Helper functions for DOCX operations, validation, and data transformation
 */

import fs from 'fs/promises';
import path from 'path';

import { DocxError, DocxErrorCode, withErrorContext } from './errors.js';

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
 * Parse data URL into buffer
 * @returns Buffer if successful, null if invalid
 */
export function parseDataUrl(dataUrl: string): Buffer | null {
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
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
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate image file
 */
export async function validateImageFile(imagePath: string): Promise<{ valid: boolean; error?: string }> {
  if (isDataUrl(imagePath)) {
    const buffer = parseDataUrl(imagePath);
    if (!buffer) {
      return { valid: false, error: 'Invalid data URL format' };
    }
    return { valid: true };
  }
  
  if (isUrl(imagePath)) {
    // For URLs, we'll validate during fetch
    return { valid: true };
  }
  
  const exists = await fileExists(imagePath);
  if (!exists) {
    return { valid: false, error: `Image file not found: ${imagePath}` };
  }
  
  // Check file extension
  const ext = path.extname(imagePath).toLowerCase();
  const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'];
  if (!validExtensions.includes(ext)) {
    return { valid: false, error: `Unsupported image format: ${ext}` };
  }
  
  return { valid: true };
}

/**
 * Escape special regex characters for literal string matching
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate markdown table format
 */
export function isValidMarkdownTable(markdown: string): boolean {
  const lines = markdown.trim().split('\n');
  if (lines.length < 2) return false;
  
  // Check header row
  const headerLine = lines[0].trim();
  if (!headerLine.startsWith('|') || !headerLine.endsWith('|')) return false;
  
  // Check separator row
  const separatorLine = lines[1].trim();
  if (!separatorLine.startsWith('|') || !separatorLine.endsWith('|')) return false;
  
  // Verify separator contains dashes
  const separatorPattern = /^(\|\s*:?-{2,}\s*:?\s*)+\|$/;
  if (!separatorPattern.test(separatorLine)) return false;
  
  return true;
}

/**
 * Parse markdown table into 2D array
 */
export function parseMarkdownTable(markdown: string): string[][] | null {
  if (!isValidMarkdownTable(markdown)) {
    return null;
  }
  
  const lines = markdown.trim().split('\n');
  const rows: string[][] = [];
  
  for (let i = 0; i < lines.length; i++) {
    // Skip separator line
    if (i === 1) continue;
    
    const line = lines[i].trim();
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
    
    rows.push(cells);
  }
  
  return rows;
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
 * Validate DOCX file path
 */
export function isDocxPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.docx');
}

// Re-export error handling from errors module
export { DocxError, DocxErrorCode, withErrorContext } from './errors.js';

