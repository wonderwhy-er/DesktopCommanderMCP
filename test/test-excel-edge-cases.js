/**
 * Excel reads, writes and edits do what read_file, write_file, edit_block and
 * get_file_info promise, in the cases where they didn't:
 * - edit_block `range` is FROM:TO: content bigger than the range was written
 *   past its TO corner, over the neighbouring cells.
 * - read_file `sheet` is a sheet name or an index: a sheet named "2024" was
 *   taken as index 2024 ("Sheet index 2024 out of range").
 * - write_file append of a 2D array appends to the workbook: on a workbook
 *   without a "Sheet1" it added a new sheet "Sheet1".
 * Calls the tool handlers (the answer text a client gets) and checks the
 * workbooks with ExcelJS.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { handleReadFile, handleWriteFile } from '../dist/handlers/filesystem-handlers.js';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

const text = (result) => result.content.map((item) => item.text ?? '').join('\n');

async function write(file, content, mode) {
  const result = await handleWriteFile({ path: file, content: JSON.stringify(content), ...(mode ? { mode } : {}) });
  assert.notStrictEqual(result.isError, true, `write_file failed: ${text(result)}`);
}

/** Every sheet of a workbook as { name: rows of cell values } */
async function sheets(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const out = {};
  for (const worksheet of workbook.worksheets) {
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, (row, number) => {
      rows[number - 1] = row.values.slice(1);
    });
    out[worksheet.name] = Array.from(rows, (row) => row ?? []);
  }
  return out;
}

async function testRangeToCorner(dir) {
  const file = path.join(dir, 'grid.xlsx');
  await write(file, [['1', '2'], ['3', '4']]);

  const tooBig = await handleEditBlock({ file_path: file, range: 'Sheet1!A1:A1', content: [['x', 'y'], ['z', 'w']] });
  assert.strictEqual(tooBig.isError, true,
    `edit_block range Sheet1!A1:A1 with 2x2 content should be refused, not written past the range; got: ${text(tooBig)}`);
  assert.deepStrictEqual((await sheets(file)).Sheet1, [['1', '2'], ['3', '4']],
    'cells outside the range Sheet1!A1:A1 were overwritten');

  // Content that fits is written as before
  const fits = await handleEditBlock({ file_path: file, range: 'Sheet1!A1:B2', content: [['a', 'b'], ['c']] });
  assert.notStrictEqual(fits.isError, true, `content that fits A1:B2 should be written, got: ${text(fits)}`);
  assert.deepStrictEqual((await sheets(file)).Sheet1, [['a', 'b'], ['c', '4']], 'content inside A1:B2 should be written');
}

async function testSheetNamedLikeANumber(dir) {
  const file = path.join(dir, 'years.xlsx');
  await write(file, { Summary: [['summary']], 2024: [['year 2024']] });

  const byName = await handleReadFile({ path: file, sheet: '2024' });
  assert.notStrictEqual(byName.isError, true, `read_file sheet "2024" should read the sheet named 2024, got: ${text(byName)}`);
  assert.ok(text(byName).includes('year 2024'), `read_file sheet "2024" should return that sheet's cells, got: ${text(byName)}`);

  // A number that is a valid index still means the index (JSON puts the "2024" key first: sheets 2024, Summary)
  const byIndex = await handleReadFile({ path: file, sheet: '1' });
  assert.ok(text(byIndex).includes('summary'), `read_file sheet "1" should still read the second sheet, got: ${text(byIndex)}`);
}

async function testAppendArrayWithoutSheet1(dir) {
  const file = path.join(dir, 'data.xlsx');
  await write(file, { Data: [['x']] });
  await write(file, [['y']], 'append');

  const after = await sheets(file);
  assert.deepStrictEqual(Object.keys(after), ['Data'],
    `appending a 2D array to a "Data"-only workbook added sheets: ${JSON.stringify(Object.keys(after))}`);
  assert.deepStrictEqual(after.Data, [['x'], ['y']], 'the rows should be appended to the workbook\'s sheet');
}

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-excel-edges-'));
  const failures = [];
  const cases = [
    ["edit_block keeps content within the range TO corner", testRangeToCorner],
    ["read_file reads a sheet named like a number", testSheetNamedLikeANumber],
    ["write_file appends a 2D array to the workbook, not to a new Sheet1", testAppendArrayWithoutSheet1],
  ];
  try {
    for (const [name, test] of cases) {
      try {
        await test(dir);
        console.log(`✓ ${name}`);
      } catch (error) {
        failures.push(name);
        console.error(`❌ ${name}: ${error.message}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`❌ ${failures.length} of ${cases.length} failed`);
    return false;
  }
  console.log('✅ Excel edge cases passed');
  return true;
}

runIfMain(import.meta.url, runTests);
