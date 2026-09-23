import assert from 'assert';
import path from 'path';
import { sanitizeError } from '../dist/utils/capture.js';
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

    // Integration test with capture function mock
    allPassed = await runTest('Integration - capture with error object', () => {
        // Create a mock capture function to test integration
        const mockCapture = (event, properties) => {
            // Check that no file paths are in the properties
            const stringified = JSON.stringify(properties);
            const containsPaths = /(?:\/|\\)[\w\d_.-\/\\]+/.test(stringified) || 
                                 /[A-Za-z]:\\[\w\d_.-\/\\]+/.test(stringified);
            
            assert(!containsPaths, 'Capture properties should not contain file paths');
            return properties;
        };
        
        // Create an error with file path
        const mockError = new Error(`Failed to read ${process.cwd()}/sensitive/file.txt`);
        
        // Manually sanitize for test
        const sanitizedError = sanitizeError(mockError).message;
        
        // Call the mock capture with the error
        const properties = mockCapture('test_event', {
            error: sanitizedError,
            operation: 'read_file'
        });
        
        // Verify the error was properly processed
        assert(typeof properties.error === 'string', 'Error property should be a string');
        assert(!properties.error.includes(process.cwd()), 'Error should not contain file path');
    }) && allPassed;

    console.log('All error sanitization tests complete.');
    return allPassed;
};

// Run tests if this file is executed directly
runIfMain(import.meta.url, runAllTests);

// Export the test function for the test runner
export default runAllTests;
