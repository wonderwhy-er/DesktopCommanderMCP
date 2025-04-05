import { parseEditBlock, performSearchReplace } from '../dist/tools/edit.js';

// Export the main test function
export default async function runTests() {
    try {
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
        const testFilePath = 'test/test.txt';
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
    }
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
    runTests().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}
