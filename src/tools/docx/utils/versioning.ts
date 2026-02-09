/**
 * Versioning Utilities
 *
 * Generates versioned output paths for DOCX modifications.
 *
 * @module docx/utils/versioning
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Generate the versioned output path for a DOCX modification.
 *
 * Strategy:
 * - Look at existing sibling files `{base}_vN.ext` and pick the next N.
 * - If no versions exist yet, start at `_v1`.
 * - If some versions exist, always return the highest existing + 1.
 *
 * This gives you `version_i` per update over time **even if** every request
 * always uses the original file as `filePath`, while still producing only
 * ONE output file per request (callers invoke this once per edit).
 *
 * Examples:
 *   demo.docx     → demo_v1.docx  (always _v1, overwrites if exists)
 *   demo_v1.docx  → demo_v2.docx  (increments to _v2, overwrites if exists)
 *   demo_v2.docx  → demo_v3.docx  (increments to _v3, overwrites if exists)
 */
export async function generateOutputPath(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  // Normalise base to strip any existing _vN suffix so that
  // passing in either "demo.docx" or "demo_v3.docx" still
  // continues the same version sequence.
  const cleanBase = baseName.replace(/_v\d+$/, '');

  try {
    const entries = await fs.readdir(dir);

    let maxVersion = 0;
    const versionRegex = new RegExp(`^${cleanBase}_v(\\d+)${ext.replace('.', '\\.')}$`, 'i');

    for (const entry of entries) {
      const match = entry.match(versionRegex);
      if (match) {
        const v = parseInt(match[1], 10);
        if (!Number.isNaN(v) && v > maxVersion) {
          maxVersion = v;
        }
      }
    }

    const nextVersion = maxVersion + 1 || 1;
    return path.join(dir, `${cleanBase}_v${nextVersion}${ext}`);
  } catch {
    // If we can't list the directory for any reason, fall back to _v1.
    return path.join(dir, `${cleanBase}_v1${ext}`);
  }
}

