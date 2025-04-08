import { ServerResult } from './types.js';

/**
 * Creates a standard error response for tools
 * @param message The error message
 * @returns A ServerResult with the error message
 */
export function createErrorResponse(message: string): ServerResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
