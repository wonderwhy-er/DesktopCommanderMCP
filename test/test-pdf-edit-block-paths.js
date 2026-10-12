/**
 * edit_block on a PDF (range + page operations) must keep to the allowed folders.
 *
 * Its PDF path wrote to options.outputPath and read an insert's sourcePdfPath
 * without the allowed-folder check write_pdf applies to the same fields: a PDF
 * could be written anywhere, and any PDF read, whatever allowedDirectories said.
 * Expected: the call is refused with the allowed-folder message, nothing is
 * written outside, and the PDF is unchanged.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { handleEditBlock } from '../dist/tools/edit.js';
import { SAMPLE_PDF, SIMPLE_PDF, answerText, pdfWorkspace } from './helpers/pdf.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

async function run() {
  if (!isTestHome()) {
    skip('edit_block PDF paths: run through the test runner (it uses a temporary home)');
    return true;
  }
  const ws = pdfWorkspace('pdf-edit-paths');
  const originalAllowed = await configManager.getValue('allowedDirectories');
  const failures = [];
  const check = async (name, test) => {
    try { await test(); console.log(`✓ ${name}`); } catch (error) { failures.push(name); console.log(`✗ ${name}\n  ${error.message}`); }
  };
  try {
    await configManager.setValue('allowedDirectories', [ws.allowed]);

    await check('edit_block on a PDF: options.outputPath outside the allowed folders is refused', async () => {
      const pdf = path.join(ws.allowed, 'a.pdf');
      fs.copyFileSync(SAMPLE_PDF, pdf);
      const before = fs.readFileSync(pdf);
      const outside = path.join(ws.outside, 'b.pdf');
      const result = await handleEditBlock({ file_path: pdf, range: 'p', content: [{ type: 'delete', pageIndexes: [0] }], options: { outputPath: outside } });
      const text = answerText(result);
      assert(!fs.existsSync(outside), `edit_block wrote a PDF outside the allowed folders (answer: ${text})`);
      assert(result.isError && /Path not allowed/.test(text), `edit_block should refuse with the allowed-folder message, answered: ${text}`);
      assert(fs.readFileSync(pdf).equals(before), 'the refused edit changed the PDF');
    });

    await check('edit_block on a PDF: an insert whose sourcePdfPath is outside the allowed folders is refused', async () => {
      const pdf = path.join(ws.allowed, 'c.pdf');
      fs.copyFileSync(SAMPLE_PDF, pdf);
      const before = fs.readFileSync(pdf);
      const source = path.join(ws.outside, 'source.pdf');
      fs.copyFileSync(SIMPLE_PDF, source);
      const result = await handleEditBlock({ file_path: pdf, range: 'p', content: [{ type: 'insert', pageIndex: 0, sourcePdfPath: source }] });
      const text = answerText(result);
      assert(fs.readFileSync(pdf).equals(before), `edit_block inserted pages from a PDF outside the allowed folders (answer: ${text})`);
      assert(result.isError && /Path not allowed/.test(text), `edit_block should refuse with the allowed-folder message, answered: ${text}`);
    });

    await check('edit_block on a PDF: a page operation inside the allowed folders still works', async () => {
      const pdf = path.join(ws.allowed, 'd.pdf');
      fs.copyFileSync(SAMPLE_PDF, pdf);
      const out = path.join(ws.allowed, 'd-out.pdf');
      const result = await handleEditBlock({ file_path: pdf, range: 'p', content: [{ type: 'delete', pageIndexes: [0] }], options: { outputPath: out } });
      assert(!result.isError && fs.existsSync(out), `the edit inside the allowed folders failed: ${answerText(result)}`);
    });
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed ?? []);
    ws.cleanup();
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of 3 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
