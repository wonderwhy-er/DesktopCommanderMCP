// Test script to verify enhanced file reading
import { readFileFromDisk } from '../dist/tools/filesystem.js';

async function testEnhancedReading() {
    try {
        console.log('Testing enhanced file reading with our 1500-line file...');
        
        // Test 1: Read first 10 lines
        console.log('\n=== Test 1: Read first 10 lines ===');
        const result1 = await readFileFromDisk('/Users/eduardruzga/work/ClaudeServerCommander/new_folder/file_with_1500_lines.txt', 0, 10);
        console.log('Result length:', result1.content.length);
        console.log('First few lines of result:');
        console.log(result1.content.substring(0, 200) + '...');
        
        // Test 2: Read from middle with offset
        console.log('\n=== Test 2: Read from offset 500, length 5 ===');
        const result2 = await readFileFromDisk('/Users/eduardruzga/work/ClaudeServerCommander/new_folder/file_with_1500_lines.txt', 500, 5);
        console.log('Result length:', result2.content.length);
        console.log('First few lines of result:');
        console.log(result2.content.substring(0, 200) + '...');
        
        // Test 3: Read last 10 lines
        console.log('\n=== Test 3: Read last 10 lines ===');
        const result3 = await readFileFromDisk('/Users/eduardruzga/work/ClaudeServerCommander/new_folder/file_with_1500_lines.txt', -10, 10);
        console.log('Result length:', result3.content.length);
        console.log('First few lines of result:');
        console.log(result3.content.substring(0, 300) + '...');
        
        console.log('\nAll tests completed successfully!');
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testEnhancedReading().catch(console.error);
