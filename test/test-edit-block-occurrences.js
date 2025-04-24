/**
 * Test script for edit_block functionality with multiple occurrences
 * 
 * This script tests how edit_block handles multiple occurrences:
 * 1. Testing failure when more occurrences than expected
 * 2. Testing failure when fewer occurrences than expected
 * 3. Testing success when exactly the right number of occurrences
 * 4. Testing context-specific replacements
 * 5. Testing handling of non-existent patterns
 * 6. Testing handling of empty search strings
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
const TEST_DIR = path.join(__dirname, 'test_edit_occurrences');
const MULTI_OCCURRENCE_FILE = path.join(TEST_DIR, 'multiple_occurrences.txt');
const CONTEXT_TEST_FILE = path.join(TEST_DIR, 'context_test.txt');

/**
 * Setup function to prepare the test environment
 */
async function setup() {
  // Create test directory
  await fs.mkdir(TEST_DIR, { recursive: true });
  
  // Create test files
  await fs.writeFile(MULTI_OCCURRENCE_FILE, 
    `This is a repeating line.
This is a unique line.
This is a repeating line.
This is another unique line.
This is a repeating line.
One more unique line.
This is a repeating line.`);

  await fs.writeFile(CONTEXT_TEST_FILE,
    `Header section
This is a target line.
End of header section

Main content section
This is a target line.
More content here
This is a target line.
End of main content

Footer section
This is a target line.
End of footer`);
  
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
 * Test case when there are more occurrences than expected
 */
async function testMoreOccurrencesThanExpected() {
  console.log('\nTest 1: More occurrences than expected');
  
  try {
    // Allow access to test directory
    await configManager.setValue('allowedDirectories', [TEST_DIR]);
    
    // Try to replace all occurrences but only specify 1 expected replacement
    const result = await handleEditBlock({
      file_path: MULTI_OCCURRENCE_FILE,
      old_string: 'This is a repeating line.',
      new_string: 'This line has been changed.',
      expected_replacements: 1
    });
    
    // Check that we got an error about the number of occurrences
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Expected 1 occurrences but found 4'),
      'Should report the correct number of occurrences'
    );
    
    console.log('✓ Test correctly failed with more occurrences than expected');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test case when there are fewer occurrences than expected
 */
async function testFewerOccurrencesThanExpected() {
  console.log('\nTest 2: Fewer occurrences than expected');
  
  try {
    // Try to replace with more expected replacements than actual occurrences
    const result = await handleEditBlock({
      file_path: MULTI_OCCURRENCE_FILE,
      old_string: 'This is another unique line.',
      new_string: 'This unique line has been modified.',
      expected_replacements: 3
    });
    
    // Check that we got an error about the number of occurrences
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Expected 3 occurrences but found 1'),
      'Should report the correct number of occurrences'
    );
    
    console.log('✓ Test correctly failed with fewer occurrences than expected');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test case with exactly the right number of occurrences
 */
async function testExactNumberOfOccurrences() {
  console.log('\nTest 3: Exactly the right number of occurrences');
  
  try {
    // Replace with correct number of expected replacements
    const result = await handleEditBlock({
      file_path: MULTI_OCCURRENCE_FILE,
      old_string: 'This is a repeating line.',
      new_string: 'This line has been replaced correctly.',
      expected_replacements: 4
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 4 edits'),
      'Should report success with the correct number of edits'
    );
    
    // Verify the file content
    const fileContent = await fs.readFile(MULTI_OCCURRENCE_FILE, 'utf8');
    const expectedContent = 
      `This line has been replaced correctly.
This is a unique line.
This line has been replaced correctly.
This is another unique line.
This line has been replaced correctly.
One more unique line.
This line has been replaced correctly.`;
    
    assert.strictEqual(fileContent, expectedContent, 'File content should be updated correctly');
    
    console.log('✓ Test succeeded with exact number of occurrences');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test context-specific replacements to target specific occurrences
 */
async function testContextSpecificReplacements() {
  console.log('\nTest 4: Context-specific replacements');
  
  try {
    // Target the occurrence in the header section using context
    let result = await handleEditBlock({
      file_path: CONTEXT_TEST_FILE,
      old_string: `Header section
This is a target line.`,
      new_string: `Header section
This is a MODIFIED target line in the header.`,
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the header edit'
    );
    
    // Target the occurrence in the footer section using context
    result = await handleEditBlock({
      file_path: CONTEXT_TEST_FILE,
      old_string: `Footer section
This is a target line.`,
      new_string: `Footer section
This is a MODIFIED target line in the footer.`,
      expected_replacements: 1
    });
    
    // Check that the operation succeeded
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Successfully applied 1 edit'),
      'Should report success with the footer edit'
    );
    
    // Verify the file content
    const fileContent = await fs.readFile(CONTEXT_TEST_FILE, 'utf8');
    const expectedContent = 
      `Header section
This is a MODIFIED target line in the header.
End of header section

Main content section
This is a target line.
More content here
This is a target line.
End of main content

Footer section
This is a MODIFIED target line in the footer.
End of footer`;
    
    assert.strictEqual(fileContent, expectedContent, 'File content should be updated correctly');
    
    console.log('✓ Test succeeded with context-specific replacements');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test case for string pattern that doesn't exist
 */
async function testNonExistentPattern() {
  console.log('\nTest 5: Non-existent pattern');
  
  try {
    // Try to replace a pattern that doesn't exist
    const result = await handleEditBlock({
      file_path: CONTEXT_TEST_FILE,
      old_string: 'This pattern does not exist in the file.',
      new_string: 'This replacement will not be applied.',
      expected_replacements: 1
    });
    
    // Check that we got an error about not finding the content
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Search content not found'),
      'Should report that the search content was not found'
    );
    
    console.log('✓ Test correctly handled non-existent pattern');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Test case for empty search string
 */
async function testEmptySearchString() {
  console.log('\nTest 6: Empty search string');
  
  try {
    // Try to use an empty search string
    const result = await handleEditBlock({
      file_path: CONTEXT_TEST_FILE,
      old_string: '',
      new_string: 'This replacement should not be applied.',
      expected_replacements: 1
    });
    
    // Check that we got the appropriate error message
    assert.strictEqual(result.content[0].type, 'text', 'Result should be text');
    assert.ok(
      result.content[0].text.includes('Empty search strings are not allowed'),
      'Should report that empty search strings are not allowed'
    );
    
    console.log('✓ Test correctly rejected empty search string');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

/**
 * Main test function
 */
async function runEditBlockOccurrencesTests() {
  console.log('=== edit_block Multiple Occurrences Tests ===\n');
  
  // Test 1: More occurrences than expected
  await testMoreOccurrencesThanExpected();
  
  // Test 2: Fewer occurrences than expected
  await testFewerOccurrencesThanExpected();
  
  // Test 3: Exactly the right number of occurrences
  await testExactNumberOfOccurrences();
  
  // Test 4: Context-specific replacements
  await testContextSpecificReplacements();
  
  // Test 5: Non-existent pattern
  await testNonExistentPattern();
  
  // Test 6: Empty search string
  await testEmptySearchString();
  
  console.log('\n✅ All edit_block multiple occurrences tests passed!');
}

// Export the main test function
export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await runEditBlockOccurrencesTests();
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
  return true;
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
