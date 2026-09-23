import assert from 'assert';
import os from 'os';
import path from 'path';
import { sanitizeError, buildEventProperties } from '../dist/utils/capture.js';
import { runIfMain } from './helpers/run-if-main.js';

// Helper function to run a test and report results
const runTest = async (name, testFn) => {
    try {
        await testFn();
        console.log(`✅ Test passed: ${name}`);
        return true;
    } catch (error) {
        console.error(`❌ Test failed: ${name}`);
        console.error(error);
        return false;
    }
};

// Main test function that will be exported
const runAllTests = async () => {
    let allPassed = true;
    
    // Test sanitization of error objects with file paths
    allPassed = await runTest('sanitizeError - Error object with path', () => {
        const mockError = new Error('Failed to read file at /Users/username/sensitive/path/file.txt');
        const sanitized = sanitizeError(mockError);
        
        assert(!sanitized.message.includes('/Users/username/sensitive/path/file.txt'), 'Error message should not contain file path');
        assert(sanitized.message.includes('[PATH]'), 'Error message should replace path with [PATH]');
    }) && allPassed;

    // Test sanitization of Windows-style paths
    allPassed = await runTest('sanitizeError - Windows path', () => {
        const mockError = new Error('Failed to read file at C:\\Users\\username\\Documents\\file.txt');
        const sanitized = sanitizeError(mockError);
        
        assert(!sanitized.message.includes('C:\\Users\\username\\Documents\\file.txt'), 'Error message should not contain Windows file path');
        assert(sanitized.message.includes('[PATH]'), 'Error message should replace Windows path with [PATH]');
    }) && allPassed;

    // Test sanitization of error with multiple paths
    allPassed = await runTest('sanitizeError - Multiple paths', () => {
        const mockError = new Error('Failed to move file from /path/source.txt to /path/destination.txt');
        const sanitized = sanitizeError(mockError);
        
        assert(!sanitized.message.includes('/path/source.txt'), 'Error message should not contain source path');
        assert(!sanitized.message.includes('/path/destination.txt'), 'Error message should not contain destination path');
        assert(sanitized.message.includes('[PATH]'), 'Error message should replace paths with [PATH]');
    }) && allPassed;

    // Test sanitization of string errors
    allPassed = await runTest('sanitizeError - String error', () => {
        const errorString = 'Cannot access /var/log/sensitive/data.log due to permissions';
        const sanitized = sanitizeError(errorString);
        
        assert(!sanitized.message.includes('/var/log/sensitive/data.log'), 'String error should not contain file path');
        assert(sanitized.message.includes('[PATH]'), 'String error should replace path with [PATH]');
    }) && allPassed;

    // Test error code preservation
    allPassed = await runTest('sanitizeError - Error code preservation', () => {
        const mockError = new Error('ENOENT: no such file or directory, open \'/path/to/file.txt\'');
        mockError.code = 'ENOENT';
        
        const sanitized = sanitizeError(mockError);
        
        assert(sanitized.code === 'ENOENT', 'Error code should be preserved');
        assert(!sanitized.message.includes('/path/to/file.txt'), 'Error message should not contain file path');
    }) && allPassed;

    // Test path with special characters
    allPassed = await runTest('sanitizeError - Path with special characters', () => {
        const mockError = new Error('Failed to process /path/with-special_chars/file!@#$%.txt');
        const sanitized = sanitizeError(mockError);
        
        assert(!sanitized.message.includes('/path/with-special_chars/file!@#$%.txt'), 'Error message should sanitize paths with special characters');
    }) && allPassed;

    // No fragment of a path may survive: names with spaces, hyphens and quotes
    allPassed = await runTest('sanitizeError - No path fragments survive', () => {
        const home = os.homedir();
        const cases = [
            ['Failed to read C:\\Users\\John Smith\\secret-project\\a.txt', 'Error: Failed to read [PATH]'],
            ["ENOENT: no such file or directory, open 'C:\\Users\\John Smith\\my notes.txt'", "Error: ENOENT: no such file or directory, open '[PATH]'"],
            ['Cannot open "/home/jane doe/private-docs/tax 2025.pdf"', 'Error: Cannot open "[PATH]"'],
            ['Failed to process /path/with-special_chars/file!@#$%.txt', 'Error: Failed to process [PATH]'],
            ['Failed to move file from /path/source.txt to /path/destination.txt', 'Error: Failed to move file from [PATH] to [PATH]'],
            [`Failed to read ${process.cwd()}${path.sep}sensitive${path.sep}file.txt`, 'Error: Failed to read [PATH]'],
            [`Failed to read ${home}`, 'Error: Failed to read [PATH]'],
            [`Failed to read ${home}${path.sep}notes.txt: permission denied`, 'Error: Failed to read [PATH] permission denied'],
        ];
        for (const [message, expected] of cases) {
            assert.strictEqual(sanitizeError(new Error(message)).message, expected);
        }
    }) && allPassed;

    // Test non-error input
    allPassed = await runTest('sanitizeError - Non-error input', () => {
        const nonError = { custom: 'object' };
        const sanitized = sanitizeError(nonError);
        
        assert(sanitized.message === 'Unknown error', 'Non-error objects should be handled gracefully');
    }) && allPassed;

    // Test actual paths from the current environment
    allPassed = await runTest('sanitizeError - Actual system paths', () => {
        const currentDir = process.cwd();
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        
        const mockError = new Error(`Failed to operate on ${currentDir} or ${homeDir}`);
        const sanitized = sanitizeError(mockError);
        
        assert(!sanitized.message.includes(currentDir), 'Error message should not contain current directory');
        assert(!sanitized.message.includes(homeDir), 'Error message should not contain home directory');
    }) && allPassed;

    // Integration: the properties capture() actually sends for an Error object
    allPassed = await runTest('Integration - capture with error object', async () => {
        const error = new Error(`Failed to read ${process.cwd()}/sensitive/file.txt`);
        error.code = 'ENOENT';

        const properties = await buildEventProperties({ error, operation: 'read_file' });

        assert(typeof properties.error === 'string', 'Error property should be a string');
        assert(!properties.error.includes(process.cwd()), `Error should not contain file path, got: ${properties.error}`);
        assert(properties.error.includes('Failed to read'), `Error message should survive sanitization, got: ${properties.error}`);
        assert.strictEqual(properties.errorCode, 'ENOENT', 'Error code should be kept');
    }) && allPassed;

    console.log('All error sanitization tests complete.');
    return allPassed;
};

// Run tests if this file is executed directly
runIfMain(import.meta.url, runAllTests);

// Export the test function for the test runner
export default runAllTests;
