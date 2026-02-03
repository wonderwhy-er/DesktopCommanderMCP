/**
 * Test DOCX Reading Functionality
 * Tests the mammoth.js integration for reading Word documents
 */

import { parseDocxToMarkdown } from '../dist/tools/docx/markdown.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes for better output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(color, ...args) {
    console.log(color, ...args, colors.reset);
}

/**
 * Create a sample DOCX file for testing (requires docx library)
 * For now, we'll just test with any existing DOCX file
 */
async function testBasicDocxReading() {
    log(colors.blue, '\n=== Test 1: Basic DOCX Reading ===');
    
    // Note: This test assumes a sample DOCX file exists
    // You can create one manually or use the docx library
    const samplePath = path.join(__dirname, 'samples', 'sample.docx');
    
    try {
        // Check if sample file exists
        try {
            await fs.access(samplePath);
        } catch {
            log(colors.yellow, 'Sample DOCX file not found, skipping test');
            log(colors.cyan, `Expected location: ${samplePath}`);
            return;
        }

        const result = await parseDocxToMarkdown(samplePath, {
            includeImages: true,
            preserveFormatting: true
        });

        log(colors.green, '✓ Successfully parsed DOCX file');
        
        // Display metadata
        log(colors.cyan, '\nMetadata:');
        console.log('  Title:', result.metadata.title || 'N/A');
        console.log('  Author:', result.metadata.author || 'N/A');
        console.log('  Subject:', result.metadata.subject || 'N/A');
        console.log('  Created:', result.metadata.creationDate || 'N/A');
        console.log('  Modified:', result.metadata.modificationDate || 'N/A');
        console.log('  File Size:', result.metadata.fileSize ? `${Math.round(result.metadata.fileSize / 1024)}KB` : 'N/A');
        
        // Display content preview
        log(colors.cyan, '\nContent Preview (first 500 chars):');
        console.log(result.markdown.substring(0, 500));
        if (result.markdown.length > 500) {
            console.log('... (truncated)');
        }
        
        // Display image info
        if (result.images.length > 0) {
            log(colors.cyan, `\n✓ Found ${result.images.length} embedded images:`);
            result.images.forEach((img, idx) => {
                console.log(`  ${idx + 1}. ${img.mimeType} - ${Math.round(img.originalSize / 1024)}KB`);
                if (img.altText) {
                    console.log(`     Alt text: ${img.altText}`);
                }
            });
        } else {
            log(colors.cyan, '\n✓ No embedded images found');
        }
        
        // Display sections
        if (result.sections && result.sections.length > 0) {
            log(colors.cyan, `\n✓ Parsed ${result.sections.length} sections:`);
            const headings = result.sections.filter(s => s.type === 'heading');
            const paragraphs = result.sections.filter(s => s.type === 'paragraph');
            const lists = result.sections.filter(s => s.type === 'list');
            console.log(`  - Headings: ${headings.length}`);
            console.log(`  - Paragraphs: ${paragraphs.length}`);
            console.log(`  - Lists: ${lists.length}`);
        }

        return true;
    } catch (error) {
        log(colors.red, '✗ Test failed:', error.message);
        console.error(error.stack);
        return false;
    }
}

/**
 * Test DOCX with formatting preservation
 */
async function testFormattingPreservation() {
    log(colors.blue, '\n=== Test 2: Formatting Preservation ===');
    
    const samplePath = path.join(__dirname, 'samples', 'sample.docx');
    
    try {
        await fs.access(samplePath);
    } catch {
        log(colors.yellow, 'Sample DOCX file not found, skipping test');
        return;
    }

    try {
        const result = await parseDocxToMarkdown(samplePath, {
            includeImages: false,
            preserveFormatting: true
        });

        // Check for markdown formatting
        const hasBold = result.markdown.includes('**');
        const hasItalic = result.markdown.includes('*') || result.markdown.includes('_');
        const hasHeadings = result.markdown.match(/^#{1,6}\s/m);
        const hasLists = result.markdown.match(/^[*\-+]\s/m);
        
        log(colors.cyan, 'Detected formatting:');
        console.log(`  Bold text: ${hasBold ? '✓' : '✗'}`);
        console.log(`  Italic text: ${hasItalic ? '✓' : '✗'}`);
        console.log(`  Headings: ${hasHeadings ? '✓' : '✗'}`);
        console.log(`  Lists: ${hasLists ? '✓' : '✗'}`);

        log(colors.green, '✓ Formatting preservation test completed');
        return true;
    } catch (error) {
        log(colors.red, '✗ Test failed:', error.message);
        return false;
    }
}

/**
 * Test error handling
 */
async function testErrorHandling() {
    log(colors.blue, '\n=== Test 3: Error Handling ===');
    
    const nonExistentPath = path.join(__dirname, 'samples', 'nonexistent.docx');
    
    try {
        await parseDocxToMarkdown(nonExistentPath);
        log(colors.red, '✗ Should have thrown an error for non-existent file');
        return false;
    } catch (error) {
        log(colors.green, '✓ Correctly threw error for non-existent file');
        console.log('  Error message:', error.message);
        return true;
    }
}

/**
 * Test metadata extraction
 */
async function testMetadataExtraction() {
    log(colors.blue, '\n=== Test 4: Metadata Extraction ===');
    
    const samplePath = path.join(__dirname, 'samples', 'sample.docx');
    
    try {
        await fs.access(samplePath);
    } catch {
        log(colors.yellow, 'Sample DOCX file not found, skipping test');
        return;
    }

    try {
        const result = await parseDocxToMarkdown(samplePath, {
            includeImages: false
        });

        const metadata = result.metadata;
        
        log(colors.cyan, 'Metadata fields present:');
        console.log(`  Title: ${metadata.title ? '✓' : '✗'}`);
        console.log(`  Author: ${metadata.author ? '✓' : '✗'}`);
        console.log(`  Subject: ${metadata.subject ? '✓' : '✗'}`);
        console.log(`  Description: ${metadata.description ? '✓' : '✗'}`);
        console.log(`  Creation Date: ${metadata.creationDate ? '✓' : '✗'}`);
        console.log(`  Modification Date: ${metadata.modificationDate ? '✓' : '✗'}`);
        console.log(`  Last Modified By: ${metadata.lastModifiedBy ? '✓' : '✗'}`);
        console.log(`  Revision: ${metadata.revision ? '✓' : '✗'}`);
        console.log(`  File Size: ${metadata.fileSize ? '✓' : '✗'}`);

        log(colors.green, '✓ Metadata extraction test completed');
        return true;
    } catch (error) {
        log(colors.red, '✗ Test failed:', error.message);
        return false;
    }
}

/**
 * Run all tests
 */
async function runAllTests() {
    log(colors.cyan, '╔═══════════════════════════════════════════╗');
    log(colors.cyan, '║   DOCX Reading Tests (mammoth.js)        ║');
    log(colors.cyan, '╚═══════════════════════════════════════════╝');

    const results = [];
    
    results.push(await testBasicDocxReading());
    results.push(await testFormattingPreservation());
    results.push(await testErrorHandling());
    results.push(await testMetadataExtraction());

    // Summary
    const passed = results.filter(r => r === true).length;
    const total = results.length;
    
    log(colors.cyan, '\n╔═══════════════════════════════════════════╗');
    log(colors.cyan, '║              Test Summary                 ║');
    log(colors.cyan, '╚═══════════════════════════════════════════╝');
    
    if (passed === total) {
        log(colors.green, `\n✓ All tests passed (${passed}/${total})`);
    } else {
        log(colors.yellow, `\n⚠ ${passed}/${total} tests passed`);
    }
    
    process.exit(passed === total ? 0 : 1);
}

runAllTests().catch(error => {
    log(colors.red, '\n✗ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
});

