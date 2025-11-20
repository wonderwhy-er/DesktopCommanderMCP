#!/usr/bin/env node

/**
 * Test script for PDF creation functionality
 * Creates PDF from markdown string and verifies it
 */

import { createPdfFromMarkdown, getPdfMetadata } from '../dist/tools/pdf-v2.js';
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
    const success = await createPdfFromMarkdown(markdown, OUTPUT_FILE);

    if (success) {
        console.log('✅ PDF created successfully');

        // Verify the created PDF
        console.log('\nVerifying created PDF...');
        const metadata = await getPdfMetadata(OUTPUT_FILE);

        if (metadata.success) {
            console.log('✅ PDF is valid');
            console.log(`  File Size: ${metadata.fileSize} bytes`);
            console.log(`  Pages: ${metadata.totalPages}`);
            console.log(`  Title: ${metadata.title || 'N/A'}`);
        } else {
            console.error(`❌ Failed to verify PDF: ${metadata.error}`);
        }

    } else {
        console.error('❌ Failed to create PDF');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
