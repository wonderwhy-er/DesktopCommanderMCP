#!/usr/bin/env node

/**
 * Test script for PDF creation functionality
 * Creates PDF from markdown string and verifies it
 */

import { markdownToPdf } from '../dist/tools/pdf.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'test_output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'created_sample.pdf');

async function main() {
    console.log('🧪 PDF Creation Test Suite');

    // Ensure output directory exists
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
    } catch (e) {
        // Ignore if exists
    }

    const markdown = `
# Hello World

This is a test PDF created from markdown.

## Features
- Simple text
- **Bold text**
- *Italic text*
- [Link](https://google.com)

## Code
\`\`\`javascript
console.log('Hello World');
\`\`\`
    `;

    console.log(`\nCreating PDF at: ${OUTPUT_FILE}`);

    try {
        // markdownToPdf returns a Buffer, it does not write to disk itself
        const pdfBuffer = await markdownToPdf(markdown, OUTPUT_FILE);

        if (pdfBuffer) {
            await fs.writeFile(OUTPUT_FILE, pdfBuffer);
            console.log('✅ PDF created successfully');

            // Verify the created PDF
            console.log('\nVerifying created PDF...');
            const stats = await fs.stat(OUTPUT_FILE);

            if (stats.size > 0) {
                console.log('✅ PDF is valid (non-empty)');
                console.log(`  File Size: ${stats.size} bytes`);
            } else {
                console.error('❌ PDF file is empty');
                process.exit(1);
            }

        } else {
            console.error('❌ Failed to create PDF: No buffer returned');
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Failed to create PDF:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
