/**
 * Advanced PDF parsing tools using pdf-parse v2.4.5
 * Supports both local files and URLs with comprehensive parsing options
 */

import { PDFParse, VerbosityLevel } from 'pdf-parse';
import fs from 'fs/promises';
import { mdToPdf } from 'md-to-pdf';

/**
 * PDF parsing options based on pdf-parse v2.4.5 documentation
 */
interface PdfParseOptions {
    /** Number of pages to process, starting from first page */
    max?: number;
    /** Verbosity level for logging */
    verbosity?: number;
    /** Custom password for encrypted PDFs */
    password?: string;
    /** Page range specification */
    pageRange?: {
        partial?: number[];
        first?: number;
        last?: number;
    };
}

/**
 * PDF metadata structure
 */
interface PdfMetadata {
    success: boolean;
    error?: string;
    fileSize?: number;
    totalPages: number;
    title?: string;
    author?: string;
    creator?: string;
    producer?: string;
    version?: string;
    creationDate?: string;
    modificationDate?: string;
    isEncrypted?: boolean;
    isUrl: boolean;
    processingTime: number;
}

/**
 * PDF content structure
 */
interface PdfContent {
    success: boolean;
    error?: string;
    text: string;
    pages: Array<{
        pageNumber: number;
        text: string;
    }>;
    tables: any[];
    images: any[];
    hyperlinks: any[];
    geometry: any[];
    isUrl: boolean;
    processingTime: number;
    downloadTime?: number;
}

/**
 * Check if source is a URL
 */
function isUrl(source: string): boolean {
    return source.startsWith('http://') || source.startsWith('https://');
}

/**
 * Create PDF parser with options
 */
function createParser(source: string, options: PdfParseOptions = {}): PDFParse {
    const parserConfig: any = {
        verbosity: options.verbosity ?? VerbosityLevel.ERRORS,
        parseHyperlinks: true,
        url: source  // Both file paths and URLs work with this approach
    };

    return new PDFParse(parserConfig);
}


/**
 * Extract PDF metadata from file or URL
 */
export async function getPdfMetadata(source: string, options: PdfParseOptions = {}): Promise<PdfMetadata> {
    const startTime = Date.now();
    const isUrlSource = isUrl(source);
    let fileSize = 0;
    let parser: PDFParse | null = null;

    try {
        // Get file size for local files only (URLs will be handled by pdf-parse)
        if (!isUrlSource) {
            const stats = await fs.stat(source);
            fileSize = stats.size;
        }

        // Create parser for both URLs and local files
        parser = createParser(source, options);

        // Extract metadata
        const infoResult = await parser.getInfo();
        const pdfInfo = infoResult?.info || {};

        const metadata: PdfMetadata = {
            success: true,
            fileSize,
            totalPages: infoResult?.total || 1,
            title: pdfInfo.Title || undefined,
            author: pdfInfo.Author || undefined,
            creator: pdfInfo.Creator || undefined,
            producer: pdfInfo.Producer || undefined,
            version: pdfInfo.PDFFormatVersion || undefined,
            creationDate: pdfInfo.CreationDate || undefined,
            modificationDate: pdfInfo.ModDate || undefined,
            isEncrypted: pdfInfo.IsEncrypted || false,
            isUrl: isUrlSource,
            processingTime: Date.now() - startTime
        };

        return metadata;

    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            totalPages: 0,
            isUrl: isUrlSource,
            processingTime: Date.now() - startTime
        };
    } finally {
        if (parser) {
            try {
                await parser.destroy();
            } catch (cleanupError) {
                // Silent cleanup failure
            }
        }
    }
}

/**
 * Extract PDF content from file or URL with advanced options
 */
export async function getPdfContent(source: string, options: PdfParseOptions = {}): Promise<PdfContent> {
    const startTime = Date.now();
    const isUrlSource = isUrl(source);
    let parser: PDFParse | null = null;

    try {
        // Create parser for both URLs and local files
        parser = createParser(source, options);

        // Extract text content

        const textResult = await parser.getText(options.pageRange);
        const fullText = (textResult && textResult.text) ? textResult.text : '';

        // Process pages
        const pages: PdfContent['pages'] = [];
        if (textResult && textResult.pages) {
            textResult.pages.forEach((page: any, index: number) => {
                const pageText = page.text || '';
                const pageInfo = {
                    pageNumber: page.num || (index + 1),
                    text: pageText,
                };

                // Apply page range filtering if specified
                const { pageRange } = options;
                if (pageRange) {
                    const pageNum = pageInfo.pageNumber;
                    if (pageRange.first && pageNum < pageRange.first) return;
                    if (pageRange.last && pageNum > pageRange.last) return;
                }

                pages.push(pageInfo);
            });
        }

        // Apply max pages limit
        const maxPages = options.max;
        const limitedPages = maxPages ? pages.slice(0, maxPages) : pages;

        // Extract advanced features
        let tables: any[] = [];
        let images: any[] = [];
        let hyperlinks: any[] = [];
        let geometry: any[] = [];

        try {
            const tableResult = await parser.getTable();
            tables = Array.isArray(tableResult) ? tableResult : [];
        } catch (e) {
            // Tables not available
            tables = [];
        }

        try {
            const imageResult = await parser.getImage();
            images = Array.isArray(imageResult) ? imageResult : [];
        } catch (e) {
            // Images not available
            images = [];
        }

        try {
            // Use public API if available, otherwise fallback
            const linkResult = await (parser as any).getHyperlinks?.() || [];
            hyperlinks = Array.isArray(linkResult) ? linkResult : [];
        } catch (e) {
            // Hyperlinks not available
            hyperlinks = [];
        }

        try {
            // Use public API if available, otherwise fallback
            const geometryResult = await (parser as any).getPathGeometry?.() || [];
            geometry = Array.isArray(geometryResult) ? geometryResult : [];
        } catch (e) {
            // Geometry not available
            geometry = [];
        }

        // Calculate statistics
        const words = fullText.split(/\s+/).filter(w => w.length > 0);
        const lines = fullText.split('\n');

        const content: PdfContent = {
            success: true,
            text: fullText,
            pages: limitedPages,
            tables,
            images,
            hyperlinks,
            geometry,
            isUrl: isUrlSource,
            processingTime: Date.now() - startTime
        };

        return content;

    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            text: '',
            pages: [],
            tables: [],
            images: [],
            hyperlinks: [],
            geometry: [],
            isUrl: isUrlSource,
            processingTime: Date.now() - startTime
        };
    } finally {
        if (parser) {
            try {
                await parser.destroy();
            } catch (cleanupError) {
                // Silent cleanup failure
            }
        }
    }
}

/**
 * Create PDF from markdown content
 */
export async function createPdfFromMarkdown(markdown: string, outputPath: string, options: any = {}): Promise<boolean> {
    try {
        const pdf = await mdToPdf({ content: markdown }, options).catch(console.error);

        if (pdf) {
            await fs.writeFile(outputPath, pdf.content);
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error creating PDF:', error);
        return false;
    }
}