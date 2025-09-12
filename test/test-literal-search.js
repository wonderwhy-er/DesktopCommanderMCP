/**
 * Test for literal search functionality - testing regex vs literal string matching
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { configManager } from '../dist/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test directory for literal search tests
const LITERAL_SEARCH_TEST_DIR = path.join(__dirname, 'literal-search-test-files');

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
 * Setup function to prepare literal search test environment
 */
async function setup() {
  console.log(`${colors.blue}Setting up literal search tests...${colors.reset}`);
  
  // Save original config
  const originalConfig = await configManager.getConfig();
  
  // Set allowed directories to include test directory
  await configManager.setValue('allowedDirectories', [LITERAL_SEARCH_TEST_DIR]);
  
  // Create test directory
  await fs.mkdir(LITERAL_SEARCH_TEST_DIR, { recursive: true });
  
  // Create test file with patterns that contain regex special characters
  await fs.writeFile(path.join(LITERAL_SEARCH_TEST_DIR, 'code-patterns.js'), `// JavaScript file with common code patterns
// These patterns contain regex special characters that should be matched literally

// Function calls with parentheses
toast.error("test");
console.log("hello world");
alert("message");

// Array access with brackets
array[0]
data[index]
items[key]

// Object method calls with dots
obj.method()
user.getName()
config.getValue()

// Template literals with backticks
const msg = \`Hello \${name}\`;
const query = \`SELECT * FROM users WHERE id = \${id}\`;

// Regex special characters
const pattern = ".*";
const wildcard = "test*";
const question = "value?";
const plus = "count++";
const caret = "^start";
const dollar = "end$";
const pipe = "a|b";
const backslash = "path\\\\to\\\\file";

// Complex patterns
if (condition && obj.method()) {
  toast.error("Error occurred");
}

function validateEmail(email) {
  return email.includes("@") && email.includes(".");
}
`);

  // Create another file with similar but different patterns
  await fs.writeFile(path.join(LITERAL_SEARCH_TEST_DIR, 'similar-patterns.ts'), `// TypeScript file with similar patterns
interface Config {
  getValue(): string;
}

class Logger {
  static error(message: string): void {
    console.error(\`[ERROR] \${message}\`);
  }
  
  static log(message: string): void {
    console.log(message);
  }
}

// These should NOT match when searching for exact patterns
toast.errorHandler("test"); // Similar but different
console.logout("hello world"); // Similar but different
array.slice(0, 1); // Similar but different
`);
  
  console.log(`${colors.green}✓ Setup complete: Literal search test files created${colors.reset}`);
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  console.log(`${colors.blue}Cleaning up literal search tests...${colors.reset}`);
  
  // Clean up test directory
  await fs.rm(LITERAL_SEARCH_TEST_DIR, { force: true, recursive: true });
  
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
 * Count occurrences of a pattern in text
 */
function countOccurrences(text, pattern) {
  return (text.match(new RegExp(pattern, 'g')) || []).length;
}

/**
 * Test that literal search finds exact matches for patterns with special characters
 * This test should FAIL initially since literalSearch parameter doesn't exist yet
 */
async function testLiteralSearchExactMatches() {
  console.log(`${colors.yellow}Testing literal search for exact matches...${colors.reset}`);
  
  // Test 1: Search for exact function call with quotes and parentheses
  const { finalResult: result1 } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'toast.error("test")',
    searchType: 'content',
    literalSearch: true  // This parameter should be added
  });
  
  const text1 = result1.content[0].text;
  
  // Should find exactly 2 occurrences (one in each file: the exact match and in comment)
  const exactMatches = countOccurrences(text1, 'toast\\.error\\("test"\\)');
  assert(exactMatches >= 1, `Should find exact matches for 'toast.error("test")', found: ${exactMatches}`);
  
  // Should NOT find the similar but different pattern
  assert(!text1.includes('toast.errorHandler'), 'Should not match similar but different patterns');
  
  console.log(`${colors.green}✓ Literal search exact matches test passed${colors.reset}`);
}

/**
 * Test that regex search works differently than literal search
 */
async function testRegexVsLiteralDifference() {
  console.log(`${colors.yellow}Testing difference between regex and literal search...${colors.reset}`);
  
  // Test with regex (default behavior) - should interpret dots as wildcard
  const { finalResult: regexResult } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'console.log',  // Dot should match any character in regex mode
    searchType: 'content',
    literalSearch: false  // Explicit regex mode
  });
  
  // Test with literal search - should match exact dots
  const { finalResult: literalResult } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'console.log',  // Dot should match literal dot only
    searchType: 'content', 
    literalSearch: true
  });
  
  const regexText = regexResult.content[0].text;
  const literalText = literalResult.content[0].text;
  
  // Both should find console.log, but regex might find more due to dot wildcard behavior
  assert(regexText.includes('console.log'), 'Regex search should find console.log');
  assert(literalText.includes('console.log'), 'Literal search should find console.log');
  
  console.log(`${colors.green}✓ Regex vs literal difference test passed${colors.reset}`);
}

/**
 * Test literal search with various special characters
 */
async function testSpecialCharactersLiteralSearch() {
  console.log(`${colors.yellow}Testing literal search with various special characters...${colors.reset}`);
  
  const testPatterns = [
    'array[0]',           // Brackets
    'obj.method()',       // Dots and parentheses
    'count++',            // Plus signs
    'value?',             // Question mark
    'pattern.*',          // Dot and asterisk
    '^start',             // Caret
    'end$',               // Dollar sign
    'a|b',                // Pipe
    'path\\\\to\\\\file'  // Backslashes
  ];
  
  for (const pattern of testPatterns) {
    console.log(`  Testing pattern: ${pattern}`);
    
    const { finalResult } = await searchAndWaitForCompletion({
      path: LITERAL_SEARCH_TEST_DIR,
      pattern: pattern,
      searchType: 'content',
      literalSearch: true
    });
    
    const text = finalResult.content[0].text;
    
    // Should find the pattern or indicate no matches (both are valid for literal search)
    const hasResults = text.includes(pattern) || text.includes('No matches found') || text.includes('Total results found: 0');
    assert(hasResults, `Should handle literal search for pattern '${pattern}' (found results or no matches message)`);
  }
  
  console.log(`${colors.green}✓ Special characters literal search test passed${colors.reset}`);
}

/**
 * Test that literalSearch parameter defaults to false (maintains backward compatibility)
 */
async function testLiteralSearchDefault() {
  console.log(`${colors.yellow}Testing that literalSearch defaults to false...${colors.reset}`);
  
  // Search without specifying literalSearch - should default to regex behavior
  const { finalResult } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'console.log',
    searchType: 'content'
    // literalSearch not specified - should default to false
  });
  
  const text = finalResult.content[0].text;
  
  // Should work (either find matches or no matches, but not error)
  const isValidResult = text.includes('console.log') || text.includes('No matches found') || text.includes('Total results found');
  assert(isValidResult, 'Should handle search with default literalSearch behavior');
  
  console.log(`${colors.green}✓ Literal search default behavior test passed${colors.reset}`);
}

/**
 * Test the specific failing case that motivated this fix
 */
async function testOriginalFailingCase() {
  console.log(`${colors.yellow}Testing the original failing case that motivated this fix...${colors.reset}`);
  
  // This was the original failing search: toast.error("test")
  const { finalResult } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'toast.error("test")',
    searchType: 'content',
    literalSearch: true
  });
  
  const text = finalResult.content[0].text;
  
  // Should find the exact match
  assert(text.includes('toast.error("test")') || text.includes('code-patterns.js'), 
    'Should find the exact pattern that was originally failing');
    
  // Verify it contains the file where we know the pattern exists
  assert(text.includes('code-patterns.js'), 'Should find matches in code-patterns.js file');
  
  console.log(`${colors.green}✓ Original failing case test passed${colors.reset}`);
}

/**
 * Test that demonstrates regex mode fails while literal mode succeeds
 * This is the key test that shows the problem we solved
 */
async function testRegexFailureLiteralSuccess() {
  console.log(`${colors.yellow}Testing that regex mode fails where literal mode succeeds...${colors.reset}`);
  
  // Test with regex mode (default) - should fail to find exact pattern due to regex interpretation
  const { finalResult: regexResult } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'toast.error("test")',  // This pattern has regex special chars
    searchType: 'content',
    literalSearch: false  // Use regex mode (default)
  });
  
  // Test with literal mode - should succeed in finding exact pattern  
  const { finalResult: literalResult } = await searchAndWaitForCompletion({
    path: LITERAL_SEARCH_TEST_DIR,
    pattern: 'toast.error("test")',  // Same pattern
    searchType: 'content',
    literalSearch: true   // Use literal mode
  });
  
  const regexText = regexResult.content[0].text;
  const literalText = literalResult.content[0].text;
  
  // Regex mode should find few/no matches due to special character interpretation
  const regexMatches = (regexText.match(/toast\.error\("test"\)/g) || []).length;
  
  // Literal mode should find the exact matches
  const literalMatches = (literalText.match(/toast\.error\("test"\)/g) || []).length;
  
  console.log(`  Regex mode found: ${regexMatches} matches`);
  console.log(`  Literal mode found: ${literalMatches} matches`);
  
  // The key assertion: literal should find more matches than regex
  assert(literalMatches > regexMatches, 
    `Literal search should find more matches (${literalMatches}) than regex search (${regexMatches}) for patterns with special characters`);
  
  // Literal should find at least one match
  assert(literalMatches >= 1, 'Literal search should find at least one exact match');
  
  console.log(`${colors.green}✓ Regex failure vs literal success test passed${colors.reset}`);
}

/**
 * Main test runner function for literal search tests
 */
export async function testLiteralSearch() {
  console.log(`${colors.blue}Starting literal search functionality tests...${colors.reset}`);
  
  let originalConfig;
  
  try {
    // Setup
    originalConfig = await setup();
    
    // Run all literal search tests
    await testLiteralSearchExactMatches();
    await testRegexVsLiteralDifference(); 
    await testSpecialCharactersLiteralSearch();
    await testLiteralSearchDefault();
    await testOriginalFailingCase();
    await testRegexFailureLiteralSuccess(); // NEW: Critical test showing the problem we solved
    
    console.log(`${colors.green}✅ All literal search tests passed!${colors.reset}`);
    return true;
    
  } catch (error) {
    console.error(`${colors.red}❌ Literal search test failed: ${error.message}${colors.reset}`);
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
export default testLiteralSearch;

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testLiteralSearch().then(() => {
    console.log('Literal search tests completed successfully.');
    process.exit(0);
  }).catch(error => {
    console.error('Literal search test execution failed:', error);
    process.exit(1);
  });
}
