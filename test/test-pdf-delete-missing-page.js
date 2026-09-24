/**
 * write_pdf deleting a page that doesn't exist must say so, not "Successfully wrote".
 *
 * Out-of-range page indexes were dropped silently: the call answered success
 * and wrote the PDF unchanged. Expected: the same "Invalid page index" error an
 * insert gives, and nothing written; valid indexes (negative from the end) still work.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { handleWritePdf } from '../dist/handlers/filesystem-handlers.js';
import { SAMPLE_PDF, answerText, pageSizes, pdfWorkspace } from './helpers/pdf.js';
import { runIfMain } from './helpers/run-if-main.js';

async function run() {
  const ws = pdfWorkspace('pdf-delete-missing');
  const source = path.join(ws.allowed, 'in.pdf');
  fs.copyFileSync(SAMPLE_PDF, source); // 22 pages
  const failures = [];
  const check = async (name, test) => {
    try { await test(); console.log(`✓ ${name}`); } catch (error) { failures.push(name); console.log(`✗ ${name}\n  ${error.message}`); }
  };
  try {
    await check('write_pdf delete of page index 99 in a 22-page PDF is an error, nothing written', async () => {
      const out = path.join(ws.allowed, 'missing.pdf');
      const result = await handleWritePdf({ path: source, outputPath: out, content: [{ type: 'delete', pageIndexes: [99] }] });
      const text = answerText(result);
      assert(result.isError && /Invalid page index/.test(text), `deleting a page that doesn't exist answered: ${text}`);
      assert(!fs.existsSync(out), 'a PDF was written although the delete failed');
    });
    await check('write_pdf delete of pages 0 and -1 in a 22-page PDF leaves 20 pages', async () => {
      const out = path.join(ws.allowed, 'valid.pdf');
      const result = await handleWritePdf({ path: source, outputPath: out, content: [{ type: 'delete', pageIndexes: [0, -1] }] });
      assert(!result.isError, `a valid delete failed: ${answerText(result)}`);
      assert.strictEqual((await pageSizes(out)).length, 20, 'a valid delete left the wrong number of pages');
    });
  } finally {
    ws.cleanup();
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of 2 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
