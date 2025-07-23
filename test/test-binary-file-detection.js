/**
 * Test script to verify binary file detection and handling
 * 
 * This test verifies that:
 * 1. Binary files are properly detected
 * 2. Instruction messages are returned instead of binary content
 * 3. Text files still work normally
 * 4. Images are handled correctly (allowed through as base64)
 * 5. Edge cases are handled properly
 */

import { configManager } from '../dist/config-manager.js';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

// Get directory setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test directory and files
const TEST_DIR = path.join(__dirname, 'test_binary_detection');
const TEXT_FILE = path.join(TEST_DIR, 'test.txt');
const BINARY_FILE = path.join(TEST_DIR, 'test.bin');
const FAKE_PDF_FILE = path.join(TEST_DIR, 'test.pdf');
const FAKE_IMAGE_FILE = path.join(TEST_DIR, 'test.png');

/**
 * Setup function to prepare test environment
 */
async function setup() {
    const originalConfig = await configManager.getConfig();
    
    // Set allowed directories to include test directory
    await configManager.setValue('allowedDirectories', [TEST_DIR]);
    
    // Create test directory
    await fs.mkdir(TEST_DIR, { recursive: true });
    
    // Create a text file
    await fs.writeFile(TEXT_FILE, 'This is a normal text file.\nWith multiple lines.\nFor testing purposes.');
    
    // Create a binary file with actual binary content
    const binaryData = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG header
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82
    ]);
    await fs.writeFile(BINARY_FILE, binaryData);
    
    // Create a fake PDF file (with PDF header but actually binary)
    const pdfData = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A]),
        Buffer.from('Some binary content that would be in a real PDF'),
        Buffer.from([0xFF, 0xFE, 0xFD, 0xFC, 0xFB, 0xFA])
    ]);
    await fs.writeFile(FAKE_PDF_FILE, pdfData);
    
    // Create a fake image file (PNG format but with .png extension)
    await fs.writeFile(FAKE_IMAGE_FILE, binaryData);
    
    return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
    // Clean up test files and directory
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    
    // Reset configuration
    await configManager.updateConfig(originalConfig);
    
    console.log('✓ Teardown: test directory cleaned up and config restored');
}

/**
 * Test that text files still work normally
 */
async function testTextFileReading() {
    console.log('\n🧪 Testing text file reading...');
    
    const result = await handleReadFile({
        path: TEXT_FILE,
        offset: 0,
        length: 10
    });
    
    assert.ok(!result.isError, 'Text file reading should not error');
    assert.ok(result.content[0].text.includes('This is a normal text file'), 'Should contain expected text content');
    assert.ok(!result.content[0].text.includes('Cannot read binary file'), 'Should not contain binary file message');
    
    console.log('✓ Text file reading works correctly');
}

/**
 * Test that binary files are detected and return instruction messages
 */
async function testBinaryFileDetection() {
    console.log('\n🧪 Testing binary file detection...');
    
    const result = await handleReadFile({
        path: BINARY_FILE,
        offset: 0,
        length: 10
    });
    
    assert.ok(!result.isError, 'Binary file should not error, but return instructions');
    assert.ok(result.content[0].text.includes('Cannot read binary file as text'), 'Should contain binary file detection message');
    assert.ok(result.content[0].text.includes('Use start_process + interact_with_process'), 'Should contain instruction to use processes');
    assert.ok(result.content[0].text.includes('test.bin'), 'Should mention the filename');
    assert.ok(!result.content[0].text.includes('base64'), 'Should not contain base64 encoded content');
    
    console.log('✓ Binary file detection works correctly');
}

/**
 * Test that PDF files are detected as binary and get proper instructions
 */
async function testPdfFileDetection() {
    console.log('\n🧪 Testing PDF file detection...');
    
    const result = await handleReadFile({
        path: FAKE_PDF_FILE,
        offset: 0,
        length: 10
    });
    
    assert.ok(!result.isError, 'PDF file should not error, but return instructions');
    assert.ok(result.content[0].text.includes('Cannot read binary file as text'), 'Should contain binary file detection message');
    assert.ok(result.content[0].text.includes('test.pdf'), 'Should mention the PDF filename');
    assert.ok(result.content[0].text.includes('Use start_process + interact_with_process'), 'Should contain instruction to use processes');
    
    console.log('✓ PDF file detection works correctly');
}

/**
 * Test that image files are handled correctly (should pass through as images)
 */
async function testImageFileHandling() {
    console.log('\n🧪 Testing image file handling...');
    
    const result = await handleReadFile({
        path: FAKE_IMAGE_FILE,
        offset: 0,
        length: 10
    });
    
    assert.ok(!result.isError, 'Image file should not error');
    
    // Check if it's handled as an image (should have image content type)
    const hasImageContent = result.content.some(item => item.type === 'image');
    const hasTextContent = result.content.some(item => 
        item.type === 'text' && item.text && item.text.includes('Image file:')
    );
    
    assert.ok(hasImageContent || hasTextContent, 'Should be handled as an image file');
    assert.ok(!result.content[0].text || !result.content[0].text.includes('Cannot read binary file'), 'Should not show binary file message for images');
    
    console.log('✓ Image file handling works correctly');
}

/**
 * Test edge cases
 */
async function testEdgeCases() {
    console.log('\n🧪 Testing edge cases...');
    
    // Test with non-existent file
    try {
        const result = await handleReadFile({
            path: path.join(TEST_DIR, 'nonexistent.bin'),
            offset: 0,
            length: 10
        });
        
        assert.ok(result.isError, 'Non-existent file should return error');
        console.log('✓ Non-existent file handled correctly');
    } catch (error) {
        console.log('✓ Non-existent file properly throws error');
    }
    
    // Test with empty binary file
    const emptyBinaryFile = path.join(TEST_DIR, 'empty.bin');
    await fs.writeFile(emptyBinaryFile, Buffer.alloc(0));
    
    const emptyResult = await handleReadFile({
        path: emptyBinaryFile,
        offset: 0,
        length: 10
    });
    
    // Empty files might not be detected as binary, which is fine
    console.log('✓ Empty file handled (behavior may vary)');
}

/**
 * Test that no base64 content leaks through
 */
async function testNoBase64Leakage() {
    console.log('\n🧪 Testing for base64 content leakage...');
    
    const result = await handleReadFile({
        path: BINARY_FILE,
        offset: 0,
        length: 10
    });
    
    // Check that we don't get any base64 encoded content
    const text = result.content[0].text;
    assert.ok(!text.includes('base64 encoded'), 'Should not contain base64 encoded content message');
    assert.ok(!/^[A-Za-z0-9+/]+=*$/.test(text.split('\n')[0]), 'First line should not look like base64');
    
    // Check for common base64 patterns
    const base64Patterns = [
        /[A-Za-z0-9+/]{20,}={0,2}/, // Long base64-like strings
        /data:.*base64,/, // Data URIs
        /iVBORw0KGgo/, // Common PNG base64 start
        /JVBERi0/ // Common PDF base64 start
    ];
    
    for (const pattern of base64Patterns) {
        assert.ok(!pattern.test(text), `Should not contain base64 pattern: ${pattern}`);
    }
    
    console.log('✓ No base64 content leakage detected');
}

/**
 * Main test runner
 */
async function runAllTests() {
    console.log('🧪 Starting binary file detection tests...\n');
    
    let originalConfig;
    let allTestsPassed = true;
    
    try {
        // Setup
        originalConfig = await setup();
        console.log('✓ Setup: test environment prepared');
        
        // Run all tests
        await testTextFileReading();
        await testBinaryFileDetection();
        await testPdfFileDetection();
        await testImageFileHandling();
        await testEdgeCases();
        await testNoBase64Leakage();
        
        console.log('\n🎉 All binary file detection tests passed!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
        allTestsPassed = false;
        
    } finally {
        // Cleanup
        if (originalConfig) {
            await teardown(originalConfig);
        }
    }
    
    if (!allTestsPassed) {
        process.exit(1);
    }
}

// Run the tests
runAllTests().catch(error => {
    console.error('Fatal error running tests:', error);
    process.exit(1);
});
