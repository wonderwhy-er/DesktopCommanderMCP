import { z } from 'zod';

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

/**
 * Resolve a Zod schema down to the field map of its underlying object schema,
 * unwrapping public Zod 4 wrappers defensively.
 * Returns null when the schema is not (and does not wrap) a plain object schema,
 * in which case we cannot determine the supported parameters and must not warn.
 */
function getObjectShape(schema: unknown): Record<string, unknown> | null {
  let current = schema;
  for (let i = 0; current && i < 10; i++) {
    if (current instanceof z.ZodObject) return current.shape;
    if (current instanceof z.ZodPipe) {
      // A Zod 4 preprocess is a pipe; its output schema is what validates the
      // parsed object, matching the Zod 3 ZodEffects.schema behavior.
      current = current.out;
    } else if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault
      || current instanceof z.ZodCatch
      || current instanceof z.ZodPrefault
      || current instanceof z.ZodNonOptional
      || current instanceof z.ZodReadonly
    ) {
      current = current.unwrap();
    } else {
      return null;
    }
  }
  return null;
}

/** List the parameter names a tool schema accepts (empty array if it takes none). */
export function getSupportedParams(schema: unknown): string[] {
  const shape = getObjectShape(schema);
  return shape ? Object.keys(shape) : [];
}

/**
 * Return the names of top-level keys in `args` that the schema does not accept.
 * Returns [] when args is not a plain object or the schema's params can't be
 * determined (so we never warn on something we can't reason about).
 */
export function detectUnsupportedParams(args: unknown, schema: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const shape = getObjectShape(schema);
  if (shape === null) return [];
  const supported = new Set(Object.keys(shape));
  return Object.keys(args as Record<string, unknown>).filter((k) => !supported.has(k));
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
