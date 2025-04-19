import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEditBlock, performSearchReplace } from './dist/tools/edit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  try {
    console.log('=== Counted Replacements Test ===\n');
    
    // Create test file
    const testFilePath = path.join(__dirname, 'test-counted.txt');
    
    // Test content with multiple occurrences
    const testContent = `This is line 1 with the test pattern.
This is line 2 with the test pattern.
This is line 3 with the test pattern.
This is line 4 with the test pattern.
This is line 5 with the test pattern.`;
    
    await fs.writeFile(testFilePath, testContent);
    console.log('Created test file with content:\n', testContent);
    
    // Test 1: Replace just 2 occurrences
    console.log('\n--- Test 1: Replace First 2 Occurrences ---');
    const countBlockContent = `${testFilePath}
<<<<<<< SEARCH:n:2
test pattern
=======
REPLACED PATTERN
>>>>>>> REPLACE`;
    
    const countParsed = await parseEditBlock(countBlockContent);
    console.log('Parsed block with n:2 flag:', JSON.stringify(countParsed, null, 2));
    
    const countResult = await performSearchReplace(testFilePath, countParsed.searchReplace);
    console.log('Counted replacement result:', JSON.stringify(countResult, null, 2));
    
    const countContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after replacing first 2 occurrences:\n', countContent);
    
    // Restore original content
    await fs.writeFile(testFilePath, testContent);
    
    // Test 2: Case-insensitive with count
    console.log('\n--- Test 2: Case-Insensitive with Count ---');
    const mixedContent = `This is line 1 with the TEST pattern.
This is line 2 with the test PATTERN.
This is line 3 with the Test Pattern.
This is line 4 with the TEST PATTERN.
This is line 5 with the test pattern.`;
    
    await fs.writeFile(testFilePath, mixedContent);
    
    const caseCountBlock = `${testFilePath}
<<<<<<< SEARCH:i:n:3
test pattern
=======
counted case-insensitive
>>>>>>> REPLACE`;
    
    const caseCountParsed = await parseEditBlock(caseCountBlock);
    console.log('Parsed block with i:n:3 flags:', JSON.stringify(caseCountParsed, null, 2));
    
    const caseCountResult = await performSearchReplace(testFilePath, caseCountParsed.searchReplace);
    console.log('Case-insensitive counted replacement result:', JSON.stringify(caseCountResult, null, 2));
    
    const caseCountContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after case-insensitive counted replacement:\n', caseCountContent);
    
    // Test 3: Multiple blocks with count
    console.log('\n--- Test 3: Multiple Blocks with Different Counts ---');
    
    // Restore original content
    await fs.writeFile(testFilePath, testContent);
    
    const multiCountBlock = `${testFilePath}
<<<<<<< SEARCH:n:1
line 1
=======
FIRST LINE
>>>>>>> REPLACE
<<<<<<< SEARCH:n:2
line
=======
LINE
>>>>>>> REPLACE`;
    
    const multiCountParsed = await parseEditBlock(multiCountBlock);
    console.log('Parsed multiple blocks with counts:', JSON.stringify(multiCountParsed, null, 2));
    
    const multiCountResult = await performSearchReplace(testFilePath, multiCountParsed.searchReplace);
    console.log('Multiple blocks with counts result:', JSON.stringify(multiCountResult, null, 2));
    
    const multiCountContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after multiple blocks with counts:\n', multiCountContent);
    
    // Clean up
    await fs.unlink(testFilePath);
    console.log('\nTest file cleaned up');
    
    console.log('\n=== All Tests Completed Successfully ===');
    return true;
  } catch (error) {
    console.error('Error during test:', error);
    return false;
  }
}

// Run the test
runTest().then(success => {
  console.log('Test result:', success ? 'PASSED' : 'FAILED');
  process.exit(success ? 0 : 1);
});
