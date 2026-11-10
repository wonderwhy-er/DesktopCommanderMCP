import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileFromUrl } from '../dist/tools/filesystem.js';
import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePdfPath = path.join(__dirname, 'samples', '01_sample_simple.pdf');

async function runTests() {
    console.log('Running single-fetch PDF tests (#786)...');

    // Test 1: parsePdfToMarkdown accepts Buffer
    console.log('Test 1: parsePdfToMarkdown accepts a Buffer directly');
    const pdfBuffer = fs.readFileSync(samplePdfPath);
    const bufferResult = await parsePdfToMarkdown(pdfBuffer);
    assert(bufferResult && bufferResult.pages, 'Buffer result must have pages');
    assert(bufferResult.pages.length > 0, 'Buffer result should have at least 1 page');
    console.log('  ✓ parsePdfToMarkdown accepts Buffer successfully');

    // Test 2: parsePdfToMarkdown accepts Uint8Array
    console.log('Test 2: parsePdfToMarkdown accepts a Uint8Array');
    const uint8Result = await parsePdfToMarkdown(new Uint8Array(pdfBuffer));
    assert(uint8Result && uint8Result.pages, 'Uint8Array result must have pages');
    console.log('  ✓ parsePdfToMarkdown accepts Uint8Array successfully');

    // Test 3: readFileFromUrl performs strictly 1 HTTP fetch for PDF URL
    console.log('Test 3: readFileFromUrl makes only 1 HTTP request for PDF URL');
    let requestCount = 0;
    const server = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length
        });
        res.end(pdfBuffer);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const testUrl = `http://127.0.0.1:${port}/document.pdf`;

    try {
        const fileResult = await readFileFromUrl(testUrl);
        assert.strictEqual(requestCount, 1, `Expected exactly 1 request, got ${requestCount}`);
        assert.strictEqual(fileResult.metadata.isPdf, true, 'Result metadata must mark isPdf as true');
        assert(fileResult.metadata.pages && fileResult.metadata.pages.length > 0, 'Result must contain pages');
        console.log(`  ✓ readFileFromUrl successfully read PDF in exactly ${requestCount} HTTP request`);
    } finally {
        server.close();
    }

    console.log('\nAll single-fetch PDF tests passed! (#786)');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
