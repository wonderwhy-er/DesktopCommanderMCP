/**
 * Recognisers for failures worth telling apart. Prefer an error type, then a
 * code, and only parse text when the source is foreign and nothing else
 * distinguishes it.
 */

/**
 * Windows refuses to rename onto, or open for writing, a path another process
 * holds open. It reports that as one of these, which on either platform also
 * carry genuine permission failures.
 */
const SHARING_VIOLATION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isSharingViolation(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && SHARING_VIOLATION_CODES.has(code);
}
