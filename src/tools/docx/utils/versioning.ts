/**
 * Versioning Utilities
 *
 * Generates versioned output paths for DOCX modifications.
 *
 * @module docx/utils/versioning
 */

import path from 'path';

/**
 * Generate the versioned output path for a DOCX modification.
 *
 * Strategy:
 * - If input is original file (no _vN): Always create _v1 (overwrite if exists)
 * - If input is already versioned (_vN): Increment to _v(N+1) (overwrite if exists)
 *
 * This ensures ONE final versioned file per update request, not multiple versions.
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
  
  // Check if input file already has a version suffix (_vN)
  const versionMatch = baseName.match(/_v(\d+)$/);
  
  if (versionMatch) {
    // Input is already versioned — increment version number
    const currentVersion = parseInt(versionMatch[1], 10);
    const nextVersion = currentVersion + 1;
    const cleanBaseName = baseName.replace(/_v\d+$/, '');
    return path.join(dir, `${cleanBaseName}_v${nextVersion}${ext}`);
  } else {
    // Input is original file — always use _v1 (will overwrite if exists)
    return path.join(dir, `${baseName}_v1${ext}`);
  }
}

