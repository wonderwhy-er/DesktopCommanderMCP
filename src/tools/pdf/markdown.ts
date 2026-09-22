import fs from 'fs/promises';
import { mdToPdf } from 'md-to-pdf';
import type { PageRange } from './lib/pdf2md.js';
import { PdfParseResult, pdf2md } from './lib/pdf2md.js';
import { getChromePath } from './chrome.js';

// Re-exported for callers that have always reached them through this module.
// They live in chrome.js now, which loads without the renderer.
export { findPuppeteerChrome, pruneOldPuppeteerChromeBuilds, ensureChromeAvailable, getChromePath } from './chrome.js';

const isUrl = (source: string): boolean =>
    source.startsWith('http://') || source.startsWith('https://');

async function loadPdfToBuffer(source: string): Promise<Buffer | ArrayBuffer> {
    if (isUrl(source)) {
        const response = await fetch(source);
        return await response.arrayBuffer();
    } else {
        return await fs.readFile(source);
    }
}

/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function parsePdfToMarkdown(source: string, pageNumbers: number[] | PageRange = []): Promise<PdfParseResult> {
    try {
        const data = await loadPdfToBuffer(source);

        // @ts-ignore: Type definition mismatch for ESM usage
        return await pdf2md(new Uint8Array(data), pageNumbers);

    } catch (error) {
        console.error("Error converting PDF to Markdown (v3):", error);
        throw error;
    }
}

export async function parseMarkdownToPdf(markdown: string, options: any = {}): Promise<Buffer> {
    try {
        // Find Chrome: puppeteer cache -> system Chrome -> install
        const chromePath = await getChromePath();
        
        if (chromePath) {
            options = {
                ...options,
                launch_options: {
                    ...options.launch_options,
                    executablePath: chromePath,
                }
            };
        }
        
        const pdf = await mdToPdf({ content: markdown }, options);

        return pdf.content;
    } catch (error) {
        // Provide helpful error message if Chrome is not found
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Could not find Chrome')) {
            throw new Error(
                'PDF generation requires Chrome or Chromium browser. ' +
                'Please install Google Chrome from https://www.google.com/chrome/ ' +
                'or Chromium, then try again.'
            );
        }
        console.error('Error creating PDF:', error);
        throw error;
    }
}
