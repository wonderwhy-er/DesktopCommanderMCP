/**
 * Path and URL Utilities
 *
 * Pure functions for path detection, resolution, and URL validation.
 *
 * @module docx/utils/paths
 */

import path from 'path';

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

/** Resolve an image path relative to a base directory (pass-through for absolute, URL, and data URLs). */
export function resolveImagePath(imagePath: string, baseDir?: string): string {
  if (path.isAbsolute(imagePath) || isUrl(imagePath) || isDataUrl(imagePath)) {
    return imagePath;
  }
  return baseDir ? path.join(baseDir, imagePath) : path.resolve(imagePath);
}

