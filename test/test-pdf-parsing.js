#!/usr/bin/env node

/**
 * Test script for PDF parsing functionality using @opendocsg/pdf2md (v3)
 * Verifies parsing of sample PDFs and URL
 */

import { pdfToMarkdown } from '../dist/tools/pdf-v3.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES_DIR = path.join(__dirname, 'samples');
const SAMPLES = [
    '01_sample_simple.pdf',
    '02_sample_invoce.pdf',
    '03_sample_compex.pdf'
];

const URL_SAMPLE = 'https://pdfobject.com/pdf/sample.pdf';

async function testSample(name, source) {
    console.log(`\n================================================================================`);
    console.log(`Processing: ${name}`);
    console.log(`Source: ${source}`);
    console.log(`--------------------------------------------------------------------------------`);

    try {
        const startTime = Date.now();

        // Content (Markdown)
        console.log('\n📝 CONTENT PREVIEW (Markdown):');
        const markdown = await pdfToMarkdown(source);
        const processingTime = Date.now() - startTime;

        const preview = markdown.substring(0, 500).replace(/\n/g, '\n  ');
        console.log(`  ${preview}...`);
        console.log(`\n  [Total Length: ${markdown.length} chars]`);
        console.log(`  Processing Time: ${processingTime}ms`);

    } catch (error) {
        console.error(`❌ Error processing ${name}:`, error);
    }
}

async function main() {
    console.log('🧪 PDF v3 Sample Test Suite (@opendocsg/pdf2md)');

    // Test Local Samples
    for (const sample of SAMPLES) {
        const samplePath = path.join(SAMPLES_DIR, sample);
        await testSample(sample, samplePath);
    }

    // Test URL
    await testSample('URL Sample', URL_SAMPLE);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
