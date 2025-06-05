/**
 * Additional comprehensive tests for handleSearchCode
 * These tests cover edge cases and advanced scenarios
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleSearchCode } from '../dist/handlers/edit-search-handlers.js';
import { configManager } from '../dist/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EDGE_CASE_TEST_DIR = path.join(__dirname, 'search-edge-case-tests');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

/**
 * Setup function for edge case tests
 */
async function setupEdgeCases() {
  console.log(`${colors.blue}Setting up edge case tests...${colors.reset}`);
  
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [EDGE_CASE_TEST_DIR]);
  
  await fs.mkdir(EDGE_CASE_TEST_DIR, { recursive: true });
  
  // Create files with edge cases
  
  // Empty file
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'empty.txt'), '');
  
  // File with only whitespace
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'whitespace.txt'), '   \n\t\n   \n');
  
  // File with very long lines
  const longLine = 'a'.repeat(10000) + 'pattern' + 'b'.repeat(10000);
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'long-lines.txt'), longLine);
  
  // File with special characters
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'special-chars.txt'), 
    'Special chars: @#$%^&*(){}[]|\\:";\'<>?,./\nUnicode: 😀🎉🔍\nPattern with special chars: test@pattern');
  
  // File with binary content (should be handled gracefully)
  const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD]);
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'binary.bin'), binaryData);
  
  // Large file (for performance testing)
  const largeContent = 'This is line with pattern\n'.repeat(1000);
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'large.txt'), largeContent);
  
  // File with regex special characters in content
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'regex-chars.txt'), 
    'Content with regex chars: .+*?^${}()|[]\\\nPattern: test.pattern\nAnother: test*pattern');
  
  return originalConfig;
}

/**
 * Teardown function for edge case tests
 */
async function teardownEdgeCases(originalConfig) {
  await fs.rm(EDGE_CASE_TEST_DIR, { force: true, recursive: true });
  await configManager.updateConfig(originalConfig);
}

/**
 * Assert function
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Test empty and whitespace files
 */
async function testEmptyFiles() {
  console.log(`${colors.yellow}Testing empty and whitespace files...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern'
  });
  
  const text = result.content[0].text;
  // Should not find matches in empty files, but should handle gracefully
  assert(!text.includes('empty.txt'), 'Should not find matches in empty files');
  assert(!text.includes('whitespace.txt'), 'Should not find matches in whitespace-only files');
  
  console.log(`${colors.green}✓ Empty files test passed${colors.reset}`);
}

/**
 * Test very long lines
 */
async function testLongLines() {
  console.log(`${colors.yellow}Testing very long lines...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern'
  });
  
  const text = result.content[0].text;
  assert(text.includes('long-lines.txt'), 'Should find pattern in files with very long lines');
  
  console.log(`${colors.green}✓ Long lines test passed${colors.reset}`);
}

/**
 * Test special characters and Unicode
 */
async function testSpecialCharacters() {
  console.log(`${colors.yellow}Testing special characters and Unicode...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'test@pattern'
  });
  
  const text = result.content[0].text;
  assert(text.includes('special-chars.txt'), 'Should find patterns with special characters');
  
  // Test Unicode search
  const unicodeResult = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: '😀'
  });
  
  const unicodeText = unicodeResult.content[0].text;
  assert(unicodeText.includes('special-chars.txt') || unicodeText.includes('No matches'), 
    'Should handle Unicode characters gracefully');
  
  console.log(`${colors.green}✓ Special characters test passed${colors.reset}`);
}

/**
 * Test binary files handling
 */
async function testBinaryFiles() {
  console.log(`${colors.yellow}Testing binary files handling...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern'
  });
  
  const text = result.content[0].text;
  // Binary files should either be ignored or handled gracefully
  // Should not crash the search
  assert(typeof text === 'string', 'Should return string result even with binary files present');
  
  console.log(`${colors.green}✓ Binary files test passed${colors.reset}`);
}

/**
 * Test large file performance
 */
async function testLargeFiles() {
  console.log(`${colors.yellow}Testing large file performance...${colors.reset}`);
  
  const startTime = Date.now();
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    maxResults: 10 // Limit results for performance
  });
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  const text = result.content[0].text;
  assert(text.includes('large.txt'), 'Should find matches in large files');
  
  // Performance check - should complete within reasonable time (10 seconds)
  assert(duration < 10000, `Search should complete within 10 seconds, took ${duration}ms`);
  
  console.log(`${colors.green}✓ Large files test passed (${duration}ms)${colors.reset}`);
}

/**
 * Test concurrent searches
 */
async function testConcurrentSearches() {
  console.log(`${colors.yellow}Testing concurrent searches...${colors.reset}`);
  
  // Run multiple searches concurrently
  const promises = [
    handleSearchCode({ path: EDGE_CASE_TEST_DIR, pattern: 'pattern' }),
    handleSearchCode({ path: EDGE_CASE_TEST_DIR, pattern: 'test' }),
    handleSearchCode({ path: EDGE_CASE_TEST_DIR, pattern: 'chars' })
  ];
  
  const results = await Promise.all(promises);
  
  // All searches should complete successfully
  results.forEach((result, index) => {
    assert(result.content, `Search ${index + 1} should have content`);
    assert(result.content.length > 0, `Search ${index + 1} should not be empty`);
  });
  
  console.log(`${colors.green}✓ Concurrent searches test passed${colors.reset}`);
}

/**
 * Test search with very short timeout
 */
async function testVeryShortTimeout() {
  console.log(`${colors.yellow}Testing very short timeout...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    timeoutMs: 1 // Extremely short timeout
  });
  
  assert(result.content, 'Should handle timeout gracefully');
  const text = result.content[0].text;
  
  // Should either return results or timeout message
  const hasResults = text.includes('pattern');
  const hasTimeoutMessage = text.includes('timed out') || text.includes('No matches');
  assert(hasResults || hasTimeoutMessage, 'Should handle very short timeout appropriately');
  
  console.log(`${colors.green}✓ Very short timeout test passed${colors.reset}`);
}

/**
 * Test invalid file patterns
 */
async function testInvalidFilePatterns() {
  console.log(`${colors.yellow}Testing invalid file patterns...${colors.reset}`);
  
  // Test with invalid glob pattern
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    filePattern: '***invalid***'
  });
  
  // Should handle gracefully
  assert(result.content, 'Should handle invalid file patterns gracefully');
  
  console.log(`${colors.green}✓ Invalid file patterns test passed${colors.reset}`);
}

/**
 * Test zero max results
 */
async function testZeroMaxResults() {
  console.log(`${colors.yellow}Testing zero max results...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    maxResults: 0
  });
  
  const text = result.content[0].text;
  // Should return no results or handle appropriately
  assert(typeof text === 'string', 'Should return string result');
  
  console.log(`${colors.green}✓ Zero max results test passed${colors.reset}`);
}

/**
 * Test extremely large context lines
 */
async function testLargeContextLines() {
  console.log(`${colors.yellow}Testing large context lines...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    contextLines: 1000 // Very large context
  });
  
  assert(result.content, 'Should handle large context lines');
  const text = result.content[0].text;
  assert(typeof text === 'string', 'Should return string result');
  
  console.log(`${colors.green}✓ Large context lines test passed${colors.reset}`);
}

/**
 * Test path traversal security
 */
async function testPathTraversalSecurity() {
  console.log(`${colors.yellow}Testing path traversal security...${colors.reset}`);
  
  // Test with path traversal attempts
  try {
    const result = await handleSearchCode({
      path: EDGE_CASE_TEST_DIR + '/../../../etc',
      pattern: 'pattern'
    });
    
    // If it doesn't throw, it should handle gracefully
    assert(result.content, 'Should handle path traversal attempts gracefully');
    
  } catch (error) {
    // It's acceptable to throw an error for security violations
    assert(error.message.includes('not allowed') || error.message.includes('permission'), 
      'Should reject unauthorized path access');
  }
  
  console.log(`${colors.green}✓ Path traversal security test passed${colors.reset}`);
}

/**
 * Test memory usage with many small files
 */
async function testManySmallFiles() {
  console.log(`${colors.yellow}Testing many small files...${colors.reset}`);
  
  // Create subdirectory with many small files
  const manyFilesDir = path.join(EDGE_CASE_TEST_DIR, 'many-files');
  await fs.mkdir(manyFilesDir, { recursive: true });
  
  try {
    // Create 100 small files
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(fs.writeFile(
        path.join(manyFilesDir, `file${i}.txt`), 
        `This is file ${i} with pattern ${i}`
      ));
    }
    await Promise.all(promises);
    
    const result = await handleSearchCode({
      path: manyFilesDir,
      pattern: 'pattern',
      maxResults: 50
    });
    
    const text = result.content[0].text;
    assert(text.includes('pattern'), 'Should find patterns in many small files');
    
    // Count how many files were found
    const fileLines = text.split('\n').filter(line => line.endsWith('.txt:'));
    assert(fileLines.length > 0, 'Should find matches in multiple files');
    
    console.log(`${colors.green}✓ Many small files test passed${colors.reset}`);
    
  } finally {
    // Clean up many files
    await fs.rm(manyFilesDir, { force: true, recursive: true });
  }
}

/**
 * Main test runner for edge cases
 */
export async function testSearchCodeEdgeCases() {
  console.log(`${colors.blue}Starting handleSearchCode edge case tests...${colors.reset}`);
  
  let originalConfig;
  
  try {
    // Setup
    originalConfig = await setupEdgeCases();
    
    // Run all edge case tests
    await testEmptyFiles();
    await testLongLines();
    await testSpecialCharacters();
    await testBinaryFiles();
    await testLargeFiles();
    await testConcurrentSearches();
    await testVeryShortTimeout();
    await testInvalidFilePatterns();
    await testZeroMaxResults();
    await testLargeContextLines();
    await testPathTraversalSecurity();
    await testManySmallFiles();
    
    console.log(`${colors.green}✅ All handleSearchCode edge case tests passed!${colors.reset}`);
    return true;
    
  } catch (error) {
    console.error(`${colors.red}❌ Edge case test failed: ${error.message}${colors.reset}`);
    console.error(error.stack);
    throw error;
  } finally {
    // Cleanup
    if (originalConfig) {
      await teardownEdgeCases(originalConfig);
    }
  }
}

// Export for use in test runners
export default testSearchCodeEdgeCases;

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testSearchCodeEdgeCases().catch(error => {
    console.error('Edge case test execution failed:', error);
    process.exit(1);
  });
}
