#!/usr/bin/env node

/**
 * Test script for PDF parsing functionality using unpdf
 * Verifies parsing of sample PDFs and URL
 */

import { getPdfMetadata, pdfToMarkdown, getPdfContent } from '../dist/tools/pdf-v2.js';
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
        // 1. Metadata
        console.log('📊 METADATA:');
        const metadata = await getPdfMetadata(source);
        if (metadata.success) {
            console.log(`  File Size: ${metadata.fileSize ? metadata.fileSize + ' bytes' : 'N/A'}, Pages: ${metadata.totalPages}`);
            console.log(`  Title: ${metadata.title || 'N/A'} (Author: ${metadata.author || 'N/A'})`);
            console.log(`  Processing Time: ${metadata.processingTime}ms`);
        } else {
            console.error(`  ❌ Failed to get metadata: ${metadata.error}`);
        }

        // 2. Content (Markdown)
        console.log('\n📝 CONTENT PREVIEW (Markdown):');
        const markdown = await pdfToMarkdown(source);
        const preview = markdown.substring(0, 500).replace(/\n/g, '\n  ');
        console.log(`  ${preview}...`);
        console.log(`\n  [Total Length: ${markdown.length} chars]`);

        // 3. Content (Raw/Structured via getPdfContent)
        console.log('\n📄 RAW CONTENT (First Page):');
        const content = await getPdfContent(source, { max: 1 });
        if (content.success && content.text) {
            const pageText = content.text.substring(0, 200).replace(/\n/g, '\n  ');
            console.log(`  ${pageText}...`);
        } else {
            console.log('  (No content extracted or failed)');
        }

    } catch (error) {
        console.error(`❌ Error processing ${name}:`, error);
    }
}

async function main() {
    console.log('🧪 PDF v2 Sample Test Suite (unpdf)');

    // Test Local Samples
    for (const sample of SAMPLES) {
        const samplePath = path.join(SAMPLES_DIR, sample);
        await testSample(sample, samplePath);
    }

    // Test URL
    await testSample('URL Sample', URL_SAMPLE);

    // Test Page Filter
    console.log('\n================================================================================');
    console.log('Testing Page Filter (using 03_sample_compex.pdf)');
    console.log('--------------------------------------------------------------------------------');
    const complexSample = path.join(SAMPLES_DIR, '03_sample_compex.pdf');

    // Test First 2 Pages
    console.log('\n📄 Filter: { first: 2 }');
    const first2 = await getPdfContent(complexSample, { first: 2 });
    console.log(`  Extracted Pages: ${first2.text.split('\n\n').length} (Expected: 2)`);

    // Test Last 2 Pages
    console.log('\n📄 Filter: { last: 2 }');
    const last2 = await getPdfContent(complexSample, { last: 2 });
    console.log(`  Extracted Pages: ${last2.text.split('\n\n').length} (Expected: 2)`);

    // Test Partial [1, 5]
    console.log('\n📄 Filter: { partial: [1, 5] }');
    const partial = await getPdfContent(complexSample, { partial: [1, 5] });
    console.log(`  Extracted Pages: ${partial.text.split('\n\n').length} (Expected: 2)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
