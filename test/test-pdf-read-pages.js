/**
 * read_file on a PDF: "offset/length work as page pagination (0-based)", and a
 * negative offset reads the last pages with the length ignored, as for lines.
 *
 * An offset past the last page (or a length of 0) returned every page, because
 * an empty page selection was taken for "all pages"; a negative offset applied
 * the length (offset -2, length 1 returned 1 page instead of the last 2).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import { SAMPLE_PDF, answerText, pdfWorkspace } from './helpers/pdf.js';
import { runIfMain } from './helpers/run-if-main.js';

const pagesIn = (result) => (answerText(result).match(/<!-- Page: (\d+) -->/g) ?? []).map((marker) => Number(marker.match(/\d+/)[0]));

async function run() {
  const ws = pdfWorkspace('pdf-read-pages');
  const pdf = path.join(ws.allowed, 'report.pdf');
  fs.copyFileSync(SAMPLE_PDF, pdf); // 22 pages
  const failures = [];
  const expectPages = async (args, expected, what) => {
    const name = `read_file on a 22-page PDF, ${what}: pages ${JSON.stringify(expected)}`;
    try {
      const result = await handleReadFile({ path: pdf, ...args });
      assert(!result.isError, `read_file failed: ${answerText(result)}`);
      assert.deepStrictEqual(pagesIn(result), expected, `read_file ${JSON.stringify(args)} returned pages ${JSON.stringify(pagesIn(result))}`);
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  };
  try {
    await expectPages({ offset: 500, length: 2 }, [], 'offset past the last page');
    await expectPages({ offset: 0, length: 0 }, [], 'length 0');
    await expectPages({ offset: -2, length: 1 }, [21, 22], 'offset -2 (length ignored)');
    await expectPages({ offset: -3 }, [20, 21, 22], 'offset -3');
    await expectPages({ offset: 0, length: 2 }, [1, 2], 'offset 0, length 2');
    await expectPages({ offset: 20, length: 5 }, [21, 22], 'offset 20, length 5');
  } finally {
    ws.cleanup();
  }
  if (failures.length > 0) {
    console.log(`${failures.length} of 6 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
