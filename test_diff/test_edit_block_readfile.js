/**
 * Test script to verify that edit_block correctly handles file reading
 * and doesn't insert spurious [Reading X lines...] messages
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import assert from 'assert';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test file path
const TEST_FILE = join(__dirname, 'test_file.txt');

async function setup() {
  // Create a test file with more than 20 lines to trigger the [Reading X lines...] message
  const lines = Array(50).fill('This is a line in the test file.');
  lines[25] = 'This is the line we want to replace.';
  
  await fs.writeFile(TEST_FILE, lines.join('\n'));
  console.log('✓ Created test file with 50 lines');
}

async function cleanup() {
  try {
    await fs.unlink(TEST_FILE);
    console.log('✓ Cleaned up test file');
  } catch (error) {
    console.error('Error cleaning up test file:', error);
  }
}

async function testEditBlockWithReadFile() {
  try {
    console.log('Testing edit_block with readFile...');
    
    // Execute the edit_block operation
    const result = await handleEditBlock({
      file_path: TEST_FILE,
      old_string: 'This is the line we want to replace.',
      new_string: 'This line has been successfully replaced.',
      expected_replacements: 1
    });
    
    // Check if the operation was successful
    assert.strictEqual(result.content[0].type, 'text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Edit should be applied successfully'
    );
    
    // Read the file and check its content
    const content = await fs.readFile(TEST_FILE, 'utf8');
    const lines = content.split('\n');
    
    // Check if the file has the expected content
    assert.strictEqual(lines[25], 'This line has been successfully replaced.');
    
    // Check that the file doesn't contain the [Reading X lines...] message
    assert.ok(
      !content.includes('[Reading'),
      'File should not contain [Reading X lines...] message'
    );
    
    console.log('✅ Test passed: edit_block correctly modifies the file without adding read messages');
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

async function runTest() {
  try {
    await setup();
    const passed = await testEditBlockWithReadFile();
    await cleanup();
    
    if (passed) {
      console.log('✅ All tests passed!');
      process.exit(0);
    } else {
      console.error('❌ Tests failed!');
      process.exit(1);
    }
  } catch (error) {
    console.error('Unhandled error:', error);
    await cleanup();
    process.exit(1);
  }
}

runTest();
