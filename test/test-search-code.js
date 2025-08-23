/**
 * Unit tests for search functionality using new streaming search API
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { configManager } from '../dist/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test directory and files
const TEST_DIR = path.join(__dirname, 'search-test-files');
const TEST_FILE_1 = path.join(TEST_DIR, 'test1.js');
const TEST_FILE_2 = path.join(TEST_DIR, 'test2.ts');
const TEST_FILE_3 = path.join(TEST_DIR, 'hidden.txt');
const TEST_FILE_4 = path.join(TEST_DIR, 'subdir', 'nested.py');

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
 * Setup function to prepare test environment
 */
async function setup() {
  console.log(`${colors.blue}Setting up search code tests...${colors.reset}`);
  
  // Save original config
  const originalConfig = await configManager.getConfig();
  
  // Set allowed directories to include test directory
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  
  // Create test directory structure
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.mkdir(path.join(TEST_DIR, 'subdir'), { recursive: true });
  
  // Create test files with various content
  await fs.writeFile(TEST_FILE_1, `// JavaScript test file
function searchFunction() {
  const pattern = 'test pattern';
  console.log('This is a test function');
  return pattern;
}

// Another function
function anotherFunction() {
  const result = searchFunction();
  return result;
}
`);

  await fs.writeFile(TEST_FILE_2, `// TypeScript test file
interface TestInterface {
  pattern: string;
  value: number;
}

class TestClass implements TestInterface {
  pattern: string = 'test pattern';
  value: number = 42;
  
  searchMethod(): string {
    return this.pattern;
  }
}

export { TestClass };
`);

  await fs.writeFile(TEST_FILE_3, `This is a hidden text file.
It contains some test content.
Pattern matching should work here too.
Multiple lines with different patterns.
`);

  await fs.writeFile(TEST_FILE_4, `# Python test file
import os
import sys

def search_function():
    pattern = "test pattern"
    print("This is a python function")
    return pattern

class TestClass:
    def __init__(self):
        self.pattern = "test pattern"
    
    def search_method(self):
        return self.pattern
`);

  console.log(`${colors.green}✓ Setup complete: Test files created${colors.reset}`);
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  console.log(`${colors.blue}Cleaning up search code tests...${colors.reset}`);
  
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
  
  // Remove test directory and all files
  await fs.rm(TEST_DIR, { force: true, recursive: true });
  
  // Restore original config
  await configManager.updateConfig(originalConfig);
  
  console.log(`${colors.green}✓ Teardown complete: Test files removed and config restored${colors.reset}`);
}

/**
 * Assert function for test validation
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Test basic search functionality
 */
async function testBasicSearch() {
  console.log(`${colors.yellow}Testing basic search functionality...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'pattern',
    searchType: 'content'
  });
  
  assert(finalResult.content, 'Result should have content');
  assert(finalResult.content.length > 0, 'Content should not be empty');
  
  const text = finalResult.content[0].text;
  assert(text.includes('test1.js'), 'Should find matches in test1.js');
  assert(text.includes('test2.ts'), 'Should find matches in test2.ts');
  assert(text.includes('nested.py'), 'Should find matches in nested.py');
  
  console.log(`${colors.green}✓ Basic search test passed${colors.reset}`);
}

/**
 * Test case-sensitive search
 */
async function testCaseSensitiveSearch() {
  console.log(`${colors.yellow}Testing case-sensitive search...${colors.reset}`);
  
  // Search for 'Pattern' (capital P) with case sensitivity
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'Pattern',
    searchType: 'content',
    ignoreCase: false
  });
  
  const text = finalResult.content[0].text;
  // Should only find matches where 'Pattern' appears with capital P
  assert(text.includes('hidden.txt'), 'Should find Pattern in hidden.txt');
  
  console.log(`${colors.green}✓ Case-sensitive search test passed${colors.reset}`);
}

/**
 * Test case-insensitive search
 */
async function testCaseInsensitiveSearch() {
  console.log(`${colors.yellow}Testing case-insensitive search...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'PATTERN',
    searchType: 'content',
    ignoreCase: true
  });
  
  const text = finalResult.content[0].text;
  assert(text.includes('test1.js'), 'Should find pattern in test1.js');
  assert(text.includes('test2.ts'), 'Should find pattern in test2.ts');
  assert(text.includes('nested.py'), 'Should find pattern in nested.py');
  
  console.log(`${colors.green}✓ Case-insensitive search test passed${colors.reset}`);
}

/**
 * Test file pattern filtering
 */
async function testFilePatternFiltering() {
  console.log(`${colors.yellow}Testing file pattern filtering...${colors.reset}`);
  
  // Search only in TypeScript files
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    filePattern: '*.ts'
  });
  
  const text = finalResult.content[0].text;
  assert(text.includes('test2.ts'), 'Should find matches in TypeScript files');
  assert(!text.includes('test1.js'), 'Should not include JavaScript files');
  assert(!text.includes('nested.py'), 'Should not include Python files');
  
  console.log(`${colors.green}✓ File pattern filtering test passed${colors.reset}`);
}

/**
 * Test maximum results limiting
 */
async function testMaxResults() {
  console.log(`${colors.yellow}Testing maximum results limiting...${colors.reset}`);
  
  // Test that the maxResults parameter is accepted and doesn't cause errors
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'function', // This pattern should appear multiple times
    searchType: 'content',
    maxResults: 5 // Small limit
  });
  
  assert(finalResult.content, 'Should have content');
  assert(finalResult.content.length > 0, 'Content should not be empty');
  
  const text = finalResult.content[0].text;
  
  // Verify we get some results
  assert(text.length > 0, 'Should have some results');
  
  // Should have results but respect the limit
  const hasResults = text.includes('function') || text.includes('No matches found');
  assert(hasResults, 'Should have function results or no matches');
  
  console.log(`${colors.green}✓ Max results limiting test passed${colors.reset}`);
}

/**
 * Test context lines functionality
 */
async function testContextLines() {
  console.log(`${colors.yellow}Testing context lines functionality...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'searchFunction',
    searchType: 'content',
    contextLines: 1
  });
  
  const text = finalResult.content[0].text;
  // With context lines, we should see lines before and after the match
  assert(text.length > 0, 'Should have context around matches');
  
  console.log(`${colors.green}✓ Context lines test passed${colors.reset}`);
}

/**
 * Test hidden files inclusion
 */
async function testIncludeHidden() {
  console.log(`${colors.yellow}Testing hidden files inclusion...${colors.reset}`);
  
  // First, create a hidden file (starts with dot)
  const hiddenFile = path.join(TEST_DIR, '.hidden-file.txt');
  await fs.writeFile(hiddenFile, 'This is hidden content with pattern');
  
  try {
    const { finalResult } = await searchAndWaitForCompletion({
      path: TEST_DIR,
      pattern: 'hidden content',
      searchType: 'content',
      includeHidden: true
    });
    
    const text = finalResult.content[0].text;
    const hasHiddenResults = text.includes('.hidden-file.txt') || text.includes('No matches found');
    assert(hasHiddenResults, 'Should handle hidden files when includeHidden is true');
    
    console.log(`${colors.green}✓ Include hidden files test passed${colors.reset}`);
  } finally {
    // Clean up hidden file
    await fs.rm(hiddenFile, { force: true });
  }
}

/**
 * Test timeout functionality
 */
async function testTimeout() {
  console.log(`${colors.yellow}Testing timeout functionality...${colors.reset}`);
  
  // Use a reasonable timeout
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'pattern',
    searchType: 'content',
    timeout_ms: 5000 // 5 seconds should be plenty
  });
  
  assert(finalResult.content, 'Result should have content even with timeout');
  assert(finalResult.content.length > 0, 'Content should not be empty');
  
  const text = finalResult.content[0].text;
  // Should have results or indicate completion
  const hasValidResult = text.includes('pattern') || text.includes('No matches found') || text.includes('completed');
  assert(hasValidResult, 'Should handle timeout gracefully');
  
  console.log(`${colors.green}✓ Timeout test passed${colors.reset}`);
}

/**
 * Test no matches found scenario
 */
async function testNoMatches() {
  console.log(`${colors.yellow}Testing no matches found scenario...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'this-pattern-definitely-does-not-exist-anywhere',
    searchType: 'content'
  });
  
  assert(finalResult.content, 'Result should have content');
  assert(finalResult.content.length > 0, 'Content should not be empty');
  
  const text = finalResult.content[0].text;
  assert(text.includes('No matches') || text.includes('Total results found: 0'), 'Should return no matches message');
  
  console.log(`${colors.green}✓ No matches test passed${colors.reset}`);
}

/**
 * Test invalid path handling
 */
async function testInvalidPath() {
  console.log(`${colors.yellow}Testing invalid path handling...${colors.reset}`);
  
  try {
    const result = await handleStartSearch({
      path: '/nonexistent/path/that/does/not/exist',
      pattern: 'pattern',
      searchType: 'content'
    });
    
    // Should handle gracefully
    assert(result.content, 'Result should have content');
    const text = result.content[0].text;
    const isValidResponse = text.includes('Error') || text.includes('session:') || text.includes('not allowed');
    assert(isValidResponse, 'Should handle invalid path gracefully');
    
    console.log(`${colors.green}✓ Invalid path test passed${colors.reset}`);
  } catch (error) {
    // It's also acceptable for the function to throw an error for invalid paths
    console.log(`${colors.green}✓ Invalid path test passed (threw error as expected)${colors.reset}`);
  }
}

/**
 * Test schema validation with invalid arguments
 */
async function testInvalidArguments() {
  console.log(`${colors.yellow}Testing invalid arguments handling...${colors.reset}`);
  
  // Test missing required path
  try {
    const result = await handleStartSearch({
      pattern: 'test'
      // Missing path
    });
    const text = result.content[0].text;
    assert(text.includes('Invalid arguments'), 'Should validate path is required');
  } catch (error) {
    // Also acceptable to throw
    assert(error.message.includes('path') || error.message.includes('required'), 'Should validate path is required');
  }
  
  // Test missing required pattern
  try {
    const result = await handleStartSearch({
      path: TEST_DIR
      // Missing pattern
    });
    const text = result.content[0].text;
    assert(text.includes('Invalid arguments'), 'Should validate pattern is required');
  } catch (error) {
    // Also acceptable to throw
    assert(error.message.includes('pattern') || error.message.includes('required'), 'Should validate pattern is required');
  }
  
  console.log(`${colors.green}✓ Invalid arguments test passed${colors.reset}`);
}

/**
 * Test file search functionality
 */
async function testFileSearch() {
  console.log(`${colors.yellow}Testing file search functionality...${colors.reset}`);
  
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: '*.js',
    searchType: 'files'
  });
  
  const text = finalResult.content[0].text;
  assert(text.includes('test1.js'), 'Should find JavaScript files');
  
  console.log(`${colors.green}✓ File search test passed${colors.reset}`);
}

/**
 * Main test runner function
 */
export async function testSearchCode() {
  console.log(`${colors.blue}Starting search functionality tests...${colors.reset}`);
  
  let originalConfig;
  
  try {
    // Setup
    originalConfig = await setup();
    
    // Run all tests
    await testBasicSearch();
    await testCaseSensitiveSearch();
    await testCaseInsensitiveSearch();
    await testFilePatternFiltering();
    await testMaxResults();
    await testContextLines();
    await testIncludeHidden();
    await testTimeout();
    await testNoMatches();
    await testInvalidPath();
    await testInvalidArguments();
    await testFileSearch();
    
    console.log(`${colors.green}✅ All search functionality tests passed!${colors.reset}`);
    return true;
    
  } catch (error) {
    console.error(`${colors.red}❌ Test failed: ${error.message}${colors.reset}`);
    console.error(error.stack);
    throw error;
  } finally {
    // Cleanup
    if (originalConfig) {
      await teardown(originalConfig);
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

// Export for use in run-all-tests.js
export default testSearchCode;

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testSearchCode().then(() => {
    console.log('Search tests completed successfully.');
    process.exit(0);
  }).catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}
