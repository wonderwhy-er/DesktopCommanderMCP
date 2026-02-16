// Test script to verify line counting accuracy in read_file
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import assert from 'assert';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import { configManager } from '../dist/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DIR = join(__dirname, 'test_output');

// Ensure test dir is allowed
await configManager.setValue('allowedDirectories', [TEST_DIR]);

async function setup() {
    await fs.mkdir(TEST_DIR, { recursive: true });
}

async function createTestFile(name, content) {
    const filePath = join(TEST_DIR, name);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
}

function extractTotalLines(result) {
    // Result is { content: [{ type: 'text', text: '...' }] }
    const text = result?.content?.[0]?.text ?? '';
    const match = text.match(/\(total: (\d+) lines/);
    return match ? parseInt(match[1], 10) : null;
}

async function testLineCount() {
    let passed = 0;
    let failed = 0;

    console.log('Testing line count accuracy in read_file...\n');

    // Test 1: 3 lines with trailing newline → should report 3
    {
        const filePath = await createTestFile('trailing.txt', 'line1\nline2\nline3\n');
        const result = await handleReadFile({ path: filePath, offset: 0, length: 2 });
        const total = extractTotalLines(result);
        try {
            assert.strictEqual(total, 3, `trailing newline: expected 3, got ${total}`);
            console.log(`  ✅ PASS: 3 lines + trailing newline → total: ${total}`);
            passed++;
        } catch (e) { console.log(`  ❌ FAIL: ${e.message}`); failed++; }
    }

    // Test 2: 3 lines without trailing newline → should report 3
    {
        const filePath = await createTestFile('no_trailing.txt', 'line1\nline2\nline3');
        const result = await handleReadFile({ path: filePath, offset: 0, length: 2 });
        const total = extractTotalLines(result);
        try {
            assert.strictEqual(total, 3, `no trailing newline: expected 3, got ${total}`);
            console.log(`  ✅ PASS: 3 lines no trailing → total: ${total}`);
            passed++;
        } catch (e) { console.log(`  ❌ FAIL: ${e.message}`); failed++; }
    }

    // Test 3: 1 line with trailing newline → should report 1
    {
        const filePath = await createTestFile('single_trailing.txt', 'hello\n');
        const result = await handleReadFile({ path: filePath, offset: 0, length: 1000 });
        const total = extractTotalLines(result);
        try {
            assert.strictEqual(total, 1, `single + trailing: expected 1, got ${total}`);
            console.log(`  ✅ PASS: 1 line + trailing → total: ${total}`);
            passed++;
        } catch (e) { console.log(`  ❌ FAIL: ${e.message}`); failed++; }
    }

    // Test 4: 1 line without trailing newline → should report 1
    {
        const filePath = await createTestFile('single_no_trailing.txt', 'hello');
        const result = await handleReadFile({ path: filePath, offset: 0, length: 1000 });
        const total = extractTotalLines(result);
        try {
            assert.strictEqual(total, 1, `single no trailing: expected 1, got ${total}`);
            console.log(`  ✅ PASS: 1 line no trailing → total: ${total}`);
            passed++;
        } catch (e) { console.log(`  ❌ FAIL: ${e.message}`); failed++; }
    }

    // Test 5: 100 lines with trailing newline, partial read → total: 100
    {
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
        const filePath = await createTestFile('hundred.txt', lines.join('\n') + '\n');
        const result = await handleReadFile({ path: filePath, offset: 10, length: 5 });
        const total = extractTotalLines(result);
        try {
            assert.strictEqual(total, 100, `100-line partial: expected 100, got ${total}`);
            console.log(`  ✅ PASS: 100-line partial read → total: ${total}`);
            passed++;
        } catch (e) { console.log(`  ❌ FAIL: ${e.message}`); failed++; }
    }

    // Test 6: 100 lines without trailing newline → total: 100
    {
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
        const filePath = await createTestFile('hundred_no_trail.txt', lines.join('\n'));
        const result = await handleReadFile({ path: filePath, offset: 0, length: 5 });
        const total = extractTotalLines(result);
        try {
            assert.strictEqual(total, 100, `100-line no trailing: expected 100, got ${total}`);
            console.log(`  ✅ PASS: 100-line no trailing → total: ${total}`);
            passed++;
        } catch (e) { console.log(`  ❌ FAIL: ${e.message}`); failed++; }
    }

    console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
    if (failed > 0) process.exit(1);
}

setup().then(testLineCount).catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
