import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEditBlock, performSearchReplace } from './dist/tools/edit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testMultipleBlocks() {
  try {
    console.log('Starting multi-block test');
    
    // Create test file
    const testFilePath = path.join(__dirname, 'test-edit-block.txt');
    
    // Read original content to verify at the end
    console.log('Reading original file content');
    const originalContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Original content:\n', originalContent);
    
    // Read the multi-block file
    console.log('Parsing multi-block file');
    const blockContent = await fs.readFile(path.join(__dirname, 'test-multiple-blocks.txt'), 'utf8');
    
    // Parse the blocks
    const parsed = await parseEditBlock(blockContent);
    console.log('Parsed block result:', JSON.stringify(parsed, null, 2));
    
    // Perform the replacements
    console.log('Performing replacements');
    const result = await performSearchReplace(parsed.filePath, parsed.searchReplace);
    console.log('Replacement result:', JSON.stringify(result, null, 2));
    
    // Read the modified content
    const modifiedContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Modified content:\n', modifiedContent);

    // Create expected content with the specific replacements
    let expectedContent = originalContent
      .replace('First pattern: This line will be replaced first.', 'First block replacement successful.')
      .replace('Second pattern: This line will be replaced globally.', 'Second block replacement successful.')
      .replace('Second pattern: This line will be replaced globally.', 'Second block replacement successful.');

    // The third pattern in the test file doesn't exist in the original content, so no further replacements

    // Verify the replacements were successful
    if (modifiedContent !== expectedContent) {
      throw new Error('Content does not match expected replacements');
    }
    
    // Restore the original content
    await fs.writeFile(testFilePath, originalContent);
    console.log('Test file restored to original content');
    
    console.log('Multi-block test completed successfully');
    return true;
  } catch (error) {
    console.error('Test failed:', error);
    return false;
  }
}

// Run the test
testMultipleBlocks().then(success => {
  console.log('Test result:', success ? 'PASSED' : 'FAILED');
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
