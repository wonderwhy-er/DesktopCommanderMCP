/**
 * read_multiple_files returns each file's content with its path, as its
 * description says ("Each file's content is returned with its path as a
 * reference"), images and PDFs included: with several images, a failed read
 * and a PDF among them, the order of the blocks alone doesn't tell which
 * image or page belongs to which file.
 *
 * Calls the tool's handler, so the check is on the answer the AI gets.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleReadMultipleFiles } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

const SAMPLE_PDF = path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples', '01_sample_simple.pdf');
// Two different 1x1 PNGs
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

function check(ok, message) {
  if (!ok) throw new Error(message);
}

/** The text block right before `index`, the one that says whose content follows */
const blockBefore = (content, index) => (index > 0 && content[index - 1].type === 'text' ? content[index - 1].text : '');
/** Whether that block names `file` and no other of `files` (the summary at the top names them all) */
const namesOnly = (text, file, files) => text.includes(file) && files.every((other) => other === file || !text.includes(other));

async function testImagesAndPdfCarryTheirPath(dir) {
  const red = path.join(dir, 'red.png');
  const blue = path.join(dir, 'blue.png');
  const pdf = path.join(dir, 'doc.pdf');
  const note = path.join(dir, 'note.txt');
  await fs.writeFile(red, Buffer.from(RED_PNG, 'base64'));
  await fs.writeFile(blue, Buffer.from(BLUE_PNG, 'base64'));
  await fs.copyFile(SAMPLE_PDF, pdf);
  await fs.writeFile(note, 'a note');

  const files = [red, path.join(dir, 'missing.png'), pdf, blue, note];
  const { content } = await handleReadMultipleFiles({ paths: files });

  const images = content.flatMap((block, index) => (block.type === 'image' ? [index] : []));
  check(images.length === 2, `expected the two images, got ${images.length} image blocks`);
  for (const [index, file] of [[images[0], red], [images[1], blue]]) {
    check(namesOnly(blockBefore(content, index), file, files),
      `the image of ${path.basename(file)} came without its path (the block before it: ${JSON.stringify(blockBefore(content, index).slice(0, 80))}), `
      + 'so with several images the AI cannot tell which is which');
  }
  const page = content.findIndex((block) => block.type === 'text' && block.text.includes('Hello World'));
  check(page > 0, 'expected the PDF\'s page text');
  check(namesOnly(blockBefore(content, page), pdf, files),
    `the PDF's page came without its path (the block before it: ${JSON.stringify(blockBefore(content, page).slice(0, 80))})`);
  check(content.some((block) => block.type === 'text' && block.text.includes(`--- ${note} contents: ---`)),
    'the text file should still come with its path');
}

const CASES = [
  ['images and PDF pages come with their file\'s path', testImagesAndPdfCarryTheirPath],
];

async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-read-multiple-'));
  const failures = [];
  try {
    for (const [name, run] of CASES) {
      console.log(`\n--- ${name} ---`);
      try {
        await run(dir);
        console.log('ok');
      } catch (error) {
        failures.push(name);
        console.log(`❌ ${error.message}`);
      }
    }
  } finally {
    // Best-effort: a temp folder left behind is harmless
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log(failures.length === 0
    ? '\n✅ read_multiple_files tests passed'
    : `\n❌ ${failures.length} of ${CASES.length} failed: ${failures.join('; ')}`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
