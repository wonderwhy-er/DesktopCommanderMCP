/**
 * Image Extractor
 * Utilities for extracting and handling images from DOCX files
 */

import path from 'path';
import type { ZipArchive } from './zip-reader.js';
import { readZipFileBuffer } from './zip-reader.js';
import type { DocxRelationship } from '../types.js';

/**
 * Get MIME type from file extension or target path
 */
export function getMimeTypeForTarget(target: string): string {
  const ext = path.extname(target).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Extract all images from a DOCX ZIP archive
 */
export function extractImagesFromZip(
  zip: ZipArchive,
  relMap: Map<string, DocxRelationship>
): Map<string, Buffer> {
  const images = new Map<string, Buffer>();
  
  for (const [relId, rel] of relMap.entries()) {
    if (!rel.type.includes('/image')) continue;
    
    const targetPath = rel.target.startsWith('word/')
      ? rel.target
      : `word/${rel.target.replace(/^\/?/, '')}`;
    
    const imgBuffer = readZipFileBuffer(zip, targetPath);
    if (imgBuffer) {
      images.set(relId, imgBuffer);
    }
  }
  
  return images;
}

/**
 * Resolve image relationship ID from drawing or pict element
 */
export function resolveImageRelId(element: Element): string | null {
  // Try drawing element first (newer format)
  const blips = element.getElementsByTagName('a:blip');
  for (let i = 0; i < blips.length; i++) {
    const blip = blips[i];
    const relId = blip.getAttribute('r:embed') || blip.getAttribute('embed');
    if (relId) return relId;
  }
  
  // Try pict element (older format)
  const imagedata = element.getElementsByTagName('v:imagedata');
  for (let i = 0; i < imagedata.length; i++) {
    const relId = imagedata[i].getAttribute('r:id') || imagedata[i].getAttribute('id');
    if (relId) return relId;
  }
  
  return null;
}

