/**
 * Test: read_file and edit_block preserve CRLF line endings on Windows
 *
 * Verifies fix for https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/97
 *
 * The bug: TextFileHandler.read() used readline which stripped \r\n to \n.
 * When AI clients received LF content and wrote it back via write_file,
 * CRLF files silently lost their line endings, causing phantom git diffs.
 */

import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, 'test_crlf_preservation');
const CRLF_FILE = path.join(TEST_DIR, 'crlf_file.txt');
const LF_FILE = path.join(TEST_DIR, 'lf_file.txt');

// The raw CRLF content (5 lines, each ending with \r\n)
const CRLF_CONTENT = 'Line one\r\nLine two\r\nLine three\r\nLine four\r\nLine five\r\n';
const LF_CONTENT = 'Line one\nLine two\nLine three\nLine four\nLine five\n';

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(CRLF_FILE, CRLF_CONTENT, 'utf8');
  await fs.writeFile(LF_FILE, LF_CONTENT, 'utf8');

  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  console.log('  Setup: created test files');
  return originalConfig;
}

async function teardown(originalConfig) {
  // Explicitly restore allowedDirectories — shallow merge via updateConfig()
  // won't remove keys that were added during setup
  await configManager.setValue(
    'allowedDirectories',
    originalConfig.allowedDirectories ?? []
  );
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  console.log('  Teardown: cleaned up');
}

/**
 * Test 1: read_file does not modify the CRLF file on disk
 */
async function testReadFileDoesNotModifyDisk() {
  console.log('\n  Test 1: read_file does not modify CRLF file on disk');

  const originalBytes = await fs.readFile(CRLF_FILE);

  await handleReadFile({ path: CRLF_FILE });

  const afterBytes = await fs.readFile(CRLF_FILE);
  assert.ok(
    originalBytes.equals(afterBytes),
    'File on disk must be byte-for-byte identical after read_file'
  );
  console.log('    PASS');
}

/**
 * Test 2: read_file returns content with CRLF preserved
 */
async function testReadFilePreservesCRLF() {
  console.log('\n  Test 2: read_file returns CRLF line endings');

  const result = await handleReadFile({ path: CRLF_FILE });
  const text = result.content[0].text;

  // The returned text should contain \r\n (after stripping the status header)
  // Status header format: "[Reading N lines ...]\r\n\r\n<content>"
  const contentStart = text.indexOf('Line one');
  assert.ok(contentStart >= 0, 'Content should include "Line one"');

  const fileContent = text.substring(contentStart);
  assert.ok(
    fileContent.includes('\r\n'),
    'Returned content must preserve CRLF line endings'
  );
  assert.ok(
    !fileContent.match(/(?<!\r)\n/),
    'Returned content must not contain bare LF (all newlines should be CRLF)'
  );
  console.log('    PASS');
}

/**
 * Test 3: read_file returns LF content unchanged for LF files
 */
async function testReadFileLFUnchanged() {
  console.log('\n  Test 3: read_file preserves LF for LF files');

  const result = await handleReadFile({ path: LF_FILE });
  const text = result.content[0].text;

  const contentStart = text.indexOf('Line one');
  const fileContent = text.substring(contentStart);

  assert.ok(
    !fileContent.includes('\r'),
    'LF file content must not contain CR characters'
  );
  assert.ok(
    fileContent.includes('\n'),
    'LF file content must contain LF'
  );
  console.log('    PASS');
}

/**
 * Test 4: edit_block preserves CRLF when editing a CRLF file
 */
async function testEditBlockPreservesCRLF() {
  console.log('\n  Test 4: edit_block preserves CRLF after editing');

  await handleEditBlock({
    file_path: CRLF_FILE,
    old_string: 'Line three',
    new_string: 'Line three EDITED',
    expected_replacements: 1
  });

  const rawContent = await fs.readFile(CRLF_FILE, 'utf8');

  // Verify the edit was applied
  assert.ok(
    rawContent.includes('Line three EDITED'),
    'Edit should have been applied'
  );

  // Verify all line endings are still CRLF
  // Split by \r\n and rejoin — if round-trips, all endings are CRLF
  const lines = rawContent.split('\r\n');
  const reconstructed = lines.join('\r\n');
  assert.strictEqual(
    rawContent,
    reconstructed,
    'All line endings must remain CRLF after edit'
  );

  // Verify no bare LF
  const withoutCRLF = rawContent.replace(/\r\n/g, '');
  assert.ok(
    !withoutCRLF.includes('\n'),
    'Must not contain bare LF after edit'
  );

  console.log('    PASS');
}

/**
 * Test 5: Simulate AI read-then-write roundtrip preserves CRLF
 * This is the actual user-facing scenario from issue #97:
 * AI reads a file, modifies it, writes it back.
 */
async function testReadWriteRoundtrip() {
  console.log('\n  Test 5: read → modify → write roundtrip preserves CRLF');

  // Re-create the file fresh
  await fs.writeFile(CRLF_FILE, CRLF_CONTENT, 'utf8');

  // Step 1: Read the file (simulating what AI sees)
  const readResult = await handleReadFile({ path: CRLF_FILE });
  let text = readResult.content[0].text;

  // Extract just the file content (skip status header)
  const contentStart = text.indexOf('Line one');
  let fileContent = text.substring(contentStart);

  // Step 2: AI modifies the content
  fileContent = fileContent.replace('Line two', 'Line two MODIFIED');

  // Step 3: Write back via writeFile
  const { writeFile } = await import('../dist/tools/filesystem.js');
  await writeFile(CRLF_FILE, fileContent);

  // Step 4: Verify the file still has CRLF
  const rawAfter = await fs.readFile(CRLF_FILE, 'utf8');
  assert.ok(
    rawAfter.includes('\r\n'),
    'File must still contain CRLF after roundtrip'
  );
  assert.ok(
    rawAfter.includes('Line two MODIFIED'),
    'Modification should be present'
  );

  // Verify no bare LF
  const withoutCRLF = rawAfter.replace(/\r\n/g, '');
  assert.ok(
    !withoutCRLF.includes('\n'),
    'Must not contain bare LF after roundtrip'
  );

  // Verify trailing newline is preserved
  assert.ok(
    rawAfter.endsWith('\r\n'),
    'Trailing CRLF must be preserved after roundtrip'
  );

  console.log('    PASS');
}

async function runTests() {
  console.log('=== CRLF Preservation Tests (issue #97) ===');
  let originalConfig;
  try {
    originalConfig = await setup();
    await testReadFileDoesNotModifyDisk();
    await testReadFilePreservesCRLF();
    await testReadFileLFUnchanged();
    await testEditBlockPreservesCRLF();
    await testReadWriteRoundtrip();
    console.log('\n  All CRLF preservation tests passed!\n');
    return true;
  } catch (error) {
    console.error('\n  FAIL:', error.message);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
}

export default runTests;

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
