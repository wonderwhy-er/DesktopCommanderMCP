#!/usr/bin/env node

/**
 * Test script for PDF parsing functionality using @opendocsg/pdf2md (v3)
 * Verifies parsing of sample PDFs and URL
 */

import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import assert from 'assert';
import { runIfMain, skip } from './helpers/run-if-main.js';

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

    assert(result.pages.length > 0, `${name} should have at least one page`);
    assert(markdown.trim().length > 0, `${name} should produce text`);
}

async function testPageFiltering() {
    console.log(`
================================================================================`);
    console.log(`🧪 Testing Page Filtering`);
    console.log(`--------------------------------------------------------------------------------`);

    const sampleName = '03_sample_compex.pdf';
    const samplePath = path.join(SAMPLES_DIR, sampleName);

    // Expected pages are derived from the page count the parser reports for the whole file
    const pageCount = (await parsePdfToMarkdown(samplePath)).pages.length;
    assert(pageCount >= 2, `${sampleName} should have several pages, got ${pageCount}`);
    const allPages = Array.from({ length: pageCount }, (_, i) => i + 1);

    const cases = [
        { label: 'Specific Pages [1]', filter: [1], expected: [1] },
        { label: 'Page Range { offset: 0, length: 1 } (First Page)', filter: { offset: 0, length: 1 }, expected: [1] },
        { label: 'Page Range { offset: -2, length: 2 } (Last Two Pages)', filter: { offset: -2, length: 2 }, expected: allPages.slice(-2) },
        { label: 'Page Range { offset: 0, length: 100 } (All Pages)', filter: { offset: 0, length: 100 }, expected: allPages },
        { label: 'Page Range { offset: -100, length: 100 } (All Pages from end)', filter: { offset: -100, length: 100 }, expected: allPages },
        { label: 'Specific Pages [1, 5, 14]', filter: [1, 5, 14], expected: [1, 5, 14].filter(p => p <= pageCount) },
    ];

    for (const { label, filter, expected } of cases) {
        const result = await parsePdfToMarkdown(samplePath, filter);
        const pageNumbers = result.pages.map(p => p.pageNumber);
        assert.deepStrictEqual(pageNumbers, expected, `${label}: expected pages [${expected}], got [${pageNumbers}]`);
        console.log(`✓ ${label}: pages [${pageNumbers.join(', ')}]`);
    }
}

/** Errors that mean "no network", not "the PDF parser is broken" */
function isNetworkError(error) {
    const code = error?.code ?? error?.cause?.code;
    return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
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

    // Test URL (needs network access)
    try {
        await testSample('URL Sample', URL_SAMPLE);
    } catch (error) {
        if (!isNetworkError(error)) throw error;
        skip(`URL sample: no network access to ${URL_SAMPLE} (${error.cause?.code ?? error.code})`);
    }
}

runIfMain(import.meta.url, main);
