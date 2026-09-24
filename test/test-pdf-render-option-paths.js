/**
 * The render options that name a file must keep to the allowed folders.
 *
 * md-to-pdf reads a stylesheet path, a script path and the highlight style
 * (a file name under highlight.js's styles) from disk into the page it
 * renders, from write_pdf's options or the markdown's front matter, without
 * the allowed-folder check: a script in the page could then write that file
 * into the PDF. Expected: a file outside the allowed folders is refused with
 * the allowed-folder message; a stylesheet inside them and the default
 * highlight style still apply.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { configManager } from '../dist/config-manager.js';
import { handleWritePdf } from '../dist/handlers/filesystem-handlers.js';
import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';
import { answerText, isNoChrome, pdfWorkspace } from './helpers/pdf.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const SECRET = 'OUTSIDE-SECRET-4711';
const INSIDE = 'INSIDE-TEXT-0815';
// Writes the page's style sheets and the value a script left into the page's text
const COPY_INTO_PAGE = "document.body.insertAdjacentText('beforeend', [...document.querySelectorAll('style')].map((s) => s.textContent).join(' ') + ' ' + String(window.leak))";

// The folder md-to-pdf resolves highlight_style in
const mdToPdfRequire = createRequire(createRequire(import.meta.url).resolve('md-to-pdf'));
const HIGHLIGHT_STYLES = path.resolve(path.dirname(mdToPdfRequire.resolve('highlight.js')), '..', 'styles');

async function pdfText(file) {
  const parsed = await parsePdfToMarkdown(file);
  return parsed.pages.map((page) => page.text).join('\n');
}

async function run() {
  if (!isTestHome()) {
    skip('PDF render option paths: run through the test runner (it uses a temporary home)');
    return true;
  }
  const ws = pdfWorkspace('pdf-render-option-paths');
  fs.writeFileSync(path.join(ws.outside, 'secret.css'), `/* ${SECRET} */`);
  fs.writeFileSync(path.join(ws.outside, 'secret.js'), `window.leak = '${SECRET}';`);
  fs.writeFileSync(path.join(ws.allowed, 'inside.css'), `/* ${INSIDE} */`);
  const originalAllowed = await configManager.getValue('allowedDirectories');
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
  const render = async (name, args) => {
    const pdf = path.join(ws.allowed, `${name}.pdf`);
    const result = await handleWritePdf({ path: pdf, ...args });
    const text = answerText(result);
    if (isNoChrome(text)) throw new Error(text);
    return { pdf, result, text };
  };
  const expectRefused = async (name, args, what) => {
    const { pdf, result, text } = await render(name, args);
    const leaked = fs.existsSync(pdf) && (await pdfText(pdf)).includes(SECRET);
    assert(!leaked, `write_pdf wrote a file from outside the allowed folders into the PDF (${what}; answer: ${text})`);
    assert(result.isError && /Path not allowed/.test(text), `write_pdf should refuse ${what} with the allowed-folder message, answered: ${text}`);
  };
  try {
    await configManager.setValue('allowedDirectories', [ws.allowed]);

    await check('write_pdf: options.stylesheet outside the allowed folders is refused', async () => {
      await expectRefused('stylesheet', { content: '# Report', options: { stylesheet: [path.join(ws.outside, 'secret.css')], script: [{ content: COPY_INTO_PAGE }] } }, 'options.stylesheet');
    });

    await check('write_pdf: a front matter script path outside the allowed folders is refused', async () => {
      const content = `---\nscript:\n  - path: ${JSON.stringify(path.join(ws.outside, 'secret.js'))}\n  - content: ${JSON.stringify(COPY_INTO_PAGE)}\n---\n# Report`;
      await expectRefused('script', { content }, 'a front matter script path');
    });

    await check('write_pdf: a highlight_style leading outside the allowed folders is refused', async () => {
      const highlightStyle = path.relative(HIGHLIGHT_STYLES, path.join(ws.outside, 'secret'));
      await expectRefused('highlight', { content: '# Report', options: { highlight_style: highlightStyle, script: [{ content: COPY_INTO_PAGE }] } }, 'options.highlight_style');
    });

    await check('write_pdf: a stylesheet inside the allowed folders and the default highlight style still apply', async () => {
      const { pdf, result, text } = await render('inside', { content: '# Report\n\n```js\nconst a = 1;\n```', options: { stylesheet: [path.join(ws.allowed, 'inside.css')], script: [{ content: COPY_INTO_PAGE }] } });
      assert(!result.isError && fs.existsSync(pdf), `the render failed: ${text}`);
      const pageText = await pdfText(pdf);
      assert(pageText.includes(INSIDE), 'a stylesheet inside the allowed folders was not applied');
      assert(/\.hljs/.test(pageText), 'the default highlight style was not applied');
    });
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed ?? []);
    ws.cleanup();
  }
  if (noChrome) {
    skip(`PDF render option paths: no Chrome to launch (${noChrome})`);
    return true;
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of 4 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
