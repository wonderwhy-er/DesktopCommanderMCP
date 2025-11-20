/**
 * Advanced PDF parsing tools using unpdf
 * Supports both local files and URLs with comprehensive parsing options
 */

import { extractText, getDocumentProxy } from 'unpdf';
import fs from 'fs/promises';
import { mdToPdf } from 'md-to-pdf';


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
    processingTime: number;
}

/**
 * PDF content structure
 */
interface PdfContent {
    success: boolean;
    error?: string;
    text: string;
    totalPages: number;
    processingTime: number;
}

/**
 * Internal helper interfaces
 */
interface TextBlock {
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
    fontFamily: string;
}

interface Line {
    y: number;
    items: TextBlock[];
}

/**
 * Filter options for selecting specific pages
 */
interface PdfPageFilter {
    first?: number;
    last?: number;
    partial?: number[];
}

/**
 * Check if source is a URL
 */
function isUrl(source: string): boolean {
    return source.startsWith('http://') || source.startsWith('https://');
}

/**
 * Load PDF document from file or URL
 */
async function loadPdfDocument(source: string): Promise<{ pdf: any, fileSize: number }> {
    const isUrlSource = isUrl(source);
    let fileSize = 0;
    let data: Buffer | ArrayBuffer;

    if (isUrlSource) {
        const response = await fetch(source);
        data = await response.arrayBuffer();
    } else {
        const stats = await fs.stat(source);
        fileSize = stats.size;
        data = await fs.readFile(source);
    }

    const pdf = await getDocumentProxy(new Uint8Array(data));
    return { pdf, fileSize };
}

/**
 * Extract PDF metadata from file or URL
 */
export async function getPdfMetadata(source: string): Promise<PdfMetadata> {
    const startTime = Date.now();

    try {
        const { pdf, fileSize } = await loadPdfDocument(source);
        const metadata = await pdf.getMetadata();
        const info: any = metadata.info || {};

        return {
            success: true,
            fileSize: isUrl(source) ? undefined : fileSize,
            totalPages: pdf.numPages,
            title: info.Title,
            author: info.Author,
            creator: info.Creator,
            producer: info.Producer,
            version: info.PDFFormatVersion,
            creationDate: info.CreationDate,
            modificationDate: info.ModDate,
            isEncrypted: info.IsEncrypted, // Note: unpdf might not expose this directly in info
            processingTime: Date.now() - startTime
        };

    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            totalPages: 0,
            processingTime: Date.now() - startTime
        };
    }
}


/**
 * Extract text blocks from a page and group them into lines
 */
async function extractLinesFromPage(page: any): Promise<Line[]> {
    const textContent = await page.getTextContent();
    const pageStyles = textContent.styles || {};

    const blocks = textContent.items.map((item: any) => {
        // Transform Matrix: [ a b c d e f ]
        // [0] (a): Horizontal Scaling (Scale X) / Cosine of rotation
        // [1] (b): Vertical Skewing   (Skew Y)  / Sine of rotation
        // [2] (c): Horizontal Skewing (Skew X)  / -Sine of rotation
        // [3] (d): Vertical Scaling   (Scale Y) / Cosine of rotation
        // [4] (e): Horizontal Translation (X Position)
        // [5] (f): Vertical Translation   (Y Position)
        const tx = item.transform;

        const x = tx[4];
        const y = tx[5];

        // Calculates the font size by finding the magnitude of the scaling vector
        const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);

        // Round font size to avoid floating point noise (e.g. 11.999 vs 12)
        const roundedFontSize = Math.round(fontSize * 10) / 10;

        return {
            text: item.str,
            x,
            y,
            width: item.width,
            fontSize: roundedFontSize,
            fontFamily: pageStyles[item.fontFamily]?.fontFamily,
        };
    });

    // Group blocks into lines based on Y coordinate
    const lines: Line[] = [];
    const yTolerance = 5;

    for (const block of blocks) {
        let foundLine = false;
        for (const line of lines) {
            if (Math.abs(line.y - block.y) < yTolerance) {
                line.items.push(block);
                foundLine = true;
                break;
            }
        }
        if (!foundLine) {
            lines.push({ y: block.y, items: [block] });
        }
    }

    // Sort lines top-to-bottom
    lines.sort((a, b) => b.y - a.y);

    // Sort items left-to-right within lines
    for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
    }

    return lines;
}

/**
 * Extract pages based on filter options
 */
async function extractPagesWithLines(pdf: any, filter?: PdfPageFilter): Promise<Line[][]> {
    const numPages = pdf.numPages;
    const results: Line[][] = [];

    for (let i = 1; i <= numPages; i++) {
        const matchFirst = filter?.first ? i <= filter.first : false;
        const matchLast = filter?.last ? i > numPages - filter.last : false;
        const matchPartial = filter?.partial ? filter.partial.includes(i) : false;
        const noFilter = !filter || (!filter.first && !filter.last && !filter.partial);

        if (noFilter || matchFirst || matchLast || matchPartial) {
            const page = await pdf.getPage(i);
            const lines = await extractLinesFromPage(page);
            results.push(lines);
        }
    }

    return results;
}

/**
 * Merge lines into pages with plain text
 */
function mergeLinesToPages(pages: Line[][]): string[] {
    const pagesText: string[] = [];
    for (const page of pages) {
        let pageText = "";
        for (const line of page) {
            let lineText = "";
            let lastX = -1;
            let lastWidth = 0;

            for (const item of line.items) {
                const width = item.width || (item.text.length * (item.fontSize || 10) * 0.5);
                if (lastX >= 0 && (item.x - (lastX + lastWidth)) > (item.fontSize * 0.2 || 2)) {
                    lineText += " ";
                }
                lineText += item.text;
                lastX = item.x;
                lastWidth = width;
            }
            pageText += lineText.trim() + "\n";
        }
        pagesText.push(pageText.trim());
    }
    return pagesText;
}

/**
 * Extract PDF content from file or URL
 */
export async function getPdfContent(source: string, filter?: PdfPageFilter): Promise<PdfContent> {
    const startTime = Date.now();

    try {
        const { pdf } = await loadPdfDocument(source);

        // Out-of-the box solution - do not process new lines correctly, just gives text
        // const { totalPages, text } = await extractText(pdf, { mergePages: false });

        const allPages = await extractPagesWithLines(pdf, filter);
        const fullText = mergeLinesToPages(allPages);

        return {
            success: true,
            text: fullText.join('\n\n'),
            totalPages: pdf.numPages,
            processingTime: Date.now() - startTime
        };

    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            text: '',
            totalPages: 0,
            processingTime: Date.now() - startTime
        };
    }
}

/**
 * Determine the "Normal" Font Size (most frequent)
 */
const getNormalFontSize = (lines: Line[]) => {
    const fontSizeFreq = new Map<number, number>();
    for (const line of lines) {
        for (const item of line.items) {
            const count = fontSizeFreq.get(item.fontSize) || 0;
            fontSizeFreq.set(item.fontSize, count + item.text.length);
        }
    }
    let normalFontSize = 12;
    let maxFreq = 0;

    for (const [size, freq] of fontSizeFreq.entries()) {
        if (freq > maxFreq) {
            maxFreq = freq;
            normalFontSize = size;
        }
    }

    return normalFontSize;
}
/**
 * Convert PDF to Markdown using heuristic layout analysis
 */
export async function pdfToMarkdown(source: string, filter?: PdfPageFilter): Promise<string> {
    try {
        const { pdf } = await loadPdfDocument(source);

        const allPages = await extractPagesWithLines(pdf, filter);

        // Calculate normal font size across all pages
        const allLines = allPages.flat();
        const normalFontSize = getNormalFontSize(allLines);

        let md = "";

        // Pass 2: Generate Markdown
        for (const lines of allPages) {
            for (const line of lines) {
                let lineText = "";
                let lastX = -1;
                let lastWidth = 0;

                let maxFontSize = 0;
                let hasNormalOrSmaller = false;
                let hasLarger = false;
                let hasMono = false;

                // Analyze line content
                for (const item of line.items) {
                    if (item.fontSize > maxFontSize) maxFontSize = item.fontSize;
                    if (item.fontSize <= normalFontSize + 0.5) hasNormalOrSmaller = true; // Tolerance
                    if (item.fontSize > normalFontSize + 0.5) hasLarger = true;
                    if (item.fontFamily && item.fontFamily.toLowerCase().includes("mono")) hasMono = true;
                }

                // Construct line text with spacing and bolding for mixed lines
                for (const item of line.items) {
                    const width = item.width || (item.text.length * (item.fontSize || 10) * 0.5);

                    if (lastX >= 0 && (item.x - (lastX + lastWidth)) > (item.fontSize * 0.2 || 2)) {
                        lineText += " ";
                    }

                    // Handle mixed font sizes: bold larger text inside a normal line
                    if (hasNormalOrSmaller && hasLarger && item.fontSize > normalFontSize + 0.5) {
                        lineText += `**${item.text}**`;
                    } else {
                        lineText += item.text;
                    }

                    lastX = item.x;
                    lastWidth = width;
                }

                const text = lineText.trim();
                if (!text) continue;

                // -------- CODE BLOCKS --------
                if (hasMono) {
                    md += "```\n" + text + "\n```\n\n";
                    continue;
                }

                // -------- HEADINGS (Relative Size) --------
                if (!hasNormalOrSmaller && maxFontSize > normalFontSize) {
                    const ratio = maxFontSize / normalFontSize;

                    if (ratio >= 2.0) {
                        md += `# ${text}\n\n`;
                        continue;
                    }
                    if (ratio >= 1.5) {
                        md += `## ${text}\n\n`;
                        continue;
                    }
                    if (ratio >= 1.2) {
                        md += `### ${text}\n\n`;
                        continue;
                    }
                    md += `**${text}**\n\n`;
                    continue;
                }

                // -------- BULLET LISTS --------
                if (/^[-•‣●▪]/.test(text)) {
                    md += `- ${text.replace(/^[-•‣●▪]\s*/, "")}\n`;
                    continue;
                }

                // -------- NORMAL PARAGRAPH --------
                md += text + "\n\n";
            }
            md += `\n`; // Page break
        }

        return md.trim();

    } catch (error) {
        console.error("Error converting PDF to Markdown:", error);
        throw error;
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