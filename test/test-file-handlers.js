/**
 * Test script for file handler system
 *
 * This script tests the file handler architecture:
 * 1. File handler factory returns correct handler types
 * 2. FileResult interface consistency
 * 3. ReadOptions interface usage
 * 4. Handler canHandle() method
 * 5. Text file handler basic operations
 * 6. Image file handler detection
 * 7. Binary file handler fallback
 */

import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { readFile, writeFile, getFileInfo } from '../dist/tools/filesystem.js';
import { getFileHandler } from '../dist/utils/files/factory.js';
import { handleReadFile, handleWriteFile } from '../dist/handlers/filesystem-handlers.js';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test directory and files
const TEST_DIR = path.join(__dirname, 'test_file_handlers');
const TEXT_FILE = path.join(TEST_DIR, 'test.txt');
const JSON_FILE = path.join(TEST_DIR, 'test.json');
const MD_FILE = path.join(TEST_DIR, 'test.md');
const HTML_FILE = path.join(TEST_DIR, 'test.html');
const IMAGE_FILE = path.join(TEST_DIR, 'test.png');
const SVG_FILE = path.join(TEST_DIR, 'test.svg');

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
 * Setup function
 */
async function setup() {
  // Clean up before tests (in case previous run left files)
  await cleanupTestDirectories();

  await fs.mkdir(TEST_DIR, { recursive: true });
  console.log(`✓ Setup: created test directory: ${TEST_DIR}`);

  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [TEST_DIR]);

  return originalConfig;
}

/**
 * Teardown function
 * Always runs cleanup, restores config only if provided
 */
async function teardown(originalConfig) {
  // Always clean up test directories, even if setup failed
  try {
    await cleanupTestDirectories();
    console.log('✓ Teardown: cleaned up test directories');
  } catch (error) {
    console.error('Warning: Failed to clean up test directories:', error.message);
  }

  // Restore config only if we have the original
  if (originalConfig) {
    try {
      await configManager.updateConfig(originalConfig);
      console.log('✓ Teardown: restored config');
    } catch (error) {
      console.error('Warning: Failed to restore config:', error.message);
    }
  }
}

/**
 * Test 1: Handler factory returns correct types
 */
async function testHandlerFactory() {
  console.log('\n--- Test 1: Handler Factory Types ---');

  // Note: TextFileHandler.canHandle() returns true for all files,
  // so it catches most files before BinaryFileHandler.
  // BinaryFileHandler only handles files that fail binary detection at read time.
  const testCases = [
    { file: 'test.xlsx', expected: 'ExcelFileHandler' },
    { file: 'test.xls', expected: 'ExcelFileHandler' },
    { file: 'test.xlsm', expected: 'ExcelFileHandler' },
    { file: 'test.txt', expected: 'TextFileHandler' },
    { file: 'test.js', expected: 'TextFileHandler' },
    { file: 'test.json', expected: 'TextFileHandler' },
    { file: 'test.md', expected: 'TextFileHandler' },
    { file: 'test.png', expected: 'ImageFileHandler' },
    { file: 'test.jpg', expected: 'ImageFileHandler' },
    { file: 'test.jpeg', expected: 'ImageFileHandler' },
    { file: 'test.gif', expected: 'ImageFileHandler' },
    { file: 'test.webp', expected: 'ImageFileHandler' },
  ];

  for (const { file, expected } of testCases) {
    const handler = await getFileHandler(file);
    assert.strictEqual(handler.constructor.name, expected,
      `${file} should use ${expected} but got ${handler.constructor.name}`);
  }

  console.log('✓ All file types map to correct handlers');
}

/**
 * Test 2: FileResult interface consistency
 */
async function testFileResultInterface() {
  console.log('\n--- Test 2: FileResult Interface ---');

  // Create a text file
  await fs.writeFile(TEXT_FILE, 'Hello, World!\nLine 2\nLine 3');

  const result = await readFile(TEXT_FILE);

  // Check FileResult structure
  assert.ok('content' in result, 'FileResult should have content');
  assert.ok('mimeType' in result, 'FileResult should have mimeType');
  assert.ok(result.content !== undefined, 'Content should not be undefined');
  assert.ok(typeof result.mimeType === 'string', 'mimeType should be a string');

  // metadata is optional but should be an object if present
  if (result.metadata) {
    assert.ok(typeof result.metadata === 'object', 'metadata should be an object');
  }

  console.log('✓ FileResult interface is consistent');
}

/**
 * Test 3: ReadOptions interface
 */
async function testReadOptionsInterface() {
  console.log('\n--- Test 3: ReadOptions Interface ---');

  await fs.writeFile(TEXT_FILE, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

  // Test offset option
  const result1 = await readFile(TEXT_FILE, { offset: 2 });
  const content1 = result1.content.toString();
  assert.ok(content1.includes('Line 3'), 'Offset should skip to line 3');

  // Test length option
  const result2 = await readFile(TEXT_FILE, { offset: 0, length: 2 });
  const content2 = result2.content.toString();
  assert.ok(content2.includes('Line 1'), 'Should include Line 1');
  assert.ok(content2.includes('Line 2'), 'Should include Line 2');

  console.log('✓ ReadOptions work correctly');
}

/**
 * Test 4: Handler canHandle method
 */
async function testCanHandle() {
  console.log('\n--- Test 4: canHandle Method ---');

  const excelHandler = await getFileHandler('test.xlsx');
  const textHandler = await getFileHandler('test.txt');
  const imageHandler = await getFileHandler('test.png');

  // Excel handler should handle xlsx
  assert.ok(excelHandler.canHandle('anything.xlsx'), 'Excel handler should handle .xlsx');
  assert.ok(excelHandler.canHandle('file.xls'), 'Excel handler should handle .xls');

  // Image handler should handle images
  assert.ok(imageHandler.canHandle('photo.png'), 'Image handler should handle .png');
  assert.ok(imageHandler.canHandle('photo.jpg'), 'Image handler should handle .jpg');
  assert.ok(imageHandler.canHandle('photo.jpeg'), 'Image handler should handle .jpeg');

  // Text handler handles most things (fallback)
  assert.ok(textHandler.canHandle('file.txt'), 'Text handler should handle .txt');

  console.log('✓ canHandle methods work correctly');
}

/**
 * Test 5: Text handler read/write
 */
async function testTextHandler() {
  console.log('\n--- Test 5: Text Handler Operations ---');

  const content = 'Test content\nWith multiple lines\nAnd special chars: äöü';

  // Write
  await writeFile(TEXT_FILE, content);
  console.log('✓ Text write succeeded');

  // Read
  const result = await readFile(TEXT_FILE);
  const readContent = result.content.toString();
  assert.ok(readContent.includes('Test content'), 'Should read back content');
  assert.ok(readContent.includes('äöü'), 'Should preserve special characters');

  console.log('✓ Text handler read/write works');
}

/**
 * Test 6: Text handler with JSON file
 */
async function testJsonFile() {
  console.log('\n--- Test 6: JSON File Handling ---');

  const data = { name: 'Test', values: [1, 2, 3] };
  const content = JSON.stringify(data, null, 2);

  await writeFile(JSON_FILE, content);

  const result = await readFile(JSON_FILE);
  const readContent = result.content.toString();
  const parsed = JSON.parse(readContent.replace(/^\[.*?\]\n\n/, '')); // Remove status message

  assert.strictEqual(parsed.name, 'Test', 'JSON should be preserved');
  assert.deepStrictEqual(parsed.values, [1, 2, 3], 'Array should be preserved');

  console.log('✓ JSON file handling works');
}

/**
 * Test 7: File info returns correct structure
 */
async function testFileInfo() {
  console.log('\n--- Test 7: File Info Structure ---');

  await fs.writeFile(TEXT_FILE, 'Some content');

  const info = await getFileInfo(TEXT_FILE);

  // Check required fields
  assert.ok('size' in info, 'Should have size');
  assert.ok('created' in info || 'birthtime' in info, 'Should have creation time');
  assert.ok('modified' in info || 'mtime' in info, 'Should have modification time');
  assert.ok('isFile' in info, 'Should have isFile');
  assert.ok('isDirectory' in info, 'Should have isDirectory');

  assert.ok(info.size > 0, 'Size should be > 0');
  assert.ok(info.isFile === true || info.isFile === 'true', 'Should be a file');

  console.log('✓ File info structure is correct');
}

/**
 * Test 8: Write mode (rewrite vs append)
 */
async function testWriteModes() {
  console.log('\n--- Test 8: Write Modes ---');

  // Initial write (rewrite mode - default)
  await writeFile(TEXT_FILE, 'Initial content');

  // Overwrite
  await writeFile(TEXT_FILE, 'New content', 'rewrite');
  let result = await readFile(TEXT_FILE);
  let content = result.content.toString();
  assert.ok(!content.includes('Initial'), 'Rewrite should replace content');
  assert.ok(content.includes('New content'), 'Should have new content');
  console.log('✓ Rewrite mode works');

  // Append
  await writeFile(TEXT_FILE, '\nAppended content', 'append');
  result = await readFile(TEXT_FILE);
  content = result.content.toString();
  assert.ok(content.includes('New content'), 'Should keep original');
  assert.ok(content.includes('Appended content'), 'Should have appended');
  console.log('✓ Append mode works');
}

/**
 * Test 9: read_file preview contract.
 *
 * Since the pull-by-path preview refactor, structuredContent is widget-only:
 * it is returned ONLY on origin:'ui' calls (the preview widget's own RPC
 * reads) and carries metadata only (no content duplication, no sourceTool —
 * the widget stamps that client-side). LLM-facing calls carry the full
 * content in content[] and no structuredContent at all. Image ui-reads
 * return the base64 in a text block (an image block would make the host
 * inline-render the RPC response and stall the widget).
 */
async function testReadFilePreviewMetadata() {
  console.log('\n--- Test 9: read_file preview structured content ---');

  const markdownContent = '# Title\n\n```js\nconst x = 1;\n```';
  const textContent = 'hello\nplain text';
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6xkAAAAASUVORK5CYII=';
  const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';

  await fs.writeFile(MD_FILE, markdownContent);
  await fs.writeFile(TEXT_FILE, textContent);
  await fs.writeFile(HTML_FILE, '<h1>Preview</h1><script>alert(1)</script>');
  await fs.writeFile(IMAGE_FILE, Buffer.from(tinyPngBase64, 'base64'));
  await fs.writeFile(SVG_FILE, tinySvg);

  // LLM-facing reads: full content in content[], no structuredContent.
  const markdownResult = await handleReadFile({ path: MD_FILE });
  assert.ok(Array.isArray(markdownResult.content), 'Result should include content array');
  assert.ok(markdownResult.content[0].text.includes(markdownContent), 'Content should include markdown body');
  assert.strictEqual(markdownResult.structuredContent, undefined, 'LLM-facing read should carry no structuredContent');

  const textResult = await handleReadFile({ path: TEXT_FILE });
  assert.ok(textResult.content[0].text.includes(textContent), 'Content should include text body');
  assert.strictEqual(textResult.structuredContent, undefined, 'LLM-facing read should carry no structuredContent');

  // Widget (origin:'ui') reads: same content plus metadata-only structuredContent.
  const uiMarkdownResult = await handleReadFile({ path: MD_FILE, origin: 'ui' });
  assert.ok(uiMarkdownResult.structuredContent, 'ui read should include structuredContent');
  assert.strictEqual(uiMarkdownResult.structuredContent.fileType, 'markdown', 'Markdown fileType should be markdown');
  assert.strictEqual(uiMarkdownResult.structuredContent.filePath, MD_FILE, 'Markdown file path should be present');
  assert.strictEqual(uiMarkdownResult.structuredContent.content, undefined, 'structuredContent should be metadata-only (no content)');
  assert.strictEqual(uiMarkdownResult.structuredContent.sourceTool, undefined, 'structuredContent should not carry sourceTool (widget stamps it)');
  assert.ok(uiMarkdownResult.content[0].text.includes(markdownContent), 'ui read content[] should carry the markdown body');

  const uiHtmlResult = await handleReadFile({ path: HTML_FILE, origin: 'ui' });
  assert.strictEqual(uiHtmlResult.structuredContent.fileType, 'html', 'HTML fileType should be html');
  assert.ok(uiHtmlResult.content[0].text.includes('<h1>Preview</h1>'), 'ui read content[] should carry the html body');

  // LLM-facing image read: image block so the host model can see the image;
  // no structuredContent.
  const imageResult = await handleReadFile({ path: IMAGE_FILE });
  const imageContentItem = imageResult.content.find((item) => item.type === 'image');
  assert.ok(imageContentItem, 'Image result should include an image content item so the host model can see the image');
  assert.strictEqual(imageContentItem.mimeType, 'image/png', 'Image content item should carry the png mimeType');
  assert.ok(typeof imageContentItem.data === 'string' && imageContentItem.data.length > 0, 'Image content item should carry non-empty base64 data');
  assert.strictEqual(imageResult.structuredContent, undefined, 'LLM-facing image read should carry no structuredContent');

  // Widget image read: base64 rides in a TEXT block (no image block), plus
  // metadata-only structuredContent with the mimeType the widget renders with.
  const uiImageResult = await handleReadFile({ path: IMAGE_FILE, origin: 'ui' });
  assert.ok(!uiImageResult.content.some((item) => item.type === 'image'), 'ui image read must not include an image block (host would inline-render and stall the RPC)');
  assert.strictEqual(uiImageResult.content[0].type, 'text', 'ui image read should carry base64 in a text block');
  assert.strictEqual(uiImageResult.content[0].text, tinyPngBase64, 'ui image read text block should be the base64 image data');
  assert.ok(uiImageResult.structuredContent, 'ui image read should include structuredContent');
  assert.strictEqual(uiImageResult.structuredContent.fileType, 'image', 'Image fileType should map to image preview state');
  assert.strictEqual(uiImageResult.structuredContent.mimeType, 'image/png', 'Image structured payload should include mimeType');
  assert.strictEqual(uiImageResult.structuredContent.content, undefined, 'Image structuredContent should be metadata-only');

  const uiSvgResult = await handleReadFile({ path: SVG_FILE, origin: 'ui' });
  assert.strictEqual(uiSvgResult.structuredContent.fileType, 'image', 'SVG should map to image preview state');
  assert.strictEqual(uiSvgResult.structuredContent.mimeType, 'image/svg+xml', 'SVG structured payload should include SVG mimeType');
  assert.ok(!uiSvgResult.content.some((item) => item.type === 'image'), 'ui SVG read must not include an image block');
  assert.ok(uiSvgResult.content[0].text.length > 0, 'ui SVG read should carry base64 in a text block');

  // write_file never returns structuredContent (nothing in the UI calls it;
  // the widget previews writes via its own read_file pull).
  const writeResult = await handleWriteFile({ path: TEXT_FILE, content: 'written through handler' });
  assert.strictEqual(writeResult.structuredContent, undefined, 'write_file should carry no structuredContent');
  assert.ok(writeResult.content[0].text.includes('Successfully'), 'write_file should confirm the write');

  const nullArgsResult = await handleReadFile(null);
  assert.ok(Array.isArray(nullArgsResult.content), 'Null-args result should include content array');
  assert.strictEqual(nullArgsResult.isError, true, 'Null-args should be returned as error');
  assert.ok(nullArgsResult.content[0].text.includes('Error: No arguments provided for read_file command'), 'Null-args should include standard error text');

  console.log('✓ read_file preview structured content contract works');
}

/**
 * Test 10: Markdown exact-match save flow works through edit_block
 */
async function testMarkdownExactMatchSave() {
  console.log('\n--- Test 10: markdown exact-match save flow ---');

  const originalContent = '# Title\n\nOriginal paragraph.\n';
  const updatedContent = '# Title\n\nUpdated paragraph.\n';

  await fs.writeFile(MD_FILE, originalContent);

  const result = await handleEditBlock({
    file_path: MD_FILE,
    old_string: originalContent,
    new_string: updatedContent,
    expected_replacements: 1,
  });

  assert.ok(Array.isArray(result.content), 'edit_block result should include content array');
  assert.strictEqual(result.content[0].type, 'text', 'edit_block result[0] should be text');
  assert.match(
    result.content[0].text,
    /\[Reading \d+ lines? from/,
    'edit_block should return a file-preview status line'
  );
  // structuredContent is widget-only: LLM-facing edit_block calls omit it.
  assert.strictEqual(result.structuredContent, undefined, 'LLM-facing edit_block should carry no structuredContent');

  const readBack = await fs.readFile(MD_FILE, 'utf8');
  assert.strictEqual(readBack, updatedContent, 'Markdown file should be rewritten with the updated content');

  // Widget saves (origin:'ui') get metadata-only structuredContent — the save
  // flow's success signal (assertSuccessfulEditBlockResult).
  await fs.writeFile(MD_FILE, originalContent);
  const uiResult = await handleEditBlock({
    file_path: MD_FILE,
    old_string: originalContent,
    new_string: updatedContent,
    expected_replacements: 1,
    origin: 'ui',
  });
  assert.ok(uiResult.structuredContent, 'ui edit_block should return structuredContent');
  assert.ok(uiResult.structuredContent.filePath, 'ui edit_block structuredContent should include filePath');
  assert.strictEqual(uiResult.structuredContent.content, undefined, 'ui edit_block structuredContent should be metadata-only');

  console.log('✓ markdown exact-match save flow works');
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('=== File Handler System Tests ===\n');

  await testHandlerFactory();
  await testFileResultInterface();
  await testReadOptionsInterface();
  await testCanHandle();
  await testTextHandler();
  await testJsonFile();
  await testFileInfo();
  await testWriteModes();
  await testReadFilePreviewMetadata();
  await testMarkdownExactMatchSave();

  console.log('\n✅ All file handler tests passed!');
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
    // Always run teardown to clean up test directories and restore config
    // teardown handles the case where originalConfig is undefined
    await teardown(originalConfig);
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
