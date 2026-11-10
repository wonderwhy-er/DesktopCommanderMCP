import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import { ExcelFileHandler } from '../dist/utils/files/excel.js';
import { createTempDir } from './helpers/test-env.js';

const worksheetRows = Array.from({ length: 1200 }, (_, index) => [
  `row ${index + 1}`,
  index + 1,
  (index + 1) % 2 === 0,
]);
const handler = new ExcelFileHandler();
let fixtureDirectory;
let workbookPath;

before(async () => {
  fixtureDirectory = createTempDir('dc-excel-zero-length-');
  workbookPath = path.join(fixtureDirectory, 'rows.xlsx');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Rows').addRows(worksheetRows);
  await workbook.xlsx.writeFile(workbookPath);
});

after(() => {
  if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function readRows(options) {
  const answer = await handler.read(workbookPath, options);
  const rows = JSON.parse(answer.content.slice(answer.content.lastIndexOf('\n') + 1));
  assert.ok(Array.isArray(rows), 'Excel reads return a JSON array of rows');
  return rows;
}

test('length zero without an offset returns no Excel rows', async () => {
  const rows = await readRows({ length: 0 });
  assert.equal(rows.length, 0, 'length 0 must not become an unlimited read when offset is omitted');
});

test('length zero at offset zero returns no Excel rows', async () => {
  const rows = await readRows({ offset: 0, length: 0 });
  assert.equal(rows.length, 0, 'offset 0, length 0 must return zero rows from a populated workbook');
});

test('length zero at a positive offset returns no Excel rows', async () => {
  const rows = await readRows({ offset: 3, length: 0 });
  assert.equal(rows.length, 0, 'offset 3, length 0 must not return the remaining worksheet rows');
});

test('length zero returns no rows from an explicit Excel range', async () => {
  const rows = await readRows({ range: 'Rows!B2:C6', offset: 0, length: 0 });
  assert.equal(rows.length, 0, 'an explicit range must still honor a zero maximum row count');
});

test('length zero at a positive offset returns no rows from an explicit Excel range', async () => {
  const rows = await readRows({ range: 'Rows!B2:C6', offset: 3, length: 0 });
  assert.equal(rows.length, 0, 'a range with offset 3, length 0 must return zero rows');
});

test('a positive length at offset zero returns the first Excel rows with their types', async () => {
  assert.deepEqual(await readRows({ offset: 0, length: 2 }), worksheetRows.slice(0, 2));
});

test('a positive length at a positive offset returns only the requested Excel rows', async () => {
  assert.deepEqual(await readRows({ offset: 3, length: 2 }), worksheetRows.slice(3, 5));
});

test('a positive length paginates within an explicit Excel range', async () => {
  assert.deepEqual(await readRows({ range: 'Rows!B2:C6', offset: 1, length: 2 }), [
    [3, false],
    [4, true],
  ]);
});

test('a positive length stops at the last Excel row', async () => {
  assert.deepEqual(await readRows({ offset: 1199, length: 3 }), worksheetRows.slice(1199));
});

test('an omitted length reads all remaining Excel rows', async () => {
  assert.deepEqual(await readRows({ offset: 3 }), worksheetRows.slice(3));
});

test('a zero length past the end of the worksheet returns no Excel rows', async () => {
  assert.deepEqual(await readRows({ offset: 1200, length: 0 }), []);
});

test('a negative offset reads the Excel tail even when length is zero', async () => {
  assert.deepEqual(await readRows({ offset: -3, length: 0 }), worksheetRows.slice(-3));
});

test('a negative offset reads the Excel tail even when length is positive', async () => {
  assert.deepEqual(await readRows({ offset: -3, length: 1 }), worksheetRows.slice(-3));
});

test('a negative offset reads the Excel tail when length is omitted', async () => {
  assert.deepEqual(await readRows({ offset: -3 }), worksheetRows.slice(-3));
});

test('a negative offset with zero length reads the tail of the explicit Excel range', async () => {
  assert.deepEqual(await readRows({ range: 'Rows!B2:C6', offset: -2, length: 0 }), [
    [5, false],
    [6, true],
  ]);
});

test('a zero length retains the workbook metadata and JSON MIME type', async () => {
  const answer = await handler.read(workbookPath, { sheet: 'Rows', offset: 0, length: 0 });
  assert.equal(answer.mimeType, 'application/json');
  assert.deepEqual(answer.metadata, {
    isExcelFile: true,
    sheets: [{ name: 'Rows', rowCount: 1200, colCount: 3 }],
    fileSize: fs.statSync(workbookPath).size,
    isLargeFile: false,
  });
});

test('a zero length at an in-range offset reports an empty page without claiming it is past the end', async () => {
  for (const offset of [0, 3]) {
    const answer = await handler.read(workbookPath, { offset, length: 0 });
    assert.equal(answer.content.split('\n')[1],
      '[No rows returned (1200 rows total). Use offset/length to paginate.]');
  }
});

test('a zero length within a range reports its total without claiming it is past the end', async () => {
  const answer = await handler.read(workbookPath, { range: 'Rows!B2:C6', offset: 3, length: 0 });
  assert.equal(answer.content.split('\n')[1],
    '[No rows returned (5 rows total). Use offset/length to paginate.]');
});

test('a zero length beyond the last Excel row still reports the out-of-range offset', async () => {
  const answer = await handler.read(workbookPath, { offset: 1200, length: 0 });
  assert.equal(answer.content.split('\n')[1],
    '[No rows returned: row 1201 is past the end (1200 rows total). Use offset/length to paginate.]');
});
