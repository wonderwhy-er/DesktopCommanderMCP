// Test script to verify enhanced file reading
import { readFileInternal } from '../dist/tools/filesystem.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the test directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_FILE_PATH = join(__dirname, 'test_output', 'file_with_1500_lines.txt');

async function testEnhancedReading() {
    let testsPassed = 0;
    let totalTests = 3;
    
    console.log('Testing enhanced file reading with our 1500-line file...');
    
    try {
        // Test 1: Read first 10 lines
        console.log('\n=== Test 1: Read first 10 lines ===');
        try {
            const result1 = await readFileInternal(TEST_FILE_PATH, 0, 10);
            console.log('Result length:', result1.length);
            console.log('First few lines of result:');
            console.log(result1.substring(0, 200) + '...');
            
            // Validate the result
            const lines = result1.split('\n').filter(line => line.length > 0);
            if (lines.length === 10 && lines[0].includes('line 1')) {
                testsPassed++;
                console.log('✓ Test 1 PASSED');
            } else {
                throw new Error(`Expected 10 lines starting with line 1, got ${lines.length} lines`);
            }
        } catch (error) {
            console.error('✗ Test 1 FAILED:', error.message);
        }
        
        // Test 2: Read from middle with offset
        console.log('\n=== Test 2: Read from offset 500, length 5 ===');
        try {
            const result2 = await readFileInternal(TEST_FILE_PATH, 500, 5);
            console.log('Result length:', result2.length);
            console.log('First few lines of result:');
            console.log(result2.substring(0, 200) + '...');
            
            // Validate the result
            const lines = result2.split('\n').filter(line => line.length > 0);
            if (lines.length === 5 && lines[0].includes('line 501')) {
                testsPassed++;
                console.log('✓ Test 2 PASSED');
            } else {
                throw new Error(`Expected 5 lines starting with line 501, got ${lines.length} lines, first line: ${lines[0]}`);
            }
        } catch (error) {
            console.error('✗ Test 2 FAILED:', error.message);
        }
        
        // Test 3: Read last 10 lines (using positive offset: 1490 for lines 1491-1500)
        console.log('\n=== Test 3: Read last 10 lines (lines 1491-1500) ===');
        try {
            const result3 = await readFileInternal(TEST_FILE_PATH, 1490, 10);
            console.log('Result length:', result3.length);
            console.log('First few lines of result:');
            console.log(result3.substring(0, 300) + '...');
            
            // Validate the result
            const lines = result3.split('\n').filter(line => line.length > 0);
            if (lines.length === 10 && lines[0].includes('line 1491') && lines[9].includes('line 1500')) {
                testsPassed++;
                console.log('✓ Test 3 PASSED');
            } else {
                throw new Error(`Expected 10 lines from 1491 to 1500, got ${lines.length} lines, first line: ${lines[0]}, last line: ${lines[lines.length-1]}`);
            }
        } catch (error) {
            console.error('✗ Test 3 FAILED:', error.message);
        }
        
        // Summary
        console.log(`\n=== SUMMARY ===`);
        console.log(`Tests passed: ${testsPassed}/${totalTests}`);
        
        if (testsPassed === totalTests) {
            console.log('🎉 All tests PASSED!');
            process.exit(0);
        } else {
            console.log('❌ Some tests FAILED!');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Test suite failed with error:', error);
        process.exit(1);
    }
}

testEnhancedReading().catch(console.error);
