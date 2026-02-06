/**
 * ZIP File Reader
 * Utilities for reading files from DOCX ZIP archives
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PizZip = require('pizzip');

export type ZipArchive = InstanceType<typeof PizZip>;

/**
 * Create a ZIP archive from a buffer
 */
export function createZipFromBuffer(buffer: Buffer): ZipArchive {
  return new PizZip(buffer);
}

/**
 * Read a text file from a ZIP archive
 */
export function readZipFileText(zip: ZipArchive, filePath: string): string | null {
  const file = zip.file(filePath);
  if (!file) return null;
  
  if (typeof file.asText === 'function') {
    return file.asText();
  }
  
  if (typeof file.asBinary === 'function') {
    return Buffer.from(file.asBinary(), 'binary').toString('utf8');
  }
  
  return null;
}

/**
 * Read a binary file from a ZIP archive as Buffer
 */
export function readZipFileBuffer(zip: ZipArchive, filePath: string): Buffer | null {
  const file = zip.file(filePath);
  if (!file) return null;
  
  if (typeof file.asUint8Array === 'function') {
    return Buffer.from(file.asUint8Array());
  }
  
  if (typeof file.asNodeBuffer === 'function') {
    return file.asNodeBuffer();
  }
  
  if (typeof file.asBinary === 'function') {
    return Buffer.from(file.asBinary(), 'binary');
  }
  
  return null;
}

/**
 * Check if a file exists in the ZIP archive
 */
export function zipFileExists(zip: ZipArchive, filePath: string): boolean {
  return zip.file(filePath) !== null;
}

