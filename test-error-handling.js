import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEditBlock, performSearchReplace } from './dist/tools/edit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  try {
    console.log('=== Edit Block Error Handling Test ===\n');
    
    // Test 1: Malformed block (missing separator)
    console.log('--- Test 1: Malformed Block (Missing Separator) ---');
    const malformedBlock = `/Users/davidleathers/dev/desktop-commander/test-error.txt
<<<<<<< SEARCH
Search content
>>>>>>> REPLACE`;  // Missing separator

    const malformedResult = await parseEditBlock(malformedBlock);
    console.log('Malformed block parsing result:', JSON.stringify(malformedResult, null, 2));
    
    // Test 2: Unclosed block
    console.log('\n--- Test 2: Unclosed Block ---');
    const unclosedBlock = `/Users/davidleathers/dev/desktop-commander/test-error.txt
<<<<<<< SEARCH
Search content
=======
Replace content`;  // Missing closing tag

    const unclosedResult = await parseEditBlock(unclosedBlock);
    console.log('Unclosed block parsing result:', JSON.stringify(unclosedResult, null, 2));
    
    // Test 3: Empty blocks
    console.log('\n--- Test 3: Empty Search/Replace Pair ---');
    const emptyBlock = `/Users/davidleathers/dev/desktop-commander/test-error.txt
<<<<<<< SEARCH
=======
>>>>>>> REPLACE`;

    const emptyResult = await parseEditBlock(emptyBlock);
    console.log('Empty block parsing result:', JSON.stringify(emptyResult, null, 2));
    
    // Test 4: Nested blocks (not supported)
    console.log('\n--- Test 4: Nested Blocks (Not Supported) ---');
    const nestedBlock = `/Users/davidleathers/dev/desktop-commander/test-error.txt
<<<<<<< SEARCH
Outer search
<<<<<<< SEARCH
Inner search
=======
Inner replace
>>>>>>> REPLACE
=======
Outer replace
>>>>>>> REPLACE`;

    const nestedResult = await parseEditBlock(nestedBlock);
    console.log('Nested block parsing result:', JSON.stringify(nestedResult, null, 2));
    
    // Test 5: Large pattern
    console.log('\n--- Test 5: Large Pattern Test ---');
    // Create a large pattern (just over the max size)
    const largePattern = 'A'.repeat(101 * 1024); // 101KB
    
    // Create a test file
    const testFilePath = path.join(__dirname, 'test-error.txt');
    await fs.writeFile(testFilePath, 'Test content with a small amount of text.');
    
    const largeBlock = `${testFilePath}
<<<<<<< SEARCH
${largePattern}
=======
Small replacement
>>>>>>> REPLACE`;

    const largeParsed = await parseEditBlock(largeBlock);
    console.log('Large pattern parsed successfully:', !!largeParsed);
    
    // Attempt to perform the replacement (should fail with size validation)
    const largeResult = await performSearchReplace(testFilePath, largeParsed.searchReplace);
    console.log('Large pattern replacement result:', JSON.stringify(largeResult, null, 2));
    
    // Clean up
    await fs.unlink(testFilePath);
    
    console.log('\n=== All Error Handling Tests Completed ===');
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
