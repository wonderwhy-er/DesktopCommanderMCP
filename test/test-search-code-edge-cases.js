/**
 * Additional comprehensive tests for search functionality using new streaming API
 * These tests cover edge cases and advanced scenarios
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
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
 * Helper function to wait for search completion and get all results
 */
async function searchAndWaitForCompletion(searchArgs, timeout = 10000) {
  const result = await handleStartSearch(searchArgs);
  
  // Extract session ID from result
  const sessionIdMatch = result.content[0].text.match(/Started .+ session: (.+)/);
  if (!sessionIdMatch) {
    throw new Error('Could not extract session ID from search result');
  }
  const sessionId = sessionIdMatch[1];
  
  try {
    // Wait for completion by polling
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const moreResults = await handleGetMoreSearchResults({ sessionId });
      
      if (moreResults.content[0].text.includes('✅ Search completed')) {
        return { initialResult: result, finalResult: moreResults, sessionId };
      }
      
      if (moreResults.content[0].text.includes('❌ ERROR')) {
        throw new Error(`Search failed: ${moreResults.content[0].text}`);
      }
      
      // Wait a bit before polling again
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error('Search timed out');
  } finally {
    // Always stop the search session to prevent hanging
    try {
      await handleStopSearch({ sessionId });
    } catch (e) {
      // Ignore errors when stopping - session might already be completed
    }
  }
}

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
  // Clean up any remaining search sessions
  try {
    const { handleListSearches, handleStopSearch } = await import('../dist/handlers/search-handlers.js');
    const sessionsResult = await handleListSearches();
    if (sessionsResult.content && sessionsResult.content[0] && sessionsResult.content[0].text) {
      const sessionsText = sessionsResult.content[0].text;
      if (!sessionsText.includes('No active searches')) {
        // Extract session IDs and stop them
        const sessionMatches = sessionsText.match(/Session: (\S+)/g);
        if (sessionMatches) {
          for (const match of sessionMatches) {
            const sessionId = match.replace('Session: ', '');
            try {
              await handleStopSearch({ sessionId });
            } catch (e) {
              // Ignore errors - session might already be stopped
            }
          }
        }
      }
    }
  } catch (e) {
    // Ignore errors in cleanup
  }
  
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
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content'
  });
  
  const text = finalResult.content[0].text;
  // Should not find matches in empty files, but should handle gracefully
  const isValidResponse = !text.includes('empty.txt') && !text.includes('whitespace.txt') || text.includes('No matches');
  assert(isValidResponse, 'Should not find matches in empty files');
  
  console.log(`${colors.green}✓ Empty files test passed${colors.reset}`);
}

/**
 * Test very long lines
 */
async function testLongLines() {
  console.log(`${colors.yellow}Testing very long lines...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content'
  });
  
  const text = finalResult.content[0].text;
  assert(text.includes('long-lines.txt'), 'Should find pattern in files with very long lines');
  
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
  
  console.log(`${colors.green}✓ Special characters test passed${colors.reset}`);
}

/**
 * Test binary files handling
 */
async function testBinaryFiles() {
  console.log(`${colors.yellow}Testing binary files handling...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content'
  });
  
  const text = finalResult.content[0].text;
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
  
  // Start multiple searches concurrently
  const promises = [
    handleStartSearch({ path: EDGE_CASE_TEST_DIR, pattern: 'pattern', searchType: 'content' }),
    handleStartSearch({ path: EDGE_CASE_TEST_DIR, pattern: 'test', searchType: 'content' }),
    handleStartSearch({ path: EDGE_CASE_TEST_DIR, pattern: 'chars', searchType: 'content' })
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
  
  const result = await handleStartSearch({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    timeout_ms: 1 // Extremely short timeout
  });
  
  assert(result.content, 'Should handle timeout gracefully');
  const text = result.content[0].text;
  
  // Should either return results or handle timeout gracefully
  const hasValidResponse = text.includes('session:') || text.includes('Error') || text.includes('timeout');
  assert(hasValidResponse, 'Should handle very short timeout appropriately');
  
  console.log(`${colors.green}✓ Very short timeout test passed${colors.reset}`);
}

/**
 * Test invalid file patterns
 */
async function testInvalidFilePatterns() {
  console.log(`${colors.yellow}Testing invalid file patterns...${colors.reset}`);
  
  // Test with invalid glob pattern
  const result = await handleStartSearch({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
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
  
  const result = await handleStartSearch({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    maxResults: 0
  });
  
  const text = result.content[0].text;
  // Should return appropriate response
  assert(typeof text === 'string', 'Should return string result');
  
  console.log(`${colors.green}✓ Zero max results test passed${colors.reset}`);
}

/**
 * Test extremely large context lines
 */
async function testLargeContextLines() {
  console.log(`${colors.yellow}Testing large context lines...${colors.reset}`);
  
  const result = await handleStartSearch({
    path: EDGE_CASE_TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
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
    const result = await handleStartSearch({
      path: EDGE_CASE_TEST_DIR + '/../../../etc',
      pattern: 'pattern',
      searchType: 'content'
    });
    
    // If it doesn't throw, it should handle gracefully
    assert(result.content, 'Should handle path traversal attempts gracefully');
    const text = result.content[0].text;
    const isSecure = text.includes('not allowed') || text.includes('Error') || text.includes('permission');
    assert(isSecure, 'Should handle path traversal securely');
    
  } catch (error) {
    // It's acceptable to throw an error for security violations
    const isSecurityError = error.message.includes('not allowed') || error.message.includes('permission');
    assert(isSecurityError, 'Should reject unauthorized path access');
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
    
    const { finalResult } = await searchAndWaitForCompletion({
      path: manyFilesDir,
      pattern: 'pattern',
      searchType: 'content',
      maxResults: 50
    });
    
    const text = finalResult.content[0].text;
    assert(text.includes('pattern') || text.includes('No matches'), 'Should handle many small files');
    
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
    // Cleanup
    if (originalConfig) {
      await teardownEdgeCases(originalConfig);
    }
    
    // Force cleanup of search manager to ensure process can exit
    try {
      const { searchManager, stopSearchManagerCleanup } = await import('../dist/search-manager.js');
      
      // Terminate all active sessions
      const activeSessions = searchManager.listSearchSessions();
      for (const session of activeSessions) {
        searchManager.terminateSearch(session.id);
      }
      
      // Stop the cleanup interval
      stopSearchManagerCleanup();
      
      // Clear the sessions map
      searchManager.sessions?.clear?.();
    } catch (e) {
      // Ignore import errors
    }
  }
}

// Export for use in test runners
export default testSearchCodeEdgeCases;

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testSearchCodeEdgeCases().then(() => {
    console.log('Edge case tests completed successfully.');
    process.exit(0);
  }).catch(error => {
    console.error('Edge case test execution failed:', error);
    process.exit(1);
  });
}
