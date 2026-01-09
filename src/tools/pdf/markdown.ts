import fs from 'fs/promises';
import { existsSync } from 'fs';
import { mdToPdf } from 'md-to-pdf';
import type { PageRange } from './lib/pdf2md.js';
import { PdfParseResult, pdf2md } from './lib/pdf2md.js';

const isUrl = (source: string): boolean =>
    source.startsWith('http://') || source.startsWith('https://');

/**
 * Find system-installed Chrome/Chromium browser
 * Returns the executable path if found, undefined otherwise
 */
function findSystemChrome(): string | undefined {
    const paths: string[] = process.platform === 'win32' 
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ]
        : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ]
        : [
            // Linux paths
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ];
    
    return paths.find(p => existsSync(p));
}


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
        // Try to find system Chrome to use as fallback
        // This is especially important for MCPB bundles where puppeteer's Chromium isn't installed
        const systemChrome = findSystemChrome();
        
        if (systemChrome) {
            // Merge system Chrome path into launch_options
            options = {
                ...options,
                launch_options: {
                    ...options.launch_options,
                    executablePath: systemChrome,
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
