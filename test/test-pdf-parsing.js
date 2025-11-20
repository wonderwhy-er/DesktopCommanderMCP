#!/usr/bin/env node

/**
 * Test script for PDF v2 parsing functionality
 * Parses local samples and a URL, outputting stats and content
 */

import { getPdfMetadata, getPdfContent } from '../dist/tools/pdf-v2.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES_DIR = path.join(__dirname, 'samples');

const SAMPLES = [
    path.join(SAMPLES_DIR, '01_sample_simple.pdf'),
    path.join(SAMPLES_DIR, '02_sample_invoce.pdf'),
    path.join(SAMPLES_DIR, '03_sample_compex.pdf'),
    'https://pdfobject.com/pdf/sample.pdf'
];

async function testSample(source) {
    const isUrl = source.startsWith('http');
    const name = isUrl ? source : path.basename(source);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`Processing: ${name}`);
    console.log(`${'='.repeat(80)}`);

    try {
        // 1. Get Metadata
        console.log('\n📊 METADATA:');
        const metadata = await getPdfMetadata(source);

        if (!metadata.success) {
            console.error(`❌ Failed to get metadata: ${metadata.error}`);
            return;
        }

        console.log(`  File Size: ${metadata.fileSize ? metadata.fileSize + ' bytes' : 'N/A'}`);
        console.log(`  Pages: ${metadata.totalPages}`);
        console.log(`  Title: ${metadata.title || 'N/A'}`);
        console.log(`  Author: ${metadata.author || 'N/A'}`);
        console.log(`  Creator: ${metadata.creator || 'N/A'}`);
        console.log(`  Producer: ${metadata.producer || 'N/A'}`);
        console.log(`  Encrypted: ${metadata.isEncrypted}`);
        console.log(`  Processing Time: ${metadata.processingTime}ms`);

        // 2. Get Content
        console.log('\n📄 CONTENT (First 255 chars of Page 1):');
        console.log('-'.repeat(40));

        const content = await getPdfContent(source);

        if (!content.success) {
            console.error(`❌ Failed to get content: ${content.error}`);
            return;
        }

        // Get text from first page if available, otherwise full text
        let firstPageText = '';
        if (content.pages && content.pages.length > 0) {
            // Find page 1
            const page1 = content.pages.find(p => p.pageNumber === 1);
            if (page1) {
                firstPageText = page1.text;
            } else {
                firstPageText = content.pages[0].text;
            }
        } else {
            firstPageText = content.text;
        }

        // Truncate to 255 chars
        const preview = firstPageText.substring(0, 255);
        console.log(preview);
        if (firstPageText.length > 255) {
            console.log('...');
        }

        console.log(`\n⏱️  Content Processing time: ${content.processingTime}ms`);

    } catch (error) {
        console.error(`❌ Error processing ${name}:`, error);
    }
}

async function main() {
    console.log('🧪 PDF v2 Sample Test Suite');

    for (const sample of SAMPLES) {
        await testSample(sample);
    }

    console.log('\n✅ Test Complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
