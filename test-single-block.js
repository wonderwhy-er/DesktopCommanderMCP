import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEditBlock, performSearchReplace } from './dist/tools/edit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testSingleBlock() {
  try {
    console.log('Starting single-block test (backward compatibility)');
    
    // Create test file
    const testFilePath = path.join(__dirname, 'test-edit-block.txt');
    
    // Read original content to verify at the end
    console.log('Reading original file content');
    const originalContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Original content:\n', originalContent);
    
    // Create simple block content
    const blockContent = `${testFilePath}\n<<<<<<< SEARCH\nFirst pattern: This line will be replaced first.\n=======\nSingle block replacement successful.\n>>>>>>> REPLACE`;
    
    // Parse the block
    console.log('Parsing single block content');
    const parsed = await parseEditBlock(blockContent);
    console.log('Parsed block result:', JSON.stringify(parsed, null, 2));
    
    // Try the original direct format (backward compatibility)
    console.log('Testing backward compatibility with single SearchReplace object');
    const directResult = await performSearchReplace(testFilePath, {
      search: 'First pattern: This line will be replaced first.',
      replace: 'Direct single object replacement successful.'
    });
    console.log('Direct replacement result:', JSON.stringify(directResult, null, 2));
    
    // Read the modified content
    const modifiedContent = await fs.readFile(testFilePath, 'utf8');
    console.log('Modified content:\n', modifiedContent);

    // Verify the replacement was successful
    const expectedContent = originalContent.replace(
      'First pattern: This line will be replaced first.',
      'Direct single object replacement successful.'
    );
    if (modifiedContent !== expectedContent) {
      throw new Error('Content does not match expected replacement');
    }
    
    // Restore the original content
    await fs.writeFile(testFilePath, originalContent);
    console.log('Test file restored to original content');
    
    console.log('Single-block backward compatibility test completed successfully');
    return true;
  } catch (error) {
    console.error('Test failed:', error);
    return false;
  }
}

// Run the test
testSingleBlock().then(success => {
  console.log('Test result:', success ? 'PASSED' : 'FAILED');
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
