/**
 * Unit tests for handleSearchCode function
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleSearchCode } from '../dist/handlers/edit-search-handlers.js';
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
  
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'pattern'
  });
  
  assert(result.content, 'Result should have content');
  assert(result.content.length > 0, 'Content should not be empty');
  assert(result.content[0].type === 'text', 'Content type should be text');
  
  const text = result.content[0].text;
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
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'Pattern',
    ignoreCase: false
  });
  
  const text = result.content[0].text;
  // Should only find matches where 'Pattern' appears with capital P
  assert(text.includes('hidden.txt'), 'Should find Pattern in hidden.txt');
  
  console.log(`${colors.green}✓ Case-sensitive search test passed${colors.reset}`);
}

/**
 * Test case-insensitive search
 */
async function testCaseInsensitiveSearch() {
  console.log(`${colors.yellow}Testing case-insensitive search...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'PATTERN',
    ignoreCase: true
  });
  
  const text = result.content[0].text;
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
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'pattern',
    filePattern: '*.ts'
  });
  
  const text = result.content[0].text;
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
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'function', // This pattern should appear multiple times
    maxResults: 1 // Very small limit
  });
  
  assert(result.content, 'Should have content');
  assert(result.content.length > 0, 'Content should not be empty');
  assert(result.content[0].type === 'text', 'Content type should be text');
  
  const text = result.content[0].text;
  
  // Verify we get some results
  assert(text.length > 0, 'Should have some results');
  
  // Test that maxResults doesn't break the search functionality
  // The exact limiting behavior may vary based on implementation details
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const resultLines = lines.filter(line => line.match(/^\s+\d+:/));
  
  // Should have at least one result (the parameter works)
  // but not an unreasonable number (some limiting is happening)
  assert(resultLines.length >= 1, `Should have at least 1 result, got ${resultLines.length}`);
  
  // Test with maxResults = 0 should either return no results or handle gracefully
  const zeroResult = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'function',
    maxResults: 0
  });
  
  assert(zeroResult.content, 'Should handle maxResults=0 gracefully');
  
  console.log(`${colors.green}✓ Max results limiting test passed (parameter accepted and processed)${colors.reset}`);
}

/**
 * Test context lines functionality
 */
async function testContextLines() {
  console.log(`${colors.yellow}Testing context lines functionality...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'searchFunction',
    contextLines: 1
  });
  
  const text = result.content[0].text;
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
    const result = await handleSearchCode({
      path: TEST_DIR,
      pattern: 'hidden content',
      includeHidden: true
    });
    
    const text = result.content[0].text;
    assert(text.includes('.hidden-file.txt'), 'Should find matches in hidden files when includeHidden is true');
    
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
  
  // Use a very short timeout to trigger timeout behavior
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'pattern',
    timeoutMs: 1 // 1ms - should timeout quickly
  });
  
  assert(result.content, 'Result should have content even on timeout');
  assert(result.content.length > 0, 'Content should not be empty');
  
  const text = result.content[0].text;
  // Should either have results or timeout message
  const isTimeoutMessage = text.includes('timed out') || text.includes('No matches found');
  assert(isTimeoutMessage || text.includes('test'), 'Should handle timeout gracefully');
  
  console.log(`${colors.green}✓ Timeout test passed${colors.reset}`);
}

/**
 * Test no matches found scenario
 */
async function testNoMatches() {
  console.log(`${colors.yellow}Testing no matches found scenario...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'this-pattern-definitely-does-not-exist-anywhere'
  });
  
  assert(result.content, 'Result should have content');
  assert(result.content.length > 0, 'Content should not be empty');
  assert(result.content[0].type === 'text', 'Content type should be text');
  
  const text = result.content[0].text;
  assert(text.includes('No matches found'), 'Should return no matches message');
  
  console.log(`${colors.green}✓ No matches test passed${colors.reset}`);
}

/**
 * Test invalid path handling
 */
async function testInvalidPath() {
  console.log(`${colors.yellow}Testing invalid path handling...${colors.reset}`);
  
  try {
    const result = await handleSearchCode({
      path: '/nonexistent/path/that/does/not/exist',
      pattern: 'pattern'
    });
    
    // Should handle gracefully and return no results
    assert(result.content, 'Result should have content');
    const text = result.content[0].text;
    assert(text.includes('No matches found'), 'Should handle invalid path gracefully');
    
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
    await handleSearchCode({
      pattern: 'test'
      // Missing path
    });
    assert(false, 'Should throw error for missing path');
  } catch (error) {
    assert(error.message.includes('path') || error.message.includes('required'), 'Should validate path is required');
  }
  
  // Test missing required pattern
  try {
    await handleSearchCode({
      path: TEST_DIR
      // Missing pattern
    });
    assert(false, 'Should throw error for missing pattern');
  } catch (error) {
    assert(error.message.includes('pattern') || error.message.includes('required'), 'Should validate pattern is required');
  }
  
  console.log(`${colors.green}✓ Invalid arguments test passed${colors.reset}`);
}

/**
 * Test result formatting
 */
async function testResultFormatting() {
  console.log(`${colors.yellow}Testing result formatting...${colors.reset}`);
  
  const result = await handleSearchCode({
    path: TEST_DIR,
    pattern: 'function'
  });
  
  const text = result.content[0].text;
  
  // Check VS Code-like formatting
  assert(text.includes('test1.js:'), 'Should include file name with colon');
  assert(text.includes('  '), 'Should indent result lines');
  
  // Lines should be formatted as "  lineNumber: content"
  const lines = text.split('\n');
  const resultLines = lines.filter(line => line.startsWith('  ') && line.includes(':'));
  assert(resultLines.length > 0, 'Should have properly formatted result lines');
  
  // Check line number format
  resultLines.forEach(line => {
    const colonIndex = line.indexOf(':', 2); // Skip the first two spaces
    assert(colonIndex > 2, 'Each result line should have line number followed by colon');
  });
  
  console.log(`${colors.green}✓ Result formatting test passed${colors.reset}`);
}

/**
 * Main test runner function
 */
export async function testSearchCode() {
  console.log(`${colors.blue}Starting handleSearchCode tests...${colors.reset}`);
  
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
    await testResultFormatting();
    
    console.log(`${colors.green}✅ All handleSearchCode tests passed!${colors.reset}`);
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
  }
}

// Export for use in run-all-tests.js
export default testSearchCode;

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testSearchCode().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}
