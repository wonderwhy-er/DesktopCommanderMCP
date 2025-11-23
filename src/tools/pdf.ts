import { pdf2md, Pdf2MdResult } from './lib/pdf2md-patched.js';
import { mdToPdf } from 'md-to-pdf';
import fs from 'fs/promises';

/**
 * Check if source is a URL
 */
function isUrl(source: string): boolean {
    return source.startsWith('http://') || source.startsWith('https://');
}

/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function pdfToMarkdown(source: string): Promise<Pdf2MdResult> {
    try {
        let data: Buffer | ArrayBuffer;

        if (isUrl(source)) {
            const response = await fetch(source);
            data = await response.arrayBuffer();
        } else {
            data = await fs.readFile(source);
        }

        // @ts-ignore: Type definition mismatch for ESM usage
        const result = await pdf2md(new Uint8Array(data));

        return result;

    } catch (error) {
        console.error("Error converting PDF to Markdown (v3):", error);
        throw error;
    }
}

export async function markdownToPdf(markdown: string, outputPath: string, options: any = {}): Promise<Buffer> {
    try {
        const pdf = await mdToPdf({ content: markdown }, options)


        return pdf.content;
    } catch (error) {
        console.error('Error creating PDF:', error);
        throw error;
    }
}