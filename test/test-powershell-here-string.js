import assert from 'node:assert';
import { commandManager } from '../dist/command-manager.js';

console.log('Testing PowerShell here-string command extraction (Issue #731)...');

// Test 1: Single-quoted here-string containing apostrophe and C++ int32(Format)
const testCase1 = `$code = @'
# It's a test script with apostrophes
class Inspector {
    void Inspect() {
        int32(Format);
    }
};
'@
python -c $code`;

const commands1 = commandManager.extractCommands(testCase1);
console.log('Test 1 extracted commands:', commands1);
assert(!commands1.includes('format'), 'Should not extract "format" from inside single-quoted here-string');
assert(!commands1.includes('Format'), 'Should not extract "Format" from inside single-quoted here-string');

// Test 2: Single-quoted here-string with Windows CRLF line endings
const testCase2 = `$code = @'\r\n# It's a test\r\nint32(Format);\r\n'@\r\npython -c $code`;
const commands2 = commandManager.extractCommands(testCase2);
console.log('Test 2 extracted commands:', commands2);
assert(!commands2.includes('format'), 'Should not extract "format" with CRLF here-string delimiters');

// Test 3: Double-quoted here-string with $() subshell should extract the inner command
const testCase3 = `$msg = @"
Header line
$(whoami)
Footer line
"@`;
const commands3 = commandManager.extractCommands(testCase3);
console.log('Test 3 extracted commands:', commands3);
assert(commands3.includes('whoami'), 'Should extract command inside $() in double-quoted here-string');

// Test 4: Verify validateCommand does not block safe commands containing Format inside here-string
const testCase4 = `$code = @'
# It's a test script with apostrophes
int32(Format);
'@`;
// "format" is in default blocked commands
const isValid = await commandManager.validateCommand(testCase4);
console.log('Test 4 validateCommand result (expected true):', isValid);
assert.strictEqual(isValid, true, 'Command containing Format inside here-string should be valid and not blocked');

console.log('All PowerShell here-string tests passed successfully!');
