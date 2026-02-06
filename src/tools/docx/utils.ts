/**
 * DOCX Utility Functions
 * Helper functions for DOCX operations, validation, and data transformation
 */

import fs from 'fs/promises';
import path from 'path';

// Import types from docx for image handling
// @ts-ignore - docx library has incomplete type definitions but exports exist at runtime
import * as docx from 'docx';

const {
  ImageRun,
} = docx as any;

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
 * Build a markdown table from a 2D array of rows
 */
export function buildMarkdownTableFromRows(rows: string[][]): string {
  if (!rows || rows.length === 0) {
    return '';
  }

  const header = rows[0];
  const dataRows = rows.slice(1);

  const headerLine = `| ${header.join(' | ')} |`;
  const separatorLine = `| ${header.map(() => '---').join(' | ')} |`;
  const dataLines = dataRows.map((r) => `| ${r.join(' | ')} |`);

  return [headerLine, separatorLine, ...dataLines].join('\n');
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
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Normalize line endings to \n
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Split markdown into lines, preserving empty lines
 */
export function splitMarkdownLines(markdown: string): string[] {
  return normalizeLineEndings(markdown).split('\n');
}

/**
 * Validate DOCX file path
 */
export function isDocxPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.docx');
}

/**
 * Extract file name without extension
 */
export function getFileNameWithoutExtension(filePath: string): string {
  const basename = path.basename(filePath);
  return basename.replace(/\.docx$/i, '');
}

// Re-export error handling from errors module
export { DocxError, DocxErrorCode, withErrorContext } from './errors.js';

/**
 * Image data prepared for DOCX embedding
 */
export interface PreparedImage {
  buffer: Buffer;
  width?: number;
  height?: number;
  altText: string;
  mimeType: string;
}

/**
 * Load and prepare an image for DOCX embedding
 * Handles both local files and data URLs
 * 
 * @param imagePath - Path to image file or data URL
 * @param altText - Alternative text for the image
 * @param baseDir - Base directory for resolving relative paths
 * @returns Prepared image data ready for embedding
 */
export async function prepareImageForDocx(
  imagePath: string,
  altText: string = '',
  baseDir?: string
): Promise<PreparedImage> {
  return withErrorContext(
    async () => {
      let buffer: Buffer;
      let mimeType = 'image/png'; // Default

      // Handle data URL
      if (isDataUrl(imagePath)) {
        const parsed = parseDataUrl(imagePath);
        if (!parsed) {
          throw new DocxError(
            'Invalid data URL format',
            DocxErrorCode.INVALID_IMAGE_DATA_URL,
            { imagePath: imagePath.substring(0, 50) }
          );
        }
        buffer = parsed;
        
        // Extract MIME type from data URL
        const mimeMatch = imagePath.match(/^data:([^;]+);/);
        if (mimeMatch) {
          mimeType = mimeMatch[1];
        }
      } else {
        // Handle file path
        const resolved = resolveImagePath(imagePath, baseDir);
        
        // Validate image file
        const validation = await validateImageFile(resolved);
        if (!validation.valid) {
          throw new DocxError(
            validation.error || 'Invalid image file',
            DocxErrorCode.INVALID_IMAGE_FILE,
            { imagePath: resolved }
          );
        }

        // Read image file
        try {
          buffer = await fs.readFile(resolved);
        } catch (error) {
          throw new DocxError(
            `Failed to read image file: ${error instanceof Error ? error.message : String(error)}`,
            DocxErrorCode.IMAGE_READ_FAILED,
            { imagePath: resolved }
          );
        }

        // Determine MIME type from file extension
        const ext = path.extname(resolved).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
          '.webp': 'image/webp',
        };
        mimeType = mimeTypes[ext] || 'image/png';
      }

      return {
        buffer,
        altText: altText || path.basename(imagePath),
        mimeType,
        // Default dimensions - can be customized
        width: 600,
        height: 400,
      };
    },
    DocxErrorCode.IMAGE_PREPARATION_FAILED,
    { imagePath }
  );
}

/**
 * Create an ImageRun instance for embedding in DOCX paragraphs
 * This is a lower-level utility for direct image insertion
 * 
 * @param imageData - Prepared image data
 * @returns ImageRun instance ready to be added to a paragraph
 */
export function createImageRun(imageData: PreparedImage): any {
  try {
    return new ImageRun({
      data: imageData.buffer,
      transformation: {
        width: imageData.width || 600,
        height: imageData.height || 400,
      },
      altText: {
        title: imageData.altText,
        description: imageData.altText,
      },
    });
  } catch (error) {
    throw new DocxError(
      `Failed to create image run: ${error instanceof Error ? error.message : String(error)}`,
      DocxErrorCode.IMAGE_RUN_CREATION_FAILED
    );
  }
}

