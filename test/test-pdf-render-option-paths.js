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
 *
 * The render reads the files the check approved: a stylesheet, highlight
 * style, script or file served to the page behind a link that is changed to
 * point outside right after its check is still read where the check found it.
 * An error from the render still names each file as it was given.
 */
import assert from 'assert';
import fs from 'fs';
import fsp from 'fs/promises';
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

/** A link to a folder: a junction on Windows (no admin rights or Developer Mode needed) */
const linkFolder = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const removeLink = (link) => (process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link));
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Makes fs.realpath (which validatePath resolves links with) change each of
 * `links` to point at `target` right after it first resolves a path through
 * it: the allowed-folder check sees the old target, anything reading the path
 * later the new one. restore() puts fs.realpath back; `pending` lists the
 * links never checked.
 */
function retargetAfterCheck(links, target) {
  const realpath = fsp.realpath;
  const pending = new Set(links);
  fsp.realpath = async function (file, ...rest) {
    const resolved = await realpath.call(this, file, ...rest);
    const requested = path.resolve(String(file));
    for (const link of pending) {
      if (samePath(requested, link) || samePath(requested.slice(0, link.length + 1), link + path.sep)) {
        pending.delete(link);
        removeLink(link);
        linkFolder(target, link);
      }
    }
    return resolved;
  };
  return { pending, restore: () => { fsp.realpath = realpath; } };
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

    await check('write_pdf: files behind a link changed right after their check are read where the check found them', async () => {
      // Each file exists twice: where the links point when checked, and outside the allowed folders
      const kinds = ['STYLE', 'HIGHLIGHT', 'SCRIPT', 'SERVED'];
      const checked = path.join(ws.allowed, 'checked');
      const elsewhere = path.join(ws.outside, 'elsewhere');
      for (const [folder, mark] of [[checked, 'CHECKED'], [elsewhere, 'RETARGETED']]) {
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'style.css'), `/* ${mark}STYLE7731 */`);
        fs.writeFileSync(path.join(folder, 'hl.css'), `/* ${mark}HIGHLIGHT7731 */`);
        fs.writeFileSync(path.join(folder, 'leak.js'), `window.leak = '${mark}SCRIPT7731';`);
        fs.writeFileSync(path.join(folder, 'note.txt'), `${mark}SERVED7731`);
      }
      const links = ['css-link', 'hl-link', 'js-link', 'served-link'].map((name) => path.join(ws.allowed, name));
      for (const link of links) linkFolder(checked, link);
      const [cssLink, hlLink, jsLink] = links;
      const retarget = retargetAfterCheck(links, elsewhere);
      let rendered;
      try {
        rendered = await render('retargeted', {
          content: '# Report\n\n<iframe src="served-link/note.txt"></iframe>',
          options: {
            basedir: ws.allowed,
            stylesheet: [path.join(cssLink, 'style.css')],
            highlight_style: path.relative(HIGHLIGHT_STYLES, path.join(hlLink, 'hl')),
            script: [{ path: path.join(jsLink, 'leak.js') }, { content: COPY_INTO_PAGE }],
          },
        });
      } finally {
        retarget.restore();
      }
      const { pdf, result, text } = rendered;
      assert(!result.isError && fs.existsSync(pdf), `the render failed: ${text}`);
      assert.deepStrictEqual([...retarget.pending].map((link) => path.basename(link)), [], 'the render never checked these links');
      const pageText = await pdfText(pdf);
      const leaked = kinds.filter((kind) => pageText.includes(`RETARGETED${kind}7731`));
      assert.deepStrictEqual(leaked, [], `the render read these from outside the allowed folders, through a link changed after its check: ${leaked.join(', ')}`);
      const applied = kinds.filter((kind) => pageText.includes(`CHECKED${kind}7731`));
      assert.deepStrictEqual(applied, kinds, `the files the check approved should apply: ${pageText.slice(0, 400)}`);
    });

    // The render reads each file where the check found it (links resolved; on macOS a temporary
    // file given as /var/... is read as /private/var/...), but the answer names it as it was given
    await check('write_pdf: a render error names the stylesheet, script and highlight style as given, not where their link leads', async () => {
      const real = path.join(ws.allowed, 'real-for-errors');
      const link = path.join(ws.allowed, 'link-for-errors');
      fs.mkdirSync(real);
      linkFolder(real, link);
      const missing = [
        ['stylesheet', { stylesheet: [path.join(link, 'missing.css')] }, path.join(link, 'missing.css')],
        ['script', { script: [{ path: path.join(link, 'missing.js') }] }, path.join(link, 'missing.js')],
        ['highlight_style', { highlight_style: path.relative(HIGHLIGHT_STYLES, path.join(link, 'missing')) }, path.join(link, 'missing.css')],
      ];
      for (const [what, options, given] of missing) {
        const { result, text } = await render(`error-${what}`, { content: '# Report', options });
        assert(result.isError, `a missing ${what} should fail the render, answered: ${text}`);
        assert(text.includes(given) && !text.includes(real),
          `the error for a missing ${what} should name it as given (${given}), not where its link leads (${real}): ${text}`);
      }
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
    console.log(`${failures.length} of 6 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
