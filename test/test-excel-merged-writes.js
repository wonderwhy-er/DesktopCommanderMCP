/** A merged cell must not redirect an edit outside its requested coordinates. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ExcelFileHandler } from '../dist/utils/files/excel.js';
import { runIfMain } from './helpers/run-if-main.js';

async function fixture(file, range) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.getCell('A1').value = 'original';
  sheet.mergeCells(range);
  sheet.getCell('D1').value = 'keep';
  workbook.addWorksheet('Other').getCell('A1').value = 'unrelated';
  await workbook.xlsx.writeFile(file);
}

export default async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-merged-writes-'));
  const handler = new ExcelFileHandler();
  try {
    for (const [merge, range, content] of [
      ['A1:B1', 'Data!A1:B1', [['first', 'second']]],
      ['A1:A2', 'Data!A1:A2', [['first'], ['second']]],
      ['A1:B2', 'Data!B2', [['outside-master']]],
      ['A1:B1', 'Data!B1', [[null]]],
      ['A1:B1', 'Data', [['first', 'second']]],
    ]) {
      const file = path.join(dir, 'range.xlsx');
      await fixture(file, merge);
      const before = await fs.readFile(file);
      await assert.rejects(handler.editRange(file, range, content), /merged.*A1/i);
      assert.deepEqual(await fs.readFile(file), before, 'a rejected edit must leave the file unchanged');
    }

    const file = path.join(dir, 'valid.xlsx');
    await fixture(file, 'A1:B1');
    await handler.editRange(file, 'Data!A1', [['new master']]);
    const preserved = new ExcelJS.Workbook();
    await preserved.xlsx.readFile(file);
    assert.equal(preserved.getWorksheet('Data').getCell('A1').value, 'new master');
    assert.equal(preserved.getWorksheet('Data').getCell('B1').master.address, 'A1');

    await handler.editRange(file, 'Data', [['replacement title']]);
    const replaced = new ExcelJS.Workbook();
    await replaced.xlsx.readFile(file);
    const sheet = replaced.getWorksheet('Data');
    assert.equal(sheet.getCell('A1').value, 'replacement title');
    assert.equal(sheet.getCell('D1').value, null);
    assert.equal(sheet.getCell('B1').master.address, 'A1', 'whole-sheet edits preserve merge formatting');
    assert.equal(replaced.getWorksheet('Other').getCell('A1').value, 'unrelated');
    console.log('7 merged-cell editing regressions and controls passed');
    return true;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
