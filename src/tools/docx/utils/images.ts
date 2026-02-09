/**
 * Image Utilities
 *
 * Pure functions for MIME type detection and image path handling.
 *
 * @module docx/utils/images
 */

import path from 'path';
import { isDataUrl } from './paths.js';

/** Derive MIME type from a file extension or data URL. Returns `null` if unrecognised. */
export function getMimeType(source: string): string | null {
  if (isDataUrl(source)) {
    const match = source.match(/^data:([^;]+);/);
    return match ? match[1] : null;
  }

  const MIME_BY_EXT: Readonly<Record<string, string>> = {
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

