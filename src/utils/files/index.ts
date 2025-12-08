/**
 * File handling system
 * Exports all file handlers, interfaces, and utilities
 */

// Base interfaces and types
export * from './base.js';

// Factory function
export { getFileHandler, isExcelFile, isImageFile } from './factory.js';

// File handlers
export { TextFileHandler } from './text.js';
export { ImageFileHandler } from './image.js';
export { BinaryFileHandler } from './binary.js';
export { ExcelFileHandler } from './excel.js';
