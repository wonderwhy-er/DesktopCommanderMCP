/**
 * Test script for Excel file handling functionality
 *
 * This script tests the ExcelFileHandler implementation:
 * 1. Reading Excel files (basic, sheet selection, range, offset/length)
 * 2. Writing Excel files (single sheet, multiple sheets, append mode)
 * 3. Editing Excel files (range updates)
 * 4. Getting Excel file info (sheet metadata)
 * 5. File handler factory (correct handler selection)
 */

import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import ExcelJS from 'exceljs';
import { readFile, writeFile, getFileInfo } from '../dist/tools/filesystem.js';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import { getFileHandler } from '../dist/utils/files/factory.js';
import { runIfMain } from './helpers/run-if-main.js';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test directory and files
const TEST_DIR = path.join(__dirname, 'test_excel_files');
const BASIC_EXCEL = path.join(TEST_DIR, 'basic.xlsx');
const MULTI_SHEET_EXCEL = path.join(TEST_DIR, 'multi_sheet.xlsx');
const EDIT_EXCEL = path.join(TEST_DIR, 'edit_test.xlsx');

/** The rows an Excel read returns: the JSON array after the status header */
function sheetRows(content) {
  return JSON.parse(content.slice(content.lastIndexOf('\n\n') + 2));
}

/**
 * Helper function to clean up test directories
 */
async function cleanupTestDirectories() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error during cleanup:', error);
    }
  }
}

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  // Clean up before tests (in case previous run left files)
  await cleanupTestDirectories();

  // Create test directory
  await fs.mkdir(TEST_DIR, { recursive: true });
  console.log(`✓ Setup: created test directory: ${TEST_DIR}`);

  // Save original config to restore later
  const originalConfig = await configManager.getConfig();

  // Set allowed directories to include our test directory
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  console.log(`✓ Setup: set allowed directories`);

  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  // Reset configuration to original
  if (originalConfig) {
    await configManager.updateConfig(originalConfig);
  }

  await cleanupTestDirectories();
  console.log('✓ Teardown: test directory cleaned up and config restored');
}

/**
 * Test 1: File handler factory selects ExcelFileHandler for .xlsx files
 */
async function testFileHandlerFactory() {
  console.log('\n--- Test 1: File Handler Factory ---');

  const handler = await getFileHandler('test.xlsx');
  assert.ok(handler, 'Handler should be returned for .xlsx file');
  assert.ok(handler.constructor.name === 'ExcelFileHandler',
    `Expected ExcelFileHandler but got ${handler.constructor.name}`);

  const txtHandler = await getFileHandler('test.txt');
  assert.ok(txtHandler.constructor.name === 'TextFileHandler',
    `Expected TextFileHandler for .txt but got ${txtHandler.constructor.name}`);

  console.log('✓ File handler factory correctly selects handlers');
}

/**
 * Test 2: Write and read basic Excel file
 */
async function testBasicWriteRead() {
  console.log('\n--- Test 2: Basic Write and Read ---');

  // Write a simple Excel file
  const data = JSON.stringify([
    ['Name', 'Age', 'City'],
    ['Alice', 30, 'New York'],
    ['Bob', 25, 'Los Angeles'],
    ['Charlie', 35, 'Chicago']
  ]);

  await writeFile(BASIC_EXCEL, data);
  console.log('✓ Wrote basic Excel file');

  // Read it back
  const result = await readFile(BASIC_EXCEL);
  assert.ok(result.content, 'Should have content');
  // Excel handler returns application/json because content is JSON-formatted for LLM consumption
  assert.ok(result.mimeType === 'application/json',
    `Expected application/json mime type but got ${result.mimeType}`);

  // Verify content contains our data
  const content = result.content.toString();
  assert.ok(content.includes('Name'), 'Content should include Name header');
  assert.ok(content.includes('Alice'), 'Content should include Alice');
  assert.ok(content.includes('Chicago'), 'Content should include Chicago');

  console.log('✓ Read back Excel file with correct content');
}

/**
 * Test 3: Write and read multi-sheet Excel file
 */
async function testMultiSheetWriteRead() {
  console.log('\n--- Test 3: Multi-Sheet Write and Read ---');

  // Write multi-sheet Excel file
  const data = JSON.stringify({
    'Employees': [
      ['Name', 'Department'],
      ['Alice', 'Engineering'],
      ['Bob', 'Sales']
    ],
    'Departments': [
      ['Name', 'Budget'],
      ['Engineering', 100000],
      ['Sales', 50000]
    ]
  });

  await writeFile(MULTI_SHEET_EXCEL, data);
  console.log('✓ Wrote multi-sheet Excel file');

  // Read specific sheet by name
  const result1 = await readFile(MULTI_SHEET_EXCEL, { sheet: 'Employees' });
  const content1 = result1.content.toString();
  assert.ok(content1.includes('Alice'), 'Employees sheet should contain Alice');
  assert.ok(content1.includes('Engineering'), 'Employees sheet should contain Engineering');
  console.log('✓ Read Employees sheet by name');

  // Read specific sheet by index
  const result2 = await readFile(MULTI_SHEET_EXCEL, { sheet: 1 });
  const content2 = result2.content.toString();
  assert.ok(content2.includes('Budget'), 'Departments sheet should contain Budget');
  assert.ok(content2.includes('100000'), 'Departments sheet should contain 100000');
  console.log('✓ Read Departments sheet by index');
}

/**
 * Test 4: Read with range parameter
 */
async function testRangeRead() {
  console.log('\n--- Test 4: Range Read ---');

  // Use the basic file we created
  const result = await readFile(BASIC_EXCEL, { sheet: 'Sheet1', range: 'A1:B2' });
  const content = result.content.toString();

  // Should only have first 2 rows and 2 columns
  assert.ok(content.includes('Name'), 'Range should include Name');
  assert.ok(content.includes('Age'), 'Range should include Age');
  assert.ok(content.includes('Alice'), 'Range should include Alice');
  // City is column C, should NOT be included
  assert.ok(!content.includes('City') || content.split('City').length === 1,
    'Range A1:B2 should not include City column');

  console.log('✓ Range read returns correct subset of data');
}

/**
 * Test 5: Read with offset and length
 */
async function testOffsetLengthRead() {
  console.log('\n--- Test 5: Offset and Length Read ---');

  // Read with offset (skip header)
  const result = await readFile(BASIC_EXCEL, { offset: 1, length: 2 });
  const content = result.content.toString();

  // Should have rows 2-3 (Alice, Bob) but not header or Charlie
  assert.deepStrictEqual(sheetRows(content), [['Alice', 30, 'New York'], ['Bob', 25, 'Los Angeles']],
    'offset: 1, length: 2 should return exactly rows 2-3');
  assert.ok(content.includes('[Showing rows 2-3 of 4 total.'), `Status line should report rows 2-3, got: ${content}`);

  console.log('✓ Offset and length read works correctly');
}

/**
 * Test 5b: Offset past the last row
 */
async function testOffsetPastEnd() {
  console.log('\n--- Test 5b: Offset Past the Last Row ---');

  // basic.xlsx has 4 rows; offset: 10 starts at row 11
  const result = await readFile(BASIC_EXCEL, { offset: 10 });
  const content = result.content.toString();

  assert.deepStrictEqual(sheetRows(content), [], 'offset past the last row should return no rows');
  assert.strictEqual(content.split('\n')[1],
    '[No rows returned: row 11 is past the end (4 rows total). Use offset/length to paginate.]',
    `Status line should say no rows were returned and give the total, got: ${content}`);

  console.log('✓ Offset past the last row reports no rows and the total');
}

/**
 * Test 6: Edit Excel range
 */
async function testEditRange() {
  console.log('\n--- Test 6: Edit Excel Range ---');

  // Create a file to edit
  const data = JSON.stringify([
    ['Product', 'Price'],
    ['Apple', 1.00],
    ['Banana', 0.50],
    ['Cherry', 2.00]
  ]);
  await writeFile(EDIT_EXCEL, data);
  console.log('✓ Created file for editing');

  // Edit a cell using edit_block with range
  const editResult = await handleEditBlock({
    file_path: EDIT_EXCEL,
    range: 'Sheet1!B2',
    content: [[1.50]]  // Update Apple price
  });

  assert.ok(!editResult.isError, `Edit should succeed: ${editResult.content?.[0]?.text}`);
  console.log('✓ Edit range succeeded');

  // Verify the edit
  const readResult = await readFile(EDIT_EXCEL);
  const content = readResult.content.toString();
  assert.ok(content.includes('1.5'), 'Price should be updated to 1.50');

  console.log('✓ Edit was persisted correctly');
}

/**
 * Test 7: Get Excel file info
 */
async function testGetFileInfo() {
  console.log('\n--- Test 7: Get File Info ---');

  const info = await getFileInfo(MULTI_SHEET_EXCEL);

  assert.ok(info.isExcelFile, 'Should be marked as Excel file');
  assert.ok(info.sheets, 'Should have sheets info');
  assert.ok(Array.isArray(info.sheets), 'Sheets should be an array');
  assert.strictEqual(info.sheets.length, 2, 'Should have 2 sheets');

  // Check sheet details
  const sheetNames = info.sheets.map(s => s.name);
  assert.ok(sheetNames.includes('Employees'), 'Should have Employees sheet');
  assert.ok(sheetNames.includes('Departments'), 'Should have Departments sheet');

  // Check row/column counts
  const employeesSheet = info.sheets.find(s => s.name === 'Employees');
  assert.ok(employeesSheet.rowCount >= 3, 'Employees sheet should have at least 3 rows');
  assert.ok(employeesSheet.colCount >= 2, 'Employees sheet should have at least 2 columns');

  console.log('✓ File info returns correct sheet metadata');
}

/**
 * Test 8: Append mode
 */
async function testAppendMode() {
  console.log('\n--- Test 8: Append Mode ---');

  // Create initial file
  const initialData = JSON.stringify([
    ['Name', 'Score'],
    ['Alice', 100]
  ]);
  await writeFile(BASIC_EXCEL, initialData);

  // Append more data
  const appendData = JSON.stringify([
    ['Bob', 95],
    ['Charlie', 88]
  ]);
  await writeFile(BASIC_EXCEL, appendData, 'append');
  console.log('✓ Appended data to Excel file');

  // Read and verify
  const result = await readFile(BASIC_EXCEL);
  const content = result.content.toString();

  assert.ok(content.includes('Alice'), 'Should still have Alice');
  assert.ok(content.includes('Bob'), 'Should have appended Bob');
  assert.ok(content.includes('Charlie'), 'Should have appended Charlie');

  console.log('✓ Append mode works correctly');
}

/**
 * Test 10: read_file range parity with edit_block (BUG_REPORT.md)
 * Regression for issue where read_file rejected "SheetName!A1:B2" while edit_block accepted it,
 * and additionally rejected the Excel-native quoted form "'My Sheet'!A1:B2".
 */
async function testRangeWithSheetPrefix() {
  console.log('\n--- Test 10: Range with embedded sheet prefix (parity with edit_block) ---');

  const SHEET = 'Copy of Original full list';
  const FILE = path.join(TEST_DIR, 'sheet_prefix.xlsx');
  const data = {};
  data[SHEET] = [
    ['Name', 'Stage', 'Notes'],
    ['Acme', 'Seed', 'first'],
    ['Bravo', 'A', 'second'],
  ];
  await writeFile(FILE, JSON.stringify(data));

  // Unquoted sheet prefix, same form edit_block accepts
  const r1 = await readFile(FILE, { range: `${SHEET}!A1:B2` });
  const c1 = r1.content.toString();
  assert.ok(c1.includes('Acme'), 'Unquoted sheet prefix should resolve to right sheet');
  assert.ok(!c1.includes('Notes'), 'Range A1:B2 must not include column C ("Notes")');

  // Single-cell shorthand with sheet prefix
  const r2 = await readFile(FILE, { range: `${SHEET}!A2` });
  assert.ok(r2.content.toString().includes('Acme'), 'Single cell with sheet prefix should work');

  // Excel-native quoted form (sheet name with spaces)
  const r3 = await readFile(FILE, { range: `'${SHEET}'!A1:B2` });
  assert.ok(r3.content.toString().includes('Acme'), "Quoted 'Sheet Name'! prefix should work");

  // Helpful error message for genuinely-invalid input
  let threw = false;
  try {
    await readFile(FILE, { range: 'not a range' });
  } catch (e) {
    threw = true;
    assert.ok(
      /SheetName!A1/.test(e.message),
      `Error should hint supported form, got: ${e.message}`
    );
  }
  assert.ok(threw, 'Invalid range must throw');

  console.log('✓ read_file accepts SheetName!A1:B2 and \'Sheet Name\'!A1:B2 (parity with edit_block)');
}

/**
 * Test 11: A range written end-first is the same range, as in Excel:
 * A5:C2 is A2:C5, for read_file and edit_block alike
 */
async function testReversedRange() {
  console.log('\n--- Test 11: Range with its end before its start ---');

  const FILE = path.join(TEST_DIR, 'reversed_range.xlsx');
  await writeFile(FILE, JSON.stringify([
    ['Name', 'Age', 'City'],
    ['Alice', 30, 'New York'],
    ['Bob', 25, 'Los Angeles'],
    ['Charlie', 35, 'Chicago'],
    ['Dana', 28, 'Denver']
  ]));

  const forward = (await readFile(FILE, { range: 'A2:C5' })).content.toString();
  assert.deepStrictEqual(sheetRows(forward),
    [['Alice', 30, 'New York'], ['Bob', 25, 'Los Angeles'], ['Charlie', 35, 'Chicago'], ['Dana', 28, 'Denver']],
    'A2:C5 should return rows 2-5, columns A-C');
  assert.ok(forward.split('\n')[1].startsWith('[To MODIFY cells:'),
    `The whole range is returned, so there should be no status line, got: ${forward}`);

  // Any two opposite corners name the same range
  for (const range of ['A5:C2', 'C2:A5', 'C5:A2']) {
    const content = (await readFile(FILE, { range })).content.toString();
    assert.strictEqual(content, forward, `${range} should read exactly what A2:C5 reads`);
  }

  // Pagination counts the rows of that range: 4, not 2 - 5 + 1 = -2
  const page = (await readFile(FILE, { range: 'A5:C2', offset: 1, length: 2 })).content.toString();
  assert.deepStrictEqual(sheetRows(page), [['Bob', 25, 'Los Angeles'], ['Charlie', 35, 'Chicago']],
    'A5:C2 with offset: 1, length: 2 should return rows 3-4 of the sheet');
  assert.strictEqual(page.split('\n')[1], '[Showing rows 2-3 of 4 total. Use offset/length to paginate.]',
    `Status line should report rows 2-3 of 4, got: ${page}`);

  // edit_block writes from the range's top-left cell, B2
  const editResult = await handleEditBlock({
    file_path: FILE,
    range: 'Sheet1!C3:B2',
    content: [[31, 'Boston'], [26, 'Austin']]
  });
  assert.ok(!editResult.isError, `Edit should succeed: ${editResult.content?.[0]?.text}`);
  const edited = (await readFile(FILE)).content.toString();
  assert.deepStrictEqual(sheetRows(edited), [
    ['Name', 'Age', 'City'],
    ['Alice', 31, 'Boston'],
    ['Bob', 26, 'Austin'],
    ['Charlie', 35, 'Chicago'],
    ['Dana', 28, 'Denver']
  ], 'edit_block with C3:B2 should write B2:C3');

  console.log('✓ A5:C2, C2:A5 and C5:A2 read and edit the range A2:C5');
}

/**
 * Test 12: Column letters are case-insensitive, as in Excel: a1:c2 is A1:C2,
 * for read_file and edit_block alike
 */
async function testLowercaseRange() {
  console.log('\n--- Test 12: Range with lowercase column letters ---');

  const FILE = path.join(TEST_DIR, 'lowercase_range.xlsx');
  const sheet = [
    ['Name', 'Age', 'City'],
    ['Alice', 30, 'New York'],
    ['Bob', 25, 'Los Angeles'],
    ['Charlie', 35, 'Chicago']
  ];
  // A second sheet 28 columns wide (A..AB), for two-letter columns
  const wide = [Array.from({ length: 28 }, (_, i) => `col${i + 1}`)];
  await writeFile(FILE, JSON.stringify({ Sheet1: sheet, Wide: wide }));

  // Each lowercase or mixed-case range reads exactly what its uppercase form reads
  const cases = [
    { range: 'a1:c2', upper: 'A1:C2', rows: [['Name', 'Age', 'City'], ['Alice', 30, 'New York']] },
    { range: 'Sheet1!b2', upper: 'Sheet1!B2', rows: [[30, 'New York'], [25, 'Los Angeles'], [35, 'Chicago']] },
    { range: 'b3:C4', upper: 'B3:C4', rows: [[25, 'Los Angeles'], [35, 'Chicago']] },
    { range: 'Wide!aa1:ab1', upper: 'Wide!AA1:AB1', rows: [['col27', 'col28']] }
  ];
  for (const { range, upper, rows } of cases) {
    const content = (await readFile(FILE, { range })).content.toString();
    assert.deepStrictEqual(sheetRows(content), rows, `${range} should read the cells of ${upper}`);
    const upperContent = (await readFile(FILE, { range: upper })).content.toString();
    assert.strictEqual(content, upperContent, `${range} should read exactly what ${upper} reads`);
  }

  // edit_block writes to the cells a lowercase range names: b2:c3 is B2:C3
  const editResult = await handleEditBlock({
    file_path: FILE,
    range: 'Sheet1!b2:c3',
    content: [[31, 'Boston'], [26, 'Austin']]
  });
  assert.ok(!editResult.isError, `Edit should succeed: ${editResult.content?.[0]?.text}`);
  const edited = (await readFile(FILE)).content.toString();
  assert.deepStrictEqual(sheetRows(edited), [
    ['Name', 'Age', 'City'],
    ['Alice', 31, 'Boston'],
    ['Bob', 26, 'Austin'],
    ['Charlie', 35, 'Chicago']
  ], 'edit_block with b2:c3 should write B2:C3 and leave the rest of the sheet unchanged');

  console.log('✓ a1:c2, b2, b3:C4 and aa1:ab1 read and edit the same cells as their uppercase forms');
}

/**
 * Test 13: A single-cell range reads from that cell to the end of the data; one
 * that starts below the data has no rows, and its row count says so
 */
async function testRangeStartingPastTheData() {
  console.log('\n--- Test 13: Single-cell range starting below the data ---');

  const FILE = path.join(TEST_DIR, 'range_past_data.xlsx');
  await writeFile(FILE, JSON.stringify([
    ['Row', 'Value'],
    ['1', 'First'],
    ['2', 'Second'],
    ['3', 'Third'],
    ['4', 'Fourth']
  ]));

  // The sheet has 5 rows; A10 starts 5 rows below them
  const content = (await readFile(FILE, { range: 'A10' })).content.toString();
  assert.deepStrictEqual(sheetRows(content), [], 'A10 on a 5-row sheet should return no rows');
  assert.ok(content.split('\n')[1].startsWith('[To MODIFY cells:'),
    `An empty range is returned whole, so there should be no status line, got: ${content}`);

  // The status line is built from the handler's (private) worksheetToArray totals
  // and prints nothing for any totalRows <= returnedRows, so a wrong count never
  // shows in the output - check the totals themselves: 0 rows, not 5 - 10 + 1 = -4
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(FILE);
  const handler = await getFileHandler(FILE);
  for (const range of ['A10', 'Sheet1!A10', 'a10']) {
    assert.deepStrictEqual(handler.worksheetToArray(workbook, undefined, range),
      { sheetName: 'Sheet1', data: [], totalRows: 0, returnedRows: 0, firstRow: 1 },
      `${range} on a 5-row sheet should count 0 rows`);
  }

  console.log('✓ A range starting below the data returns no rows and counts 0');
}

/**
 * Test 14: A sparse sheet is read up to its last used row and column, not up to
 * the COUNT of used rows and columns: with data only in columns A and AH (2 used
 * columns) and an empty row, every cell comes back in its own position
 */
async function testSparseSheet() {
  console.log('\n--- Test 14: Sparse sheet (data in columns A and AH, gaps) ---');

  const FILE = path.join(TEST_DIR, 'sparse.xlsx');
  // Column AH is column 34. Row 2 is empty, A5 and AH4 are empty: 4 used rows, the last is 5
  const cells = { A1: 'Name', AH1: 'Total', A3: 'Alice', AH3: 42, A4: 'Bob', AH5: 7 };
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');
  for (const [address, value] of Object.entries(cells)) worksheet.getCell(address).value = value;
  await workbook.xlsx.writeFile(FILE);

  /** A row of 34 cells (A..AH), null except the given 1-based columns */
  const row = (values = {}) => Array.from({ length: 34 }, (_, i) => values[i + 1] ?? null);
  const sheet = [
    row({ 1: 'Name', 34: 'Total' }),
    row(),
    row({ 1: 'Alice', 34: 42 }),
    row({ 1: 'Bob' }),
    row({ 34: 7 })
  ];

  const full = (await readFile(FILE)).content.toString();
  assert.deepStrictEqual(sheetRows(full), sheet, 'A full read should return rows 1-5, columns A-AH, each cell in place');
  assert.ok(full.split('\n')[1].startsWith('[To MODIFY cells:'),
    `The whole sheet is returned, so there should be no status line, got: ${full}`);

  // A single cell reads to the last used row and column: Z1 is Z1:AH5
  const fromZ1 = (await readFile(FILE, { range: 'Z1' })).content.toString();
  assert.deepStrictEqual(sheetRows(fromZ1), sheet.map(r => r.slice(25)),
    'Z1 should return rows 1-5, columns Z-AH');

  // The last row is row 5 (only AH5 is used), not row 4 (the 4th used row)
  const tail = (await readFile(FILE, { offset: -1 })).content.toString();
  assert.deepStrictEqual(sheetRows(tail), [row({ 34: 7 })], 'offset: -1 should return row 5');
  assert.strictEqual(tail.split('\n')[1], '[Showing rows 5-5 of 5 total. Use offset/length to paginate.]',
    `Status line should report row 5 of 5, got: ${tail}`);

  // Sheet info gives the same extent the reads use
  const info = await getFileInfo(FILE);
  assert.deepStrictEqual(info.sheets, [{ name: 'Sheet1', rowCount: 5, colCount: 34 }],
    'Sheet info should report the last used row (5) and column (AH = 34)');

  // Appending starts below the last used row: row 6, leaving row 5 (A5 empty, AH5 = 7) as it is
  await writeFile(FILE, JSON.stringify([['Carol', 'new']]), 'append');
  const appended = (await readFile(FILE)).content.toString();
  assert.deepStrictEqual(sheetRows(appended), [...sheet, row({ 1: 'Carol', 2: 'new' })],
    'Appending should write row 6 and leave rows 1-5 unchanged');

  // A single cell right of the data has no cells: Z1 on a sheet ending at column C
  const NARROW = path.join(TEST_DIR, 'narrow.xlsx');
  await writeFile(NARROW, JSON.stringify([['Name', 'Age', 'City'], ['Alice', 30, 'New York']]));
  const narrow = (await readFile(NARROW, { range: 'Z1' })).content.toString();
  assert.deepStrictEqual(sheetRows(narrow), [], 'Z1 on a sheet ending at column C should return no rows');
  assert.ok(narrow.split('\n')[1].startsWith('[To MODIFY cells:'),
    `An empty range is returned whole, so there should be no status line, got: ${narrow}`);
  const narrowBook = new ExcelJS.Workbook();
  await narrowBook.xlsx.readFile(NARROW);
  const handler = await getFileHandler(NARROW);
  assert.deepStrictEqual(handler.worksheetToArray(narrowBook, undefined, 'Z1'),
    { sheetName: 'Sheet1', data: [], totalRows: 0, returnedRows: 0, firstRow: 1 },
    'Z1 on a sheet ending at column C should count 0 rows');

  console.log('✓ A sparse sheet is read, sized and appended to by its last used row and column');
}

/**
 * Test 9: Negative offset (read from end)
 */
async function testNegativeOffset() {
  console.log('\n--- Test 9: Negative Offset (Tail) ---');

  // Create file with multiple rows
  const data = JSON.stringify([
    ['Row', 'Value'],
    ['1', 'First'],
    ['2', 'Second'],
    ['3', 'Third'],
    ['4', 'Fourth'],
    ['5', 'Fifth']
  ]);
  await writeFile(BASIC_EXCEL, data);

  // Read last 2 rows
  const result = await readFile(BASIC_EXCEL, { offset: -2 });
  const content = result.content.toString();

  assert.deepStrictEqual(sheetRows(content), [['4', 'Fourth'], ['5', 'Fifth']],
    'offset: -2 should return exactly the last 2 rows');
  assert.ok(content.includes('[Showing rows 5-6 of 6 total.'), `Status line should report rows 5-6, got: ${content}`);

  console.log('✓ Negative offset reads from end');
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('=== Excel File Handling Tests ===\n');

  await testFileHandlerFactory();
  await testBasicWriteRead();
  await testMultiSheetWriteRead();
  await testRangeRead();
  await testOffsetLengthRead();
  await testOffsetPastEnd();
  await testEditRange();
  await testGetFileInfo();
  await testAppendMode();
  await testNegativeOffset();
  await testRangeWithSheetPrefix();
  await testReversedRange();
  await testLowercaseRange();
  await testRangeStartingPastTheData();
  await testSparseSheet();

  console.log('\n✅ All Excel tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await runAllTests();
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
  return true;
}

// If this file is run directly, execute the test
runIfMain(import.meta.url, runTests);
