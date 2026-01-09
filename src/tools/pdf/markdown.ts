import fs from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { mdToPdf } from 'md-to-pdf';
import type { PageRange } from './lib/pdf2md.js';
import { PdfParseResult, pdf2md } from './lib/pdf2md.js';

const isUrl = (source: string): boolean =>
    source.startsWith('http://') || source.startsWith('https://');

// Cached Chrome path to avoid repeated lookups
let cachedChromePath: string | undefined | null = null; // null = not checked yet
let chromeCheckPromise: Promise<string | undefined> | null = null;

/**
 * Get the puppeteer cache directory
 */
function getPuppeteerCacheDir(): string {
    return join(homedir(), '.cache', 'puppeteer');
}

/**
 * Find Chrome in puppeteer's cache directory
 * Returns the executable path if found, undefined otherwise
 */
function findPuppeteerChrome(): string | undefined {
    const cacheDir = getPuppeteerCacheDir();
    const chromeDir = join(cacheDir, 'chrome');
    
    if (!existsSync(chromeDir)) {
        return undefined;
    }
    
    try {
        // Look for chrome directories (e.g., win64-143.0.7499.169)
        const { readdirSync } = require('fs');
        const versions = readdirSync(chromeDir);
        
        for (const version of versions) {
            const chromePath = process.platform === 'win32'
                ? join(chromeDir, version, 'chrome-win64', 'chrome.exe')
                : process.platform === 'darwin'
                ? join(chromeDir, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
                : join(chromeDir, version, 'chrome-linux64', 'chrome');
            
            if (existsSync(chromePath)) {
                return chromePath;
            }
            
            // Also check for arm64 mac
            if (process.platform === 'darwin') {
                const armPath = join(chromeDir, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
                if (existsSync(armPath)) {
                    return armPath;
                }
            }
        }
    } catch {
        // Ignore errors reading cache directory
    }
    
    return undefined;
}

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

/**
 * Download and install Chrome using @puppeteer/browsers
 * Returns the executable path after installation
 */
async function installChrome(): Promise<string> {
    // Dynamic import to avoid loading if not needed
    const { install, Browser, detectBrowserPlatform, resolveBuildId } = await import('@puppeteer/browsers');
    
    const cacheDir = getPuppeteerCacheDir();
    const platform = detectBrowserPlatform()!;
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    
    console.error('Downloading Chrome for PDF generation (this may take a few minutes)...');
    
    const installedBrowser = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir,
        downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
            const percent = Math.round((downloadedBytes / totalBytes) * 100);
            process.stderr.write(`\rDownloading Chrome: ${percent}%`);
        },
    });
    
    console.error('\nChrome download complete.');
    
    return installedBrowser.executablePath;
}

/**
 * Find or install Chrome for PDF generation
 * Priority: 1. Puppeteer cache, 2. System Chrome, 3. Install Chrome
 * Results are cached to avoid repeated lookups
 */
async function getChromePath(): Promise<string | undefined> {
    // Return cached result if available
    if (cachedChromePath !== null) {
        return cachedChromePath;
    }
    
    // If a check is already in progress, wait for it
    if (chromeCheckPromise) {
        return chromeCheckPromise;
    }
    
    // Start the check
    chromeCheckPromise = (async () => {
        // 1. Check puppeteer cache first (exact compatible version)
        const cachedChrome = findPuppeteerChrome();
        if (cachedChrome) {
            cachedChromePath = cachedChrome;
            return cachedChrome;
        }
        
        // 2. Check system Chrome
        const systemChrome = findSystemChrome();
        if (systemChrome) {
            cachedChromePath = systemChrome;
            return systemChrome;
        }
        
        // 3. Install Chrome as last resort
        try {
            const installedChrome = await installChrome();
            cachedChromePath = installedChrome;
            return installedChrome;
        } catch (error) {
            console.error('Failed to install Chrome:', error);
            cachedChromePath = undefined;
            return undefined;
        }
    })();
    
    const result = await chromeCheckPromise;
    chromeCheckPromise = null;
    return result;
}

/**
 * Preemptively ensure Chrome is available for PDF generation.
 * Call this at server startup to trigger download in background if needed.
 * Returns immediately, download happens in background.
 */
export function ensureChromeAvailable(): void {
    // Don't await - let it run in background
    getChromePath().catch((error) => {
        console.error('Background Chrome check failed:', error);
    });
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
