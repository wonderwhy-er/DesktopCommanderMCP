/**
 * Unit tests for search functionality using new streaming search API
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { searchAndWaitForCompletion } from './helpers/search.js';
import { configManager } from '../dist/config-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

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

  // Remove test directory and all files
  await fs.rm(TEST_DIR, { force: true, recursive: true });
  
  // Restore original config
  await configManager.updateConfig(originalConfig);
  
  console.log(`${colors.green}✓ Teardown complete: Test files removed and config restored${colors.reset}`);
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
  // Only hidden.txt has 'Pattern' with a capital P; the other files say 'pattern'
  assert(text.includes('hidden.txt'), 'Should find Pattern in hidden.txt');
  assert.strictEqual(finalResult.structuredContent.totalMatches, 1, `Case-sensitive search should match only hidden.txt, got: ${text}`);
  
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
  
  // Count the lines containing 'function' in the fixture files written by setup()
  let expectedMatches = 0;
  for (const file of [TEST_FILE_1, TEST_FILE_2, TEST_FILE_3, TEST_FILE_4]) {
    const content = await fs.readFile(file, 'utf8');
    expectedMatches += content.split('\n').filter((line) => line.includes('function')).length;
  }

  const { finalResult: unlimited } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'function',
    searchType: 'content',
    ignoreCase: false
  });
  assert.strictEqual(unlimited.structuredContent.totalMatches, expectedMatches,
    `Without a limit all ${expectedMatches} matching lines should be found`);

  const maxResults = 2;
  const { finalResult } = await searchAndWaitForCompletion({
    path: TEST_DIR,
    pattern: 'function',
    searchType: 'content',
    ignoreCase: false,
    maxResults
  });

  const { totalMatches } = finalResult.structuredContent;
  assert(totalMatches > 0 && totalMatches <= maxResults,
    `maxResults: ${maxResults} should limit the search to ${maxResults} results, got ${totalMatches}`);
  
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
  // 'searchFunction' is on lines 2 and 10 of test1.js; context adds the lines around them
  const { totalMatches, totalResults } = finalResult.structuredContent;
  assert.strictEqual(totalMatches, 2, 'Should find both searchFunction lines');
  assert(totalResults > totalMatches, `Context lines should be returned alongside matches (${totalResults} results for ${totalMatches} matches)`);
  assert(text.includes('JavaScript test file'), `Line 1 should appear as context before the first match, got: ${text}`);
  
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
    assert(text.includes('.hidden-file.txt'), `includeHidden: true should search dot-files, got: ${text}`);

    // Control: without includeHidden the dot-file is skipped
    const { finalResult: withoutHidden } = await searchAndWaitForCompletion({
      path: TEST_DIR,
      pattern: 'hidden content',
      searchType: 'content',
      includeHidden: false
    });
    assert.strictEqual(withoutHidden.structuredContent.totalMatches, 0, 'includeHidden: false should skip dot-files');
    
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
  
  // A generous timeout must not cut the search short
  assert(finalResult.structuredContent.isComplete, 'Search should complete within the timeout');
  assert(finalResult.structuredContent.totalMatches > 0, `Search with timeout_ms should still find matches, got: ${finalResult.content[0].text}`);
  
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
  assert.strictEqual(finalResult.structuredContent.totalMatches, 0, 'Should find no matches');
  assert(text.includes('No matches found'), `Should tell the caller nothing matched, got: ${text}`);
  
  console.log(`${colors.green}✓ No matches test passed${colors.reset}`);
}

/**
 * Test invalid path handling
 */
async function testInvalidPath() {
  console.log(`${colors.yellow}Testing invalid path handling...${colors.reset}`);
  
  // setup() limits allowedDirectories to TEST_DIR, so this path must be refused
  const result = await handleStartSearch({
    path: '/nonexistent/path/that/does/not/exist',
    pattern: 'pattern',
    searchType: 'content'
  });

  const text = result.content[0].text;
  assert(result.isError === true, `Search outside allowedDirectories should be an error, got: ${text}`);
  assert(text.includes('not allowed'), `Error should say the path is not allowed, got: ${text}`);

  console.log(`${colors.green}✓ Invalid path test passed${colors.reset}`);
}

/**
 * Test schema validation with invalid arguments
 */
async function testInvalidArguments() {
  console.log(`${colors.yellow}Testing invalid arguments handling...${colors.reset}`);
  
  // The handler validates its arguments and returns an error result (it never throws)
  const missingPath = await handleStartSearch({ pattern: 'test' });
  assert(missingPath.isError === true, 'Missing path should be rejected');
  assert(missingPath.content[0].text.includes('Invalid arguments') && missingPath.content[0].text.includes('path'),
    `Error should name the missing path argument, got: ${missingPath.content[0].text}`);

  const missingPattern = await handleStartSearch({ path: TEST_DIR });
  assert(missingPattern.isError === true, 'Missing pattern should be rejected');
  assert(missingPattern.content[0].text.includes('Invalid arguments') && missingPattern.content[0].text.includes('pattern'),
    `Error should name the missing pattern argument, got: ${missingPattern.content[0].text}`);
  
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
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();

    // Cleanup
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
}

// Export for use in run-all-tests.js
export default testSearchCode;

// Run tests if this file is executed directly
runIfMain(import.meta.url, testSearchCode);
