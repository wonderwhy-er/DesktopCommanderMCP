
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import { configManager } from '../dist/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FILEPATH = path.join(__dirname, 'test.txt')

async function setup() {
  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  return originalConfig;
}


/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {

  // Reset configuration to original
  await configManager.updateConfig(originalConfig);

  await fs.rm(TEST_FILEPATH, { force: true, recursive: true });
  // Clean up test directories
  console.log('✓ Teardown: test directories cleaned up and config restored');
}



// Export the main test function
async function testEditBlock() {
    try {
        await configManager.setValue('allowedDirectories', [__dirname]);
        
        // Create a test file
        const fs = await import('fs/promises');
        await fs.writeFile(TEST_FILEPATH, 'This is old content to replace');

        // Test handleEditBlock
        const result = await handleEditBlock({
            file_path: TEST_FILEPATH,
            old_string: 'old content',
            new_string: 'new content',
            expected_replacements: 1
        });

        console.log('Edit block result:', result);

        const fileContent = await fs.readFile(TEST_FILEPATH, 'utf8');
        console.log('File content after replacement:', fileContent);

        if (fileContent.includes('new content')) {
            console.log('Replace test passed!');
        } else {
            throw new Error('Replace test failed!');
        }

        // Cleanup
        await fs.unlink(TEST_FILEPATH);
        console.log('All tests passed! 🎉');
        return true;
    } catch (error) {
        console.error('Test failed:', error);
        return false;
    }
}


// Export the main test function
export default async function runTests() {
    let originalConfig;
    try {
      originalConfig = await setup();
      await testEditBlock();
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return false;
    } finally {
      if (originalConfig) {
        await teardown(originalConfig);
      }
    }
    return true;
}


// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
runTests().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
});
}
