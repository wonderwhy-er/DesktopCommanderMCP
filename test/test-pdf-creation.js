#!/usr/bin/env node

/**
 * Test script for PDF creation functionality
 * Creates PDF from markdown string and verifies it
 */

import { writePdf } from '../dist/tools/filesystem.js';
import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { isNoChrome } from './helpers/pdf.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'test_output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'created_sample.pdf');
const MODIFIED_FILE = path.join(OUTPUT_DIR, 'modified_sample.pdf');
const SAMPLE_FILE = path.join(__dirname, 'samples', 'Presentation Example.pdf');
const SAMPLE_FILE_MODIFIED = path.join(OUTPUT_DIR, 'Presentation Example Modified.pdf');

/** Text of each page (or only the given 1-based pages), as the product's PDF parser reads it back */
async function pageTexts(file, pages) {
    return (await parsePdfToMarkdown(file, pages)).pages.map((page) => page.text);
}

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

<div style="page-break-before: always;"></div>

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
            return false;
        }

        // --- Modification Test ---
        console.log('\n2. Testing PDF Modification (Insert & Delete & Merge)...');

        // Create a temporary PDF to merge
        const tempMergeFile = path.join(OUTPUT_DIR, 'temp_merge.pdf');
        await writePdf(tempMergeFile, '# Merged Page\n\nThis page was merged from another PDF file.');
        const originalPages = (await pageTexts(OUTPUT_FILE)).length;
        const mergePages = (await pageTexts(tempMergeFile)).length;
        console.log(`   Created PDF has ${originalPages} page(s); merge file has ${mergePages}`);
        // Deleting a page that doesn't exist is an error: the two deletes below need two pages
        assert(originalPages >= 2, `the created PDF should have at least 2 pages, got ${originalPages}`);

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

        // Two pages deleted, cover + appendix inserted, then the merge file's pages
        const modified = await pageTexts(MODIFIED_FILE);
        const expectedPages = originalPages - 2 + 2 + mergePages;
        assert.strictEqual(modified.length, expectedPages,
            `Modified PDF should have ${expectedPages} pages, got ${modified.length}`);
        assert(modified[0].includes('New Cover Page'), `Page 1 should be the inserted cover, got: ${modified[0]}`);
        assert(modified[1].includes('Appendix'), `Page 2 should be the inserted appendix, got: ${modified[1]}`);
        assert(modified[2].includes('Merged Page'), `Page 3 should be the merged PDF, got: ${modified[2]}`);
        console.log(`✅ Modified PDF has the expected ${expectedPages} pages in order`);

        // Cleanup temp file
        await fs.unlink(tempMergeFile).catch(() => { });

    } catch (error) {
        // Every step renders markdown: without Chrome, none of them can run
        if (isNoChrome(error)) return skip(`PDF creation and modification: no Chrome to render with (${error.message})`);
        console.error('❌ Failed:', error);
        return false;
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

    // Two pages inserted in front; the original pages follow unchanged
    const samplePages = await pageTexts(SAMPLE_FILE);
    const withInserts = await pageTexts(SAMPLE_FILE_MODIFIED);
    assert.strictEqual(withInserts.length, samplePages.length + 2,
        `Expected ${samplePages.length + 2} pages after inserting 2, got ${withInserts.length}`);
    assert(withInserts[0].includes('New Cover Page'), `Page 1 should be the inserted cover, got: ${withInserts[0]}`);
    assert(withInserts[1].includes('Appendix'), `Page 2 should be the inserted appendix, got: ${withInserts[1]}`);
    // Compare single-page parses: a whole-document parse drops lines repeated on
    // most pages (page numbers), and inserting pages changes which lines those are
    const [originalFirst] = await pageTexts(SAMPLE_FILE, [1]);
    const [afterInserts] = await pageTexts(SAMPLE_FILE_MODIFIED, [3]);
    assert.strictEqual(afterInserts, originalFirst, 'The original first page should follow the inserts unchanged');
    console.log(`✅ Original ${samplePages.length} page(s) kept after the 2 inserted pages`);
}

runIfMain(import.meta.url, main);
