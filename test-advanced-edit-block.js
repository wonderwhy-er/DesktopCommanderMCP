import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEditBlock, performSearchReplace } from './dist/tools/edit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  try {
    console.log('=== Advanced Edit Block Feature Test ===\n');
    
    // Create test files
    const testFilePath = path.join(__dirname, 'test-advanced-edit.txt');
    
    // Test content with multiple occurrences and mixed case
    const testContent = `This is a test file for the advanced edit_block functionality.
It contains MULTIPLE instances of the SAME text.
This is to test global replacement.
This is to test global replacement.
This is to test global replacement.
It also contains text with MIXED case for case-insensitive testing.
Some text with MiXeD CaSe for testing case-insensitive matching.`;
    
    await fs.writeFile(testFilePath, testContent);
    console.log('Created test file with content:\n', testContent);
    
    // Test 1: Global replacement
    console.log('\n--- Test 1: Global Replacement ---');
    const globalBlockContent = `${testFilePath}
<<<<<<< SEARCH:g
This is to test global replacement.
=======
This line has been replaced globally.
>>>>>>> REPLACE`;
    
    const globalParsed = await parseEditBlock(globalBlockContent);
    console.log('Parsed block with global flag:', JSON.stringify(globalParsed, null, 2));
    
    const globalResult = await performSearchReplace(testFilePath, globalParsed.searchReplace);
    console.log('Global replacement result:', JSON.stringify(globalResult, null, 2));
    
    const globalContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after global replacement:\n', globalContent);
    
    // Restore original content
    await fs.writeFile(testFilePath, testContent);
    
    // Test 2: Case-insensitive replacement
    console.log('\n--- Test 2: Case-Insensitive Replacement ---');
    const caseBlockContent = `${testFilePath}
<<<<<<< SEARCH:i
text with MIXED case
=======
text with case-insensitive match
>>>>>>> REPLACE`;
    
    const caseParsed = await parseEditBlock(caseBlockContent);
    console.log('Parsed block with case-insensitive flag:', JSON.stringify(caseParsed, null, 2));
    
    const caseResult = await performSearchReplace(testFilePath, caseParsed.searchReplace);
    console.log('Case-insensitive replacement result:', JSON.stringify(caseResult, null, 2));
    
    const caseContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after case-insensitive replacement:\n', caseContent);
    
    // Restore original content
    await fs.writeFile(testFilePath, testContent);
    
    // Test 3: Combined flags (global & case-insensitive)
    console.log('\n--- Test 3: Combined Flags (Global & Case-Insensitive) ---');
    const combinedBlockContent = `${testFilePath}
<<<<<<< SEARCH:gi
mixed case
=======
CASE-INSENSITIVE AND GLOBAL match
>>>>>>> REPLACE`;
    
    const combinedParsed = await parseEditBlock(combinedBlockContent);
    console.log('Parsed block with combined flags:', JSON.stringify(combinedParsed, null, 2));
    
    const combinedResult = await performSearchReplace(testFilePath, combinedParsed.searchReplace);
    console.log('Combined flags replacement result:', JSON.stringify(combinedResult, null, 2));
    
    const combinedContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after combined flags replacement:\n', combinedContent);
    
    // Test 4: Dry run
    console.log('\n--- Test 4: Dry Run ---');
    const dryRunBlockContent = `${testFilePath}
<<<<<<< SEARCH:d
This is a test file
=======
THIS SHOULD NOT BE APPLIED
>>>>>>> REPLACE`;
    
    const dryRunParsed = await parseEditBlock(dryRunBlockContent);
    console.log('Parsed block with dry run flag:', JSON.stringify(dryRunParsed, null, 2));
    
    const dryRunResult = await performSearchReplace(testFilePath, dryRunParsed.searchReplace);
    console.log('Dry run replacement result:', JSON.stringify(dryRunResult, null, 2));
    
    const dryRunContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after dry run (should be unchanged):\n', dryRunContent);
    
    // Test 5: Error handling (pattern not found)
    console.log('\n--- Test 5: Error Handling (Pattern Not Found) ---');
    const notFoundBlockContent = `${testFilePath}
<<<<<<< SEARCH
This pattern doesn't exist in the file
=======
This replacement won't be applied
>>>>>>> REPLACE`;
    
    const notFoundParsed = await parseEditBlock(notFoundBlockContent);
    console.log('Parsed block with non-existent pattern:', JSON.stringify(notFoundParsed, null, 2));
    
    const notFoundResult = await performSearchReplace(testFilePath, notFoundParsed.searchReplace);
    console.log('Non-existent pattern result:', JSON.stringify(notFoundResult, null, 2));
    
    // Test 6: Multiple blocks in a single operation
    console.log('\n--- Test 6: Multiple Blocks with Mix of Flags ---');
    const multiBlockContent = `${testFilePath}
<<<<<<< SEARCH:g
This is to test
=======
Testing multi-block
>>>>>>> REPLACE
<<<<<<< SEARCH:i
MIXED case
=======
mixed-case fixed
>>>>>>> REPLACE
<<<<<<< SEARCH
non-existent pattern
=======
won't be applied
>>>>>>> REPLACE`;
    
    const multiParsed = await parseEditBlock(multiBlockContent);
    console.log('Parsed multiple blocks:', JSON.stringify(multiParsed, null, 2));
    
    const multiResult = await performSearchReplace(testFilePath, multiParsed.searchReplace);
    console.log('Multi-block replacement result:', JSON.stringify(multiResult, null, 2));
    
    const multiContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Content after multi-block replacement:\n', multiContent);
    
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
