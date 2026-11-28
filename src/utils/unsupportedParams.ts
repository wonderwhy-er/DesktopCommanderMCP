import type { ZodObject } from 'zod';

/**
 * Utility for detecting parameters a caller sent that a tool's Zod schema does
 * not accept.
 *
 * Zod's default `z.object()` silently strips unknown keys, so a model that
 * invents a parameter (e.g. `view_range`) gets a normal-looking response with no
 * signal that its input was ignored. These helpers let the dispatcher surface a
 * corrective warning instead.
 *
 * Detection is top-level only. That is sufficient here because none of the tool
 * arg schemas use a top-level `.passthrough()`/catchall — free-form fields
 * (`options`, `params`, `pdfOptions`) are named keys whose contents are
 * intentionally unvalidated.
 */

/** List the top-level parameter names a tool supports. */
export function getSupportedParams(schema: ZodObject): string[] {
  return Object.keys(schema.shape);
}

/** Return top-level keys that the tool's schema would strip. */
export function detectUnsupportedParams(args: unknown, schema: ZodObject): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.keys(args).filter((key) => !Object.prototype.hasOwnProperty.call(schema.shape, key));
}

/** Build the corrective warning string shown to the model. */
export function buildUnsupportedParamsWarning(
  toolName: string,
  unsupported: string[],
  supported: string[],
): string {
  const ignored = unsupported.join(', ');
  const supportedList = supported.length > 0 ? supported.join(', ') : '(none)';
  return `You sent parameters not supported by this tool, which were ignored: ${ignored}. `
    + `Supported parameters for ${toolName}: ${supportedList}.`;
}
