import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Returns true when the calling module is the script Node was started with
 * (e.g. `node test/test-foo.js`). Call it as `isMainModule(import.meta.url)`.
 *
 * Compares real filesystem paths instead of URL strings, so it works on
 * Windows (drive letters, backslashes), with spaces or non-ASCII characters in
 * the path (URL percent-encoding), and through symlinks (macOS /tmp -> /private/tmp).
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;

  const modulePath = fileURLToPath(importMetaUrl);
  const entryPath = path.resolve(entry);
  try {
    return fs.realpathSync.native(modulePath) === fs.realpathSync.native(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}

/** What skip() returns: a check that ends with `return skip(…)` is counted as skipped, not passed. */
export const SKIPPED = Symbol('skipped');

/**
 * Records a check that couldn't run because a precondition is missing on this
 * machine (e.g. no Python). The file still passes, but run-all-tests.js reads
 * these records from DC_TEST_SKIP_FILE and lists them in its summary, so a
 * skip is never reported as a plain pass. Returns SKIPPED: a check ends with
 * `return skip('…')`, and a file's own summary counts it as skipped.
 */
export function skip(reason) {
  console.log(`⚠️  SKIPPED: ${reason}`);
  if (process.env.DC_TEST_SKIP_FILE) {
    fs.appendFileSync(process.env.DC_TEST_SKIP_FILE, `${reason.replace(/\r?\n/g, ' ')}\n`);
  }
  return SKIPPED;
}

/**
 * Runs a test file's entry function when the file is executed directly, and
 * exits with the result: 1 if it throws or returns false, 0 otherwise.
 * Usage: `runIfMain(import.meta.url, runTests);`
 */
export async function runIfMain(importMetaUrl, run) {
  if (!isMainModule(importMetaUrl)) return;

  try {
    const result = await run();
    process.exit(result === false ? 1 : 0);
  } catch (error) {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  }
}
