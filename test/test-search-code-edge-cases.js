/**
 * Additional comprehensive tests for search functionality using new streaming API
 * These tests cover edge cases and advanced scenarios
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { searchAndWaitForCompletion, startSearchAndWait } from './helpers/search.js';
import { configManager } from '../dist/config-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

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
  
  // File with very long lines (use unique pattern to avoid conflicts with large.txt)
  const longLine = 'a'.repeat(10000) + 'LONGLINEPATTERN' + 'b'.repeat(10000);
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
 * Test empty and whitespace files
 */
async function testEmptyFiles() {
  console.log(`${colors.yellow}Testing empty and whitespace files...${colors.reset}`);
  
  // Search only the empty and whitespace-only files: nothing can match, nothing may break
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    filePattern: 'empty.txt|whitespace.txt'
  });

  assert(!finalResult.isError, `Search over empty files should not fail: ${finalResult.content[0].text}`);
  assert.strictEqual(finalResult.structuredContent.totalMatches, 0, 'Empty and whitespace-only files should not match');
  
  console.log(`${colors.green}✓ Empty files test passed${colors.reset}`);
}

/**
 * Test very long lines
 */
async function testLongLines() {
  console.log(`${colors.yellow}Testing very long lines...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'LONGLINEPATTERN',
    searchType: 'content'
  });
  
  const text = finalResult.content[0].text;
  assert(text.includes('long-lines.txt'), 'Should find pattern in files with very long lines');
  assert.strictEqual(finalResult.structuredContent.totalMatches, 1, 'The 20,000-character line holds exactly one match');
  
  console.log(`${colors.green}✓ Long lines test passed${colors.reset}`);
}

/**
 * Test special characters and Unicode
 */
async function testSpecialCharacters() {
  console.log(`${colors.yellow}Testing special characters and Unicode...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'test@pattern',
    searchType: 'content'
  });
  
  const text = finalResult.content[0].text;
  assert(text.includes('special-chars.txt'), 'Should find patterns with special characters');
  assert.strictEqual(finalResult.structuredContent.totalMatches, 1, 'Only special-chars.txt contains test@pattern');
  
  console.log(`${colors.green}✓ Special characters test passed${colors.reset}`);
}

/**
 * Test binary files handling
 */
async function testBinaryFiles() {
  console.log(`${colors.yellow}Testing binary files handling...${colors.reset}`);
  
  // Search only the binary file: it must not break the search or produce garbage matches
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    filePattern: '*.bin'
  });

  assert(!finalResult.isError, `Search over a binary file should not fail: ${finalResult.content[0].text}`);
  assert.strictEqual(finalResult.structuredContent.totalMatches, 0, 'The binary fixture contains no "pattern"');
  
  console.log(`${colors.green}✓ Binary files test passed${colors.reset}`);
}

/**
 * Test large file performance
 */
async function testLargeFiles() {
  console.log(`${colors.yellow}Testing large file performance...${colors.reset}`);
  
  const startTime = Date.now();
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    maxResults: 10 // Limit results for performance
  });
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  const text = finalResult.content[0].text;
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
  
  const patterns = ['pattern', 'test', 'chars'];
  const countMatches = async (pattern) => {
    const { finalResult } = await searchAndWaitForCompletion({ path: EDGE_CASE_TEST_DIR, pattern, searchType: 'content' });
    return finalResult.structuredContent.totalMatches;
  };

  // Concurrent sessions must not mix up each other's results
  const concurrent = await Promise.all(patterns.map(countMatches));
  const alone = [];
  for (const pattern of patterns) alone.push(await countMatches(pattern));

  assert(alone.every((count) => count > 0), `Each pattern should match something, got ${alone}`);
  assert.deepStrictEqual(concurrent, alone, 'Concurrent searches should find the same matches as searches run alone');
  
  console.log(`${colors.green}✓ Concurrent searches test passed${colors.reset}`);
}

/**
 * Test search with very short timeout
 */
async function testVeryShortTimeout() {
  console.log(`${colors.yellow}Testing very short timeout...${colors.reset}`);
  
  // A 1ms timeout must end the session promptly instead of hanging
  const sessionId = await startSearchAndWait({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    timeout_ms: 1 // Extremely short timeout
  }, 5000);
  await handleStopSearch({ sessionId });
  
  console.log(`${colors.green}✓ Very short timeout test passed${colors.reset}`);
}

/**
 * Test invalid file patterns
 */
async function testInvalidFilePatterns() {
  console.log(`${colors.yellow}Testing invalid file patterns...${colors.reset}`);
  
  // Test with an odd glob pattern that matches no file
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    filePattern: '***invalid***'
  });

  assert(!finalResult.isError, `An unmatched file pattern should not fail: ${finalResult.content[0].text}`);
  assert.strictEqual(finalResult.structuredContent.totalMatches, 0, 'No file matches ***invalid***');
  
  console.log(`${colors.green}✓ Invalid file patterns test passed${colors.reset}`);
}

/**
 * Test zero max results
 */
async function testZeroMaxResults() {
  console.log(`${colors.yellow}Testing zero max results...${colors.reset}`);
  
  // maxResults: 0 currently means "no limit"
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    maxResults: 0
  });

  assert(!finalResult.isError, `maxResults: 0 should not fail: ${finalResult.content[0].text}`);
  assert(finalResult.structuredContent.totalMatches > 0, 'maxResults: 0 should not suppress all results');
  
  console.log(`${colors.green}✓ Zero max results test passed${colors.reset}`);
}

/**
 * Test extremely large context lines
 */
async function testLargeContextLines() {
  console.log(`${colors.yellow}Testing large context lines...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    contextLines: 1000 // Very large context
  });

  assert(!finalResult.isError, `Large context should not fail: ${finalResult.content[0].text}`);
  assert(finalResult.structuredContent.totalMatches > 0, 'Large context should still find the matches');
  
  console.log(`${colors.green}✓ Large context lines test passed${colors.reset}`);
}

/**
 * Test path traversal security
 */
async function testPathTraversalSecurity() {
  console.log(`${colors.yellow}Testing path traversal security...${colors.reset}`);
  
  // allowedDirectories is EDGE_CASE_TEST_DIR, so '..' out of it must be refused as not allowed
  // (a mere "path does not exist" error would not prove the allowlist held)
  const result = await handleStartSearch({
    path: EDGE_CASE_TEST_DIR + '/../../../etc',
    pattern: 'pattern',
    searchType: 'content'
  });

  const text = result.content[0].text;
  assert(result.isError === true, `Path traversal should be refused, got: ${text}`);
  assert(text.includes('not allowed'), `Path traversal should be refused by the allowlist, got: ${text}`);
  
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
    
    const { finalResult } = await searchAndWaitForCompletion({
      path: manyFilesDir,
      pattern: 'pattern',
      searchType: 'content',
      maxResults: 50
    });
    
    // 100 files match once each; maxResults caps the total
    const { totalMatches } = finalResult.structuredContent;
    assert(totalMatches > 0 && totalMatches <= 50, `maxResults: 50 across 100 matching files should return 1-50 results, got ${totalMatches}`);
    
    console.log(`${colors.green}✓ Many small files test passed${colors.reset}`);
    
  } finally {
    // Clean up many files
    await fs.rm(manyFilesDir, { force: true, recursive: true });
  }
}

/**
 * Test filePattern with multiple values, including whitespace and empty tokens
 */
async function testFilePatternWithMultipleValues() {
  console.log(`${colors.yellow}Testing filePattern with multiple values...${colors.reset}`);

  // Create test files
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'file1.ts'), 'export const myTsVar = "patternTs";');
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'file2.js'), 'const myJsVar = "patternJs";');
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'file3.py'), 'my_py_var = "patternPy"');
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'file4.java'), 'String myJavaVar = "patternJava";');
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'file5.go'), 'var myGoVar = "patternGo"');
  await fs.writeFile(path.join(EDGE_CASE_TEST_DIR, 'file6.txt'), 'This is a text file.');

  // Test with valid multiple patterns
  let { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    filePattern: '*.ts|*.js|*.py'
  });
  let text = finalResult.content[0].text;
  assert(text.includes('file1.ts'), 'Should find match in file1.ts');
  assert(text.includes('file2.js'), 'Should find match in file2.js');
  assert(text.includes('file3.py'), 'Should find match in file3.py');
  assert(!text.includes('file4.java'), 'Should not find match in file4.java');
  assert(!text.includes('file5.go'), 'Should not find match in file5.go');

  // Test with patterns including whitespace
  ({ finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    filePattern: ' *.ts | *.js '
  }));
  text = finalResult.content[0].text;
  assert(text.includes('file1.ts'), 'Should find match with whitespace-padded patterns (file1.ts)');
  assert(text.includes('file2.js'), 'Should find match with whitespace-padded patterns (file2.js)');
  assert(!text.includes('file3.py'), 'Should not find match with whitespace-padded patterns (file3.py)');

  console.log(`${colors.green}✓ FilePattern with multiple values test passed${colors.reset}`);
}

/**
 * Main test runner for edge cases
 */
export async function testSearchCodeEdgeCases() {
  console.log(`${colors.blue}Starting search functionality edge case tests...${colors.reset}`);
  
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
    await testFilePatternWithMultipleValues();

    console.log(`${colors.green}✅ All search functionality edge case tests passed!${colors.reset}`);
    return true;
    
  } catch (error) {
    console.error(`${colors.red}❌ Edge case test failed: ${error.message}${colors.reset}`);
    console.error(error.stack);
    throw error;
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();

    // Cleanup
    if (originalConfig) {
      await teardownEdgeCases(originalConfig);
    }
  }
}

// Export for use in test runners
export default testSearchCodeEdgeCases;

// Run tests if this file is executed directly
runIfMain(import.meta.url, testSearchCodeEdgeCases);
