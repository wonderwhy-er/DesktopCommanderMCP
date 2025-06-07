/**
 * Test script for edit_block functionality with different line endings
 * 
 * This script tests how edit_block handles files with different line ending styles:
 * 1. Files with LF line endings (Unix/Linux)
 * 2. Files with CRLF line endings (Windows)
 * 3. Files with CR line endings (Old Mac)
 * 4. Files with mixed line endings
 * 5. Edge cases and corner scenarios
 */

import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test directory and files
const TEST_DIR = path.join(__dirname, 'test_edit_line_endings');
const LF_FILE = path.join(TEST_DIR, 'file_with_lf.txt');
const CRLF_FILE = path.join(TEST_DIR, 'file_with_crlf.txt');
const CR_FILE = path.join(TEST_DIR, 'file_with_cr.txt');
const MIXED_FILE = path.join(TEST_DIR, 'file_with_mixed.txt');

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  // Create test directory
  await fs.mkdir(TEST_DIR, { recursive: true });
  
  // Create test files with different line endings
  
  // LF file (Unix/Linux)
  const lfContent = `First line with LF
Second line with LF
Target line to replace
Fourth line with LF
Fifth line with LF`;
  await fs.writeFile(LF_FILE, lfContent, { encoding: 'utf8' });
  
  // CRLF file (Windows)
  const crlfContent = `First line with CRLF\r\nSecond line with CRLF\r\nTarget line to replace\r\nFourth line with CRLF\r\nFifth line with CRLF\r\n`;
  await fs.writeFile(CRLF_FILE, crlfContent);
  
  // CR file (Old Mac)
  const crContent = `First line with CR\rSecond line with CR\rTarget line to replace\rFourth line with CR\rFifth line with CR\r`;
  await fs.writeFile(CR_FILE, crContent);
  
  // Mixed line endings file
  const mixedContent = `First line with LF\nSecond line with CRLF\r\nTarget line to replace\nFourth line with CR\rFifth line with LF\n`;
  await fs.writeFile(MIXED_FILE, mixedContent);
  
  console.log(`✓ Setup: created test directory and files`);
  
  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  // Reset configuration to original
  await configManager.updateConfig(originalConfig);
  
  // Clean up test directory
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  console.log('✓ Teardown: test directory cleaned up and config restored');
}

/**
 * Helper function to read file as raw buffer to preserve binary line endings
 */
async function readRawFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('binary');
}

/**
 * Test edit_block with LF line endings
 */
async function testLFLineEndings() {
  console.log('\nTest 1: LF line endings (Unix/Linux)');
  
  try {
    // Allow access to test directory
    await configManager.setValue('allowedDirectories', [TEST_DIR]);
    
    // Replace a line using LF line endings in search string
    const result = await handleEditBlock({
      file_path: LF_FILE,
      old_string: 'Target line to replace',
      new_string: 'REPLACED LINE WITH LF',
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the LF edit'
    );
    
    // Verify file still has LF line endings
    const rawContent = await readRawFile(LF_FILE);
    assert.ok(!rawContent.includes('\r\n'), 'File should not contain CRLF');
    assert.ok(!rawContent.includes('\r'), 'File should not contain CR');
    assert.ok(rawContent.includes('\n'), 'File should contain LF');
    
    console.log('✓ LF line endings test passed');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test edit_block with CRLF line endings
 */
async function testCRLFLineEndings() {
  console.log('\nTest 2: CRLF line endings (Windows)');
  
  try {
    // Replace a line in CRLF file - try with LF search string first
    let result = await handleEditBlock({
      file_path: CRLF_FILE,
      old_string: 'Target line to replace',
      new_string: 'REPLACED LINE WITH CRLF',
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the CRLF edit'
    );
    
    // Verify file still has CRLF line endings
    const rawContent = await readRawFile(CRLF_FILE);
    assert.ok(rawContent.includes('\r\n'), 'File should contain CRLF');
    
    // Test with multi-line replacement including line endings
    result = await handleEditBlock({
      file_path: CRLF_FILE,
      old_string: 'Second line with CRLF\nREPLACED LINE WITH CRLF',
      new_string: 'New second line\nAnother replacement',
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the multi-line CRLF edit'
    );
    
    console.log('✓ CRLF line endings test passed');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test edit_block with CR line endings
 */
async function testCRLineEndings() {
  console.log('\nTest 3: CR line endings (Old Mac)');
  
  try {
    // Replace a line using CR line endings
    const result = await handleEditBlock({
      file_path: CR_FILE,
      old_string: 'Target line to replace',
      new_string: 'REPLACED LINE WITH CR',
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the CR edit'
    );
    
    // Verify file still has CR line endings
    const rawContent = await readRawFile(CR_FILE);
    assert.ok(!rawContent.includes('\n'), 'File should not contain LF');
    assert.ok(!rawContent.includes('\r\n'), 'File should not contain CRLF');
    assert.ok(rawContent.includes('\r'), 'File should contain CR');
    
    console.log('✓ CR line endings test passed');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test edit_block with mixed line endings
 */
async function testMixedLineEndings() {
  console.log('\nTest 4: Mixed line endings');
  
  try {
    // Replace a line in file with mixed line endings
    const result = await handleEditBlock({
      file_path: MIXED_FILE,
      old_string: 'Target line to replace',
      new_string: 'REPLACED LINE IN MIXED FILE',
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the mixed line ending edit'
    );
    
    // Verify file preserves mixed line endings
    const rawContent = await readRawFile(MIXED_FILE);
    assert.ok(rawContent.includes('\n'), 'File should contain LF');
    assert.ok(rawContent.includes('\r\n'), 'File should contain CRLF');
    assert.ok(rawContent.match(/\r[^\n]/), 'File should contain standalone CR');
    
    console.log('✓ Mixed line endings test passed');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test context-aware replacement with different line endings
 */
async function testContextAwareReplacement() {
  console.log('\nTest 5: Context-aware replacement across line ending types');
  
  try {
    // Re-create CRLF file (it was modified in previous tests)
    const crlfContent = `First line with CRLF\r\nSecond line with CRLF\r\nREPLACED LINE WITH CRLF\r\nFourth line with CRLF\r\nFifth line with CRLF\r\n`;
    await fs.writeFile(CRLF_FILE, crlfContent);
    
    // Test multi-line replacement with CRLF  
    let result = await handleEditBlock({
      file_path: CRLF_FILE,
      old_string: 'Second line with CRLF\nREPLACED LINE WITH CRLF',
      new_string: 'Multi-line replacement\nWith new content',
      expected_replacements: 1
    });
    
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should handle multi-line replacement in CRLF file'
    );
    
    // Re-create LF file (it was modified in previous tests)
    const lfContent = `First line with LF
Second line with LF
REPLACED LINE WITH LF
Fourth line with LF
Fifth line with LF`;
    await fs.writeFile(LF_FILE, lfContent, { encoding: 'utf8' });
    
    // Test multi-line replacement with LF
    result = await handleEditBlock({
      file_path: LF_FILE,
      old_string: 'Second line with LF\nREPLACED LINE WITH LF',
      new_string: 'Another multi-line replacement\nWith LF endings',
      expected_replacements: 1
    });
    
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should handle multi-line replacement in LF file'
    );
    
    console.log('✓ Context-aware replacement test passed');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test performance with large files of different line ending types
 */
async function testLargeFilePerformance() {
  console.log('\nTest 6: Performance with large files');
  
  const LARGE_FILE_LF = path.join(TEST_DIR, 'large_lf.txt');
  const LARGE_FILE_CRLF = path.join(TEST_DIR, 'large_crlf.txt');
  
  try {
    // Create large test files (but not too large to exceed line limit)
    // With line-based reading, we need to ensure we don't exceed the line limit
    const lines = Array(800).fill('This is a line in a large file.\n'); // Reduced from 2000 to 800
    lines[400] = 'TARGET LINE TO FIND AND REPLACE\n'; // Adjusted position
    
    // LF version
    await fs.writeFile(LARGE_FILE_LF, lines.join(''));
    
    // CRLF version
    const crlfLines = lines.map(line => line.replace('\n', '\r\n'));
    await fs.writeFile(LARGE_FILE_CRLF, crlfLines.join(''));
    
    // Test LF file
    const startLF = Date.now();
    let result = await handleEditBlock({
      file_path: LARGE_FILE_LF,
      old_string: 'TARGET LINE TO FIND AND REPLACE',
      new_string: 'REPLACED TARGET LINE IN LF FILE',
      expected_replacements: 1
    });
    const timeLF = Date.now() - startLF;
    
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should handle large LF file'
    );
    
    // Test CRLF file
    const startCRLF = Date.now();
    result = await handleEditBlock({
      file_path: LARGE_FILE_CRLF,
      old_string: 'TARGET LINE TO FIND AND REPLACE',
      new_string: 'REPLACED TARGET LINE IN CRLF FILE',
      expected_replacements: 1
    });
    const timeCRLF = Date.now() - startCRLF;
    
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should handle large CRLF file'
    );
    
    console.log(`✓ Performance test passed (LF: ${timeLF}ms, CRLF: ${timeCRLF}ms)`);
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test edge cases
 */
async function testEdgeCases() {
  console.log('\nTest 7: Edge cases');
  
  const EMPTY_FILE = path.join(TEST_DIR, 'empty.txt');
  const SINGLE_LINE_FILE = path.join(TEST_DIR, 'single_line.txt');
  const NO_ENDING_FILE = path.join(TEST_DIR, 'no_ending.txt');
  
  try {
    // Create edge case files
    await fs.writeFile(EMPTY_FILE, '');
    await fs.writeFile(SINGLE_LINE_FILE, 'Only one line with no ending');
    await fs.writeFile(NO_ENDING_FILE, 'Two lines\nBut no ending');
    
    // Test empty file
    let result = await handleEditBlock({
      file_path: EMPTY_FILE,
      old_string: 'non-existent',
      new_string: 'replacement',
      expected_replacements: 1
    });
    
    assert.ok(
      result.content[0].text.includes('Search content not found'),
      'Should handle empty file correctly'
    );
    
    // Test single line file
    result = await handleEditBlock({
      file_path: SINGLE_LINE_FILE,
      old_string: 'Only one line with no ending',
      new_string: 'Replaced single line',
      expected_replacements: 1
    });
    
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should handle single line file'
    );
    
    // Test file without trailing line ending
    result = await handleEditBlock({
      file_path: NO_ENDING_FILE,
      old_string: 'But no ending',
      new_string: 'With replacement',
      expected_replacements: 1
    });
    
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should handle file without trailing line ending'
    );
    
    console.log('✓ Edge cases test passed');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Main test function
 */
async function runEditBlockLineEndingTests() {
  console.log('=== edit_block Line Ending Tests ===\n');
  
  // Test 1: LF line endings
  await testLFLineEndings();
  
  // Test 2: CRLF line endings
  await testCRLFLineEndings();
  
  // Test 3: CR line endings
  await testCRLineEndings();
  
  // Test 4: Mixed line endings
  await testMixedLineEndings();
  
  // Test 5: Context-aware replacement
  await testContextAwareReplacement();
  
  // Test 6: Performance with large files
  await testLargeFilePerformance();
  
  // Test 7: Edge cases
  await testEdgeCases();
  
  console.log('\n✅ All edit_block line ending tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await runEditBlockLineEndingTests();
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}