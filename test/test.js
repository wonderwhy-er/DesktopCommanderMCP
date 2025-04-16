
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEditBlock, performSearchReplace } from '../dist/tools/edit.js';
import { configManager } from '../dist/config-manager.js';

// Export the main test function
export default async function runTests() {
    // Store original config to restore later
    let originalConfig;
    
    try {
        // Save original configuration
        originalConfig = await configManager.getConfig();
        
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        
        // Set allowed directories for this test
        await configManager.setValue('allowedDirectories', [__dirname]);
        // Test parseEditBlock
        const testBlock = `test.txt
<<<<<<< SEARCH
old content
=======
new content
>>>>>>> REPLACE`;

        const parsed = await parseEditBlock(testBlock);
        console.log('Parse test passed:', parsed);

        // Create a test file
        const fs = await import('fs/promises');
        const testFilePath = path.join(__dirname, 'test.txt');
        await fs.writeFile(testFilePath, 'This is old content to replace');

        // Test performSearchReplace
        await performSearchReplace(testFilePath, {
            search: 'old content',
            replace: 'new content'
        });

        const result = await fs.readFile(testFilePath, 'utf8');
        console.log('File content after replacement:', result);

        if (result.includes('new content')) {
            console.log('Replace test passed!');
        } else {
            throw new Error('Replace test failed!');
        }

        // Cleanup
        await fs.unlink(testFilePath);
        console.log('All tests passed! 🎉');
        return true;
    } catch (error) {
        console.error('Test failed:', error);
        return false;
    } finally {
        // Restore original configuration
        if (originalConfig) {
            console.log('Restoring original configuration...');
            await configManager.updateConfig(originalConfig);
        }
    }
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
    runTests().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}
