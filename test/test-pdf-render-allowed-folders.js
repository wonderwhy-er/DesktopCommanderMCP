/**
 * Rendering markdown to PDF must keep to the allowed folders.
 *
 * The render serves the page's files (images, iframes, ...) from options.basedir,
 * or from the working folder when none is given, without the allowed-folder
 * check: markdown could embed any file of that folder into a PDF written inside
 * the allowed folders. Expected: a basedir outside the allowed folders is
 * refused with the allowed-folder message, and a file outside them is not
 * served even from the working folder; files inside them still are.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { handleWritePdf } from '../dist/handlers/filesystem-handlers.js';
import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';
import { answerText, isNoChrome, pdfWorkspace } from './helpers/pdf.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const SECRET = 'OUTSIDE-SECRET-4711';
const INSIDE = 'INSIDE-TEXT-0815';

async function pdfText(file) {
  const parsed = await parsePdfToMarkdown(file);
  return parsed.pages.map((page) => page.text).join('\n');
}

async function run() {
  if (!isTestHome()) {
    skip('PDF render folders: run through the test runner (it uses a temporary home)');
    return true;
  }
  const ws = pdfWorkspace('pdf-render-folders');
  fs.writeFileSync(path.join(ws.outside, 'secret.txt'), SECRET);
  const served = path.join(ws.allowed, 'served');
  fs.mkdirSync(served);
  fs.writeFileSync(path.join(served, 'inside.txt'), INSIDE);
  const originalAllowed = await configManager.getValue('allowedDirectories');
  const originalCwd = process.cwd();
  const failures = [];
  let noChrome;
  const check = async (name, test) => {
    if (noChrome) return;
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      if (isNoChrome(error)) { noChrome = error.message; return; }
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  };
  const render = async (args) => {
    const result = await handleWritePdf(args);
    if (isNoChrome(answerText(result))) throw new Error(answerText(result));
    return result;
  };
  try {
    await configManager.setValue('allowedDirectories', [ws.allowed]);
    const iframe = (file) => `<iframe src="${file}" width="600" height="120"></iframe>`;

    await check('write_pdf: options.basedir outside the allowed folders is refused', async () => {
      const pdf = path.join(ws.allowed, 'basedir.pdf');
      const result = await render({ path: pdf, content: iframe('secret.txt'), options: { basedir: ws.outside } });
      const text = answerText(result);
      const leaked = fs.existsSync(pdf) && (await pdfText(pdf)).includes(SECRET);
      assert(!leaked, `write_pdf embedded a file from outside the allowed folders (answer: ${text})`);
      assert(result.isError && /Path not allowed/.test(text), `write_pdf should refuse the basedir with the allowed-folder message, answered: ${text}`);
    });

    await check('write_pdf: the working folder outside the allowed folders serves none of its files', async () => {
      process.chdir(ws.outside);
      try {
        const pdf = path.join(ws.allowed, 'cwd.pdf');
        const result = await render({ path: pdf, content: iframe('secret.txt') });
        assert(!result.isError && fs.existsSync(pdf), `the render failed: ${answerText(result)}`);
        assert(!(await pdfText(pdf)).includes(SECRET), 'write_pdf embedded a file from the working folder, outside the allowed folders');
      } finally {
        process.chdir(originalCwd);
      }
    });

    await check('write_pdf: a basedir inside the allowed folders still serves its files', async () => {
      const pdf = path.join(ws.allowed, 'inside.pdf');
      const result = await render({ path: pdf, content: iframe('inside.txt'), options: { basedir: served } });
      assert(!result.isError && fs.existsSync(pdf), `the render failed: ${answerText(result)}`);
      assert((await pdfText(pdf)).includes(INSIDE), 'a file inside the allowed folders was not embedded');
    });
  } finally {
    process.chdir(originalCwd);
    await configManager.setValue('allowedDirectories', originalAllowed ?? []);
    ws.cleanup();
  }
  if (noChrome) {
    skip(`PDF render folders: no Chrome to launch (${noChrome})`);
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
