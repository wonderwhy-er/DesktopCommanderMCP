/**
 * write_file with mode "append" on an existing PDF must not replace it.
 *
 * The PDF handler ignored the mode: it rendered the new markdown and wrote it
 * over the file, answering "Successfully appended", so a 22-page PDF became a
 * 1-page one. PDFs can't be appended to as text; the call must refuse, as it
 * does for DOCX, and leave the file as it was.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { handleWriteFile } from '../dist/handlers/filesystem-handlers.js';
import { SAMPLE_PDF, answerText, isNoChrome, pdfWorkspace } from './helpers/pdf.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

async function run() {
  if (!isTestHome()) {
    skip('write_file append on a PDF: run through the test runner (it uses a temporary home)');
    return true;
  }
  const ws = pdfWorkspace('pdf-append');
  try {
    const pdf = path.join(ws.allowed, 'report.pdf');
    fs.copyFileSync(SAMPLE_PDF, pdf);
    const before = fs.readFileSync(pdf);

    const result = await handleWriteFile({ path: pdf, content: '# more', mode: 'append' });
    const text = answerText(result);
    if (isNoChrome(text)) {
      skip(`write_file append on a PDF: no Chrome to launch (${text})`);
      return true;
    }
    assert(fs.readFileSync(pdf).equals(before), `write_file with mode "append" replaced the existing PDF (answer: ${text})`);
    assert(result.isError, `write_file with mode "append" on a PDF should refuse, answered: ${text}`);
    assert(/append not supported/i.test(text), `the refusal should say appending isn't supported, answered: ${text}`);
    console.log('✓ write_file with mode "append" on a PDF refuses and leaves the file as it was');
    return true;
  } catch (error) {
    console.log(`✗ write_file with mode "append" on a PDF refuses and leaves the file as it was\n  ${error.message}`);
    return false;
  } finally {
    ws.cleanup();
  }
}

runIfMain(import.meta.url, run);

export default run;
