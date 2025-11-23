#!/usr/bin/env node

/**
 * Test script for PDF creation functionality
 * Creates PDF from markdown string and verifies it
 */

import { createPdfFromMarkdown } from '../dist/tools/pdf-v3.js';
import { modifyPdf } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'test_output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'created_sample.pdf');
const MODIFIED_FILE = path.join(OUTPUT_DIR, 'modified_sample.pdf');

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
        const pdfBuffer = await createPdfFromMarkdown(markdown);

        if (pdfBuffer) {
            await fs.writeFile(OUTPUT_FILE, pdfBuffer);
            console.log('✅ PDF created successfully');

            const stats = await fs.stat(OUTPUT_FILE);
            console.log(`   File Size: ${stats.size} bytes`);

            // --- Modification Test ---
            console.log('\n2. Testing PDF Modification (Insert & Delete & Merge)...');

            // Create a temporary PDF to merge
            const tempMergeFile = path.join(OUTPUT_DIR, 'temp_merge.pdf');
            const mergeBuffer = await createPdfFromMarkdown('# Merged Page\n\nThis page was merged from another PDF file.');
            await fs.writeFile(tempMergeFile, mergeBuffer);

            // We will:
            // 1. Delete page 0 (the first page)
            // 2. Insert a new cover page at the beginning (from markdown)
            // 3. Insert an appendix page at the end (from markdown)
            // 4. Merge the temporary PDF at the very end (from file path)

            await modifyPdf(OUTPUT_FILE, MODIFIED_FILE, [
                {
                    type: 'delete',
                    pageIndex: 0
                },
                {
                    type: 'insert',
                    pageIndex: 0,
                    markdownContent: '# New Cover Page\n\nThis page was inserted dynamically.\n\n## Summary\nWe deleted the original first page and added this one.'
                },
                {
                    type: 'insert',
                    pageIndex: 999, // Insert at end
                    markdownContent: '# Appendix\n\nThis page was appended to the end.'
                },
                {
                    type: 'insert',
                    pageIndex: 999, // Append after the appendix
                    sourcePdf: tempMergeFile
                }
            ]);

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

        } else {
            console.error('❌ Failed to create PDF: No buffer returned');
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Failed:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
