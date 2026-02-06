/**
 * DOCX Validation Utilities
 * 
 * Provides validation functions for DOCX operations, inputs, and data.
 * 
 * @module docx/validators
 */

import { DocxError, DocxErrorCode } from './errors.js';
import { isDocxPath } from './utils.js';

/**
 * Validate DOCX file path
 * @param path - Path to validate
 * @throws {DocxError} If path is invalid
 */
export function validateDocxPath(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new DocxError(
      'DOCX path must be a non-empty string',
      DocxErrorCode.INVALID_PATH,
      { path }
    );
  }

  const normalizedPath = path.trim();
  if (!normalizedPath) {
    throw new DocxError(
      'DOCX path cannot be empty',
      DocxErrorCode.INVALID_PATH,
      { path }
    );
  }

  if (!isDocxPath(normalizedPath)) {
    throw new DocxError(
      'Invalid DOCX path: must end with .docx',
      DocxErrorCode.INVALID_PATH,
      { path: normalizedPath }
    );
  }
}

/**
 * Validate operations array
 * @param operations - Operations array to validate
 * @throws {DocxError} If operations array is invalid
 */
export function validateOperations(operations: unknown[]): void {
  if (!Array.isArray(operations)) {
    throw new DocxError(
      'Operations must be an array',
      DocxErrorCode.OPERATION_FAILED,
      { operations }
    );
  }

  if (operations.length === 0) {
    throw new DocxError(
      'Operations array cannot be empty',
      DocxErrorCode.OPERATION_FAILED,
      { operations }
    );
  }
}

/**
 * Validate HTML content
 * @param html - HTML content to validate
 * @param allowEmpty - Whether empty HTML is allowed (default: false)
 * @throws {DocxError} If HTML is invalid
 */
export function validateHtml(html: string, allowEmpty: boolean = false): void {
  if (typeof html !== 'string') {
    throw new DocxError(
      'HTML content must be a string',
      DocxErrorCode.OPERATION_FAILED,
      { htmlType: typeof html }
    );
  }

  if (!allowEmpty && !html.trim()) {
    throw new DocxError(
      'HTML content cannot be empty',
      DocxErrorCode.OPERATION_FAILED,
      { htmlLength: html.length }
    );
  }
}

/**
 * Validate CSS selector
 * @param selector - Selector to validate
 * @throws {DocxError} If selector is invalid
 */
export function validateSelector(selector: string): void {
  if (!selector || typeof selector !== 'string') {
    throw new DocxError(
      'Selector must be a non-empty string',
      DocxErrorCode.OPERATION_FAILED,
      { selector }
    );
  }

  const trimmed = selector.trim();
  if (!trimmed) {
    throw new DocxError(
      'Selector cannot be empty',
      DocxErrorCode.OPERATION_FAILED,
      { selector }
    );
  }
}

/**
 * Validate image dimensions
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @throws {DocxError} If dimensions are invalid
 */
export function validateImageDimensions(width?: number, height?: number): void {
  if (width !== undefined) {
    if (typeof width !== 'number' || width <= 0 || !Number.isFinite(width)) {
      throw new DocxError(
        'Image width must be a positive finite number',
        DocxErrorCode.INVALID_IMAGE_FILE,
        { width }
      );
    }
  }

  if (height !== undefined) {
    if (typeof height !== 'number' || height <= 0 || !Number.isFinite(height)) {
      throw new DocxError(
        'Image height must be a positive finite number',
        DocxErrorCode.INVALID_IMAGE_FILE,
        { height }
      );
    }
  }
}

