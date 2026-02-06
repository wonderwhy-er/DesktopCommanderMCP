/**
 * DOCX Error Handling
 * Centralized error classes and error handling utilities
 */

/**
 * Base error class for DOCX operations
 */
export class DocxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DocxError';
    Error.captureStackTrace?.(this, DocxError);
  }

  /**
   * Convert error to JSON for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
    };
  }
}

/**
 * Error codes for DOCX operations
 */
export enum DocxErrorCode {
  INVALID_DOCX = 'INVALID_DOCX',
  INVALID_PATH = 'INVALID_PATH',
  OPERATION_FAILED = 'OPERATION_FAILED',
  UNKNOWN_OPERATION = 'UNKNOWN_OPERATION',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',
  DOCX_CREATE_FAILED = 'DOCX_CREATE_FAILED',
  DOCX_EDIT_FAILED = 'DOCX_EDIT_FAILED',
  DOCX_READ_FAILED = 'DOCX_READ_FAILED',
  INVALID_IMAGE_FILE = 'INVALID_IMAGE_FILE',
  INVALID_IMAGE_DATA_URL = 'INVALID_IMAGE_DATA_URL',
  GET_INFO_FAILED = 'GET_INFO_FAILED',
}

/**
 * Wrap async operations with error context
 */
export async function withErrorContext<T>(
  operation: () => Promise<T>,
  errorCode: DocxErrorCode | string,
  context?: Record<string, unknown>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DocxError) {
      throw error;
    }
    
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxError(message, errorCode, {
      ...context,
      originalError: error instanceof Error ? error.stack : String(error),
    });
  }
}


