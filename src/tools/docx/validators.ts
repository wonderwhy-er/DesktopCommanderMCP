/**
 * DOCX Validation Utilities
 *
 * Input validation for paths, operations arrays, and image dimensions.
 *
 * @module docx/validators
 */

import { DocxError, DocxErrorCode } from './errors.js';
import { isDocxPath } from './utils.js';

/** Validate that a DOCX file path is a non-empty string ending in `.docx`. */
export function validateDocxPath(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new DocxError('DOCX path must be a non-empty string', DocxErrorCode.INVALID_PATH, { path });
  }

  const normalised = path.trim();
  if (!normalised) {
    throw new DocxError('DOCX path cannot be empty', DocxErrorCode.INVALID_PATH, { path });
  }
  if (!isDocxPath(normalised)) {
    throw new DocxError('Invalid DOCX path: must end with .docx', DocxErrorCode.INVALID_PATH, { path: normalised });
  }
}

/** Validate that an operations array is a non-empty array. */
export function validateOperations(operations: unknown[]): void {
  if (!Array.isArray(operations)) {
    throw new DocxError('Operations must be an array', DocxErrorCode.OPERATION_FAILED, { operations });
  }
  if (operations.length === 0) {
    throw new DocxError('Operations array cannot be empty', DocxErrorCode.OPERATION_FAILED, { operations });
  }
}

/** Validate optional image width and height (must be positive and finite). */
export function validateImageDimensions(width?: number, height?: number): void {
  if (width !== undefined && (typeof width !== 'number' || width <= 0 || !Number.isFinite(width))) {
    throw new DocxError('Image width must be a positive finite number', DocxErrorCode.INVALID_IMAGE_FILE, { width });
  }
  if (height !== undefined && (typeof height !== 'number' || height <= 0 || !Number.isFinite(height))) {
    throw new DocxError('Image height must be a positive finite number', DocxErrorCode.INVALID_IMAGE_FILE, { height });
  }
}
