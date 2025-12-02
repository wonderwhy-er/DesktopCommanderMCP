#!/usr/bin/env node

/**
 * Test script for PDF parsing functionality using @opendocsg/pdf2md (v3)
 * Verifies parsing of sample PDFs and URL
 */

import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES_DIR = path.join(__dirname, 'samples');
const SAMPLES = [
    '01_sample_simple.pdf',
    '02_sample_invoice.pdf',
    '03_sample_compex.pdf',
    // 'gpc-genai-ocsummaryv2-content.pdf',
    // '2025-Wharton-GBK-AI-Adoption-Report_Full-Report.pdf'
    // 'statement.pdf'
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
        const result = await parsePdfToMarkdown(source);

        // Verify new structure
        if (result.pages) {
            console.log(`\n📄 Pages Found: ${result.pages.length}`);
            result.pages.forEach((p, i) => {
                console.log(`  Page ${p.pageNumber}: ${p.text.length} chars, ${p.images.length} images`);
            });
        }

        const markdown = result.pages.map(p => p.text).join('');
        const images = result.pages.flatMap(p => p.images);

        const processingTime = Date.now() - startTime;
        console.log('\n--- Full Text Preview ---');
        console.log(markdown.substring(0, 200) + '...');

        // Save extracted images to disk
        if (images && images.length > 0) {
            console.log(`\n🖼️  EXTRACTED IMAGES (${images.length}):`);

            // Create images directory for this PDF
            const imagesDir = path.join(SAMPLES_DIR, `${name}_images`);
            await fs.mkdir(imagesDir, { recursive: true });

            for (let i = 0; i < images.length; i++) {
                const img = images[i];

                // Determine file extension from MIME type
                const ext = img.mimeType.split('/')[1] || 'png';
                const filename = `page_${img.page}_img_${i + 1}.${ext}`;
                const filepath = path.join(imagesDir, filename);

                // Decode base64 and save to file
                const buffer = Buffer.from(img.data, 'base64');
                await fs.writeFile(filepath, buffer);

                console.log(`  - Saved: ${filename} (${img.width}x${img.height}, ${img.mimeType})`);
            }

            console.log(`\n  Images saved to: ${imagesDir}`);
        }

        // save to markdown file
        const markdownPath = path.join(SAMPLES_DIR, `${name}.md`);
        await fs.writeFile(markdownPath, markdown);
        const preview = markdown.substring(0, 500).replace(/\n/g, '\n  ');
        console.log(`  ${preview}...`);
        console.log(`\n  [Total Length: ${markdown.length} chars]`);
        console.log(`  Processing Time: ${processingTime}ms`);

    } catch (error) {
        console.error(`❌ Error processing ${name}:`, error);
    }
}

async function testPageFiltering() {
    console.log(`\n================================================================================`);
    console.log(`🧪 Testing Page Filtering`);
    console.log(`--------------------------------------------------------------------------------`);

    const sampleName = '03_sample_compex.pdf';
    const samplePath = path.join(SAMPLES_DIR, sampleName);

    try {
        // Case 1: Specific Pages (Array)
        console.log('\nCase 1: Specific Pages [1]');
        const result1 = await parsePdfToMarkdown(samplePath, [1]);
        console.log(`Pages returned: ${result1.pages.length}`);
        console.log(`Page numbers: ${result1.pages.map(p => p.pageNumber).join(', ')}`);

        // Case 2: Page Range (Positive Offset) - First Page
        console.log('\nCase 2: Page Range { offset: 0, length: 1 } (First Page)');
        const result2 = await parsePdfToMarkdown(samplePath, { offset: 0, length: 1 });
        console.log(`Pages returned: ${result2.pages.length}`);
        console.log(`Page numbers: ${result2.pages.map(p => p.pageNumber).join(', ')}`);

        // Case 3: Page Range (Negative Offset) - Last Page
        console.log('\nCase 3: Page Range { offset: -2, length: 2 } (Last Page)');
        const result3 = await parsePdfToMarkdown(samplePath, { offset: -2, length: 2 });
        console.log(`Pages returned: ${result3.pages.length}`);
        console.log(`Page numbers: ${result3.pages.map(p => p.pageNumber).join(', ')}`);

        // Case 4: Page Range (Large Length) - All Pages from start
        console.log('\nCase 4: Page Range { offset: 0, length: 100 } (All Pages)');
        const result4 = await parsePdfToMarkdown(samplePath, { offset: 0, length: 100 });
        console.log(`Pages returned: ${result4.pages.length}`);
        console.log(`Page numbers: ${result4.pages.map(p => p.pageNumber).join(', ')}`);

        // Case 5: Page Range (Large Negative Offset) - All Pages from end
        console.log('\nCase 5: Page Range { offset: -100, length: 100 } (All Pages from end)');
        const result5 = await parsePdfToMarkdown(samplePath, { offset: -100, length: 100 });
        console.log(`Pages returned: ${result5.pages.length}`);
        console.log(`Page numbers: ${result5.pages.map(p => p.pageNumber).join(', ')}`);

        // Case 6: Page Range (Large Length) - All Pages
        console.log('\nCase 6: Page Range [1,5,14] (All Pages)');
        const result6 = await parsePdfToMarkdown(samplePath, [1, 5, 14]);
        console.log(`Pages returned: ${result6.pages.length}`);
        console.log(`Page numbers: ${result6.pages.map(p => p.pageNumber).join(', ')}`);

    } catch (error) {
        console.error('❌ Error in page filtering test:', error);
    }
}

async function main() {
    console.log('🧪 PDF v3 Sample Test Suite (@opendocsg/pdf2md)');

    // Test Page Filtering
    await testPageFiltering();

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
