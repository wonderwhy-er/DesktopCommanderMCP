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
            [`Failed to read ${home}${path.sep}notes.txt: permission denied`, 'Error: Failed to read [PATH]: permission denied'],
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

    // The paths an event carries (then drops) are replaced whole wherever they appear
    // in its text, spaces and all, and the rest of the text is kept. The paths are
    // outside the home folder, at the root of the drive the temporary folder is on.
    const root = path.parse(os.tmpdir()).root;
    const file = path.join(root, 'var', 'log', 'private notes.txt');
    const source = path.join(root, 'srv', 'team share', 'draft 1.txt');
    const target = path.join(root, 'srv', 'team share', 'final copy.txt');
    const folder = path.join(root, 'srv', 'data');

    allPassed = await runTest('Integration - the paths an event knows are replaced whole', async () => {
        const cases = [
            [{ error: new Error(`Cannot open ${file} for reading`), path: file }, 'Error: Cannot open [PATH] for reading'],
            [{ error: `Failed to move ${source} to ${target}: target exists`, sourcePath: source, destinationPath: target }, 'Failed to move [PATH] to [PATH]: target exists'],
            // A known folder doesn't cut a longer name that starts like it
            [{ error: `Cannot open ${folder}base${path.sep}x.txt now`, path: folder }, 'Cannot open [PATH] now'],
        ];
        const wrong = [];
        for (const [properties, expected] of cases) {
            const actual = (await buildEventProperties(properties)).error;
            if (actual !== expected) wrong.push({ expected, actual });
        }
        assert.deepStrictEqual(wrong, []);
    }) && allPassed;

    // A home folder with a space, followed by clause punctuation: replaced whole
    allPassed = await runTest('sanitizeError - A home folder with a space is replaced whole', () => {
        const home = path.join(root, 'Users', 'John Smith');
        const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            assert.strictEqual(os.homedir(), home, 'os.homedir() should follow HOME/USERPROFILE');
            const cases = [
                [`Failed to read ${home}. Try again`, 'Error: Failed to read [PATH]. Try again'],
                [`Failed to read ${home}, retrying`, 'Error: Failed to read [PATH], retrying'],
            ];
            const wrong = cases
                .map(([message, expected]) => ({ expected, actual: sanitizeError(new Error(message)).message }))
                .filter(({ expected, actual }) => actual !== expected);
            assert.deepStrictEqual(wrong, []);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
        }
    }) && allPassed;

    allPassed = await runTest('Integration - message properties are redacted like error', async () => {
        const properties = await buildEventProperties({
            message: `Error in set_config_value handler: Error: EACCES: permission denied, open '${file}'`,
            errorMessage: `Could not read ${file}, retrying`,
            path: file,
        });
        assert.strictEqual(properties.message, "Error in set_config_value handler: Error: EACCES: permission denied, open '[PATH]'");
        assert.strictEqual(properties.errorMessage, 'Could not read [PATH], retrying');
    }) && allPassed;

    // start_process sends the command's first word(s), as typed: a path there is replaced
    // whole, a plain command name is kept. The values come from the real command manager.
    allPassed = await runTest('Integration - a command that starts with a path is redacted', async () => {
        const { commandManager } = await import('../dist/command-manager.js');
        const spaced = path.join(root, 'Users', 'John Smith', 'bin', 'run.sh');
        const cases = [
            [`${spaced} --flag`, { command: '[PATH]', commands: '[PATH]' }],
            [`scripts${path.sep}deploy.sh --prod && git push`, { command: '[PATH]', commands: '[PATH], git' }],
            ['npm test', { command: 'npm', commands: 'npm' }],
        ];
        const wrong = [];
        for (const [line, expected] of cases) {
            const sent = await buildEventProperties({
                command: commandManager.getBaseCommand(line),
                commands: commandManager.extractCommands(line, true).join(', '),
            });
            const actual = { command: sent.command, commands: sent.commands };
            if (JSON.stringify(actual) !== JSON.stringify(expected)) wrong.push({ line, expected, actual });
        }
        assert.deepStrictEqual(wrong, []);
    }) && allPassed;

    // Error text sent under the other names our capture() calls use: a path the
    // event knows, and one it doesn't, are replaced; the text around them is kept
    allPassed = await runTest('Integration - every error text property is redacted', async () => {
        const log = path.join(root, 'var', 'log', 'app.log');
        const text = `Could not open ${file}, retrying (see ${log})`;
        const sent = await buildEventProperties({ errMsg: text, error_message: text, reason: text, path: file });
        const expected = 'Could not open [PATH], retrying (see [PATH])';
        assert.deepStrictEqual(
            { errMsg: sent.errMsg, error_message: sent.error_message, reason: sent.reason },
            { errMsg: expected, error_message: expected, reason: expected });
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
