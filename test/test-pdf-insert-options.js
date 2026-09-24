/**
 * write_pdf's page operations honor the render options they are given.
 *
 * Markdown inserted into an existing PDF was always rendered with the original
 * first page's size: an insert's own pdfOptions (declared in the schema) and the
 * call's options (write_pdf's `options`) were never read. Expected: an insert's
 * pdfOptions, else the call's options.pdf_options, set the inserted page's
 * format; with neither, the inserted page keeps the original page's size.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { handleWritePdf } from '../dist/handlers/filesystem-handlers.js';
import { SIMPLE_PDF, answerText, isNoChrome, pageSizes, pdfWorkspace } from './helpers/pdf.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const A3_LANDSCAPE = '1191x842';
const ORIGINAL = '596x842'; // SIMPLE_PDF's page (A4 portrait)

async function run() {
  const ws = pdfWorkspace('pdf-insert-options');
  const source = path.join(ws.allowed, 'in.pdf');
  fs.copyFileSync(SIMPLE_PDF, source);
  const failures = [];
  let noChrome;
  const insertedPage = async (name, args) => {
    const out = path.join(ws.allowed, `${name}.pdf`);
    const result = await handleWritePdf({ path: source, outputPath: out, ...args });
    const text = answerText(result);
    if (isNoChrome(text)) { noChrome = text; return undefined; }
    assert(!result.isError && fs.existsSync(out), `write_pdf failed: ${text}`);
    return (await pageSizes(out))[0];
  };
  const check = async (name, test) => {
    if (noChrome) return;
    try { await test(); if (!noChrome) console.log(`✓ ${name}`); } catch (error) { failures.push(name); console.log(`✗ ${name}\n  ${error.message}`); }
  };
  try {
    await check('an insert\'s pdfOptions set the inserted page\'s format', async () => {
      const size = await insertedPage('insert-options', { content: [{ type: 'insert', pageIndex: 0, markdown: '# A', pdfOptions: { format: 'A3', landscape: true } }] });
      if (size !== undefined) assert.strictEqual(size, A3_LANDSCAPE, `insert.pdfOptions {format: A3, landscape: true} gave an inserted page of ${size}`);
    });
    await check('write_pdf options.pdf_options set an inserted page\'s format', async () => {
      const size = await insertedPage('call-options', { content: [{ type: 'insert', pageIndex: 0, markdown: '# A' }], options: { pdf_options: { format: 'A3', landscape: true } } });
      if (size !== undefined) assert.strictEqual(size, A3_LANDSCAPE, `options.pdf_options {format: A3, landscape: true} gave an inserted page of ${size}`);
    });
    await check('with no options, an inserted page keeps the original page\'s size', async () => {
      const size = await insertedPage('no-options', { content: [{ type: 'insert', pageIndex: 0, markdown: '# A' }] });
      if (size !== undefined) assert.strictEqual(size, ORIGINAL, `with no options the inserted page is ${size}`);
    });
  } finally {
    ws.cleanup();
  }
  if (noChrome) {
    skip(`write_pdf insert options: no Chrome to launch (${noChrome})`);
    return true;
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of 3 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
