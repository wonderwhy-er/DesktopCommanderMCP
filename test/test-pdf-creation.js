#!/usr/bin/env node

/**
 * Test script for PDF creation functionality
 * Creates PDF from markdown string and verifies it
 */

import { writePdf } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'test_output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'created_sample.pdf');
const MODIFIED_FILE = path.join(OUTPUT_DIR, 'modified_sample.pdf');
const SAMPLE_FILE = path.join(__dirname, 'samples', 'Presentation Example.pdf');
const SAMPLE_FILE_MODIFIED = path.join(OUTPUT_DIR, 'Presentation Example Modified.pdf');
async function main() {
    console.log('🧪 PDF Creation & Modification Test Suite');

    // Ensure output directory exists
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
    } catch (e) {
        // Ignore if exists
    }

    // Create a multi-page markdown to allow for meaningful delete operations
    const markdown = `
# Page 1: Introduction

This is the first page of the test PDF.

## Features
- Simple text
- **Bold text**
- *Italic text*

(Padding to ensure content...)
1. Item 1
2. Item 2
3. Item 3

# Page 2: Code Section

This should be on a new page if the previous content fills the page, 
but since we don't have explicit page breaks, we'll rely on the structure.
Actually, let's just assume this is a single document we will modify.

## Code
\`\`\`javascript
console.log('Hello World');
console.log('Line 2');
console.log('Line 3');
\`\`\`
    `;

    console.log(`\n1. Creating PDF at: ${OUTPUT_FILE}`);

    try {
        // writePdf now writes directly to file
        await writePdf(OUTPUT_FILE, markdown);

        // Verify creation
        try {
            const stats = await fs.stat(OUTPUT_FILE);
            console.log('✅ PDF created successfully');
            console.log(`   File Size: ${stats.size} bytes`);

            if (stats.size === 0) {
                throw new Error('Created PDF is empty');
            }
        } catch (e) {
            console.error('❌ Failed to verify created PDF:', e);
            process.exit(1);
        }

        // --- Modification Test ---
        console.log('\n2. Testing PDF Modification (Insert & Delete & Merge)...');

        // Create a temporary PDF to merge
        const tempMergeFile = path.join(OUTPUT_DIR, 'temp_merge.pdf');
        await writePdf(tempMergeFile, '# Merged Page\n\nThis page was merged from another PDF file.');

        // We will:
        // 1. Delete page 0 (the first page)
        // 2. Insert a new cover page at the beginning (from markdown)
        // 3. Insert an appendix page at the end (from markdown)
        // 4. Merge the temporary PDF at the very end (from file path)

        await writePdf(OUTPUT_FILE, [
            {
                type: 'delete',
                pageIndexes: [0]
            },
            {
                type: 'delete',
                pageIndexes: [-1] // Delete the last page.
            },
            {
                type: 'insert',
                pageIndex: 0,
                markdown: '# New Cover Page\n\nThis page was inserted dynamically.\n\n## Summary\nWe deleted the original pages and added this one.'
            },
            {
                type: 'insert',
                pageIndex: 1,
                markdown: '# Appendix\n\nThis page was appended to the end.'
            },
            {
                type: 'insert',
                pageIndex: 2,
                sourcePdfPath: tempMergeFile
            }
        ], MODIFIED_FILE);

        console.log('✅ PDF modified successfully');
        console.log(`   Saved to: ${MODIFIED_FILE}`);

        const modStats = await fs.stat(MODIFIED_FILE);
        if (modStats.size > 0) {
            console.log('✅ Modified PDF is valid (non-empty)');
            console.log(`   Modified File Size: ${modStats.size} bytes`);
        } else {
            console.error('❌ Modified PDF file is empty');
            process.exit(1);
        }

        // Cleanup temp file
        await fs.unlink(tempMergeFile).catch(() => { });

    } catch (error) {
        console.error('❌ Failed:', error);
        process.exit(1);
    }

    // --- Modification Test ---
    console.log('\n3. Testing PDF Modification - keep layout...');

    await writePdf(SAMPLE_FILE, [
        {
            type: 'insert',
            pageIndex: 0,
            markdown: '# New Cover Page\n\nThis page was inserted dynamically.\n\n## Summary\nWe deleted the original pages and added this one.'
        },
        {
            type: 'insert',
            pageIndex: 1,
            markdown: '# Appendix\n\nThis page was appended to the end.'
        }

    ], SAMPLE_FILE_MODIFIED);

    console.log('✅ PDF modified successfully');
    console.log(`   Saved to: ${SAMPLE_FILE_MODIFIED}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
