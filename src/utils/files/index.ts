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
// Type-only: exporting ExcelFileHandler as a value here loads exceljs on its
// own, independently of the factory. Callers get a handler from getFileHandler().
export type { ExcelFileHandler } from './excel.js';
