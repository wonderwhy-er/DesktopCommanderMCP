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
import { readFile, writeFile, getFileInfo } from '../dist/tools/filesystem.js';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import { getFileHandler } from '../dist/utils/files/factory.js';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test directory and files
const TEST_DIR = path.join(__dirname, 'test_excel_files');
const BASIC_EXCEL = path.join(TEST_DIR, 'basic.xlsx');
const MULTI_SHEET_EXCEL = path.join(TEST_DIR, 'multi_sheet.xlsx');
const EDIT_EXCEL = path.join(TEST_DIR, 'edit_test.xlsx');

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
  assert.ok(content.includes('Alice'), 'Should include Alice (row 2)');
  assert.ok(content.includes('Bob'), 'Should include Bob (row 3)');

  console.log('✓ Offset and length read works correctly');
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

  assert.ok(content.includes('Fourth') || content.includes('Fifth'),
    'Should include data from last rows');

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
  await testEditRange();
  await testGetFileInfo();
  await testAppendMode();
  await testNegativeOffset();

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
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
