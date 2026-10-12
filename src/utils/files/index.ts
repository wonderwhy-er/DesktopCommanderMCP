/**
 * File handling system
 * Exports all file handlers, interfaces, and utilities
 */

// Base interfaces and types
export * from './base.js';

// Factory function
export { getFileHandler, isExcelFile, isImageFile, preloadFileSupport, stillLoadingError } from './factory.js';
export type { FileAction } from './factory.js';

// File handlers
export { TextFileHandler } from './text.js';
export { ImageFileHandler, isImageAnswer } from './image.js';
export { BinaryFileHandler } from './binary.js';
export { ExcelFileHandler, exceljsPackage } from './excel.js';
export { pizzipPackage } from './docx.js';
