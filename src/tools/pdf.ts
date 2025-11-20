import pdf2md from '@opendocsg/pdf2md';
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
export async function pdfToMarkdown(source: string): Promise<string> {
    try {
        let data: Buffer | ArrayBuffer;

        if (isUrl(source)) {
            const response = await fetch(source);
            data = await response.arrayBuffer();
        } else {
            data = await fs.readFile(source);
        }

        // pdf2md expects a buffer or typed array. 
        // fs.readFile returns a Buffer (which is a Uint8Array subclass in Node).
        // fetch returns ArrayBuffer.
        // We can convert both to Uint8Array to be safe, or pass as is if compatible.
        // The type definition says: string | URL | TypedArray | ArrayBuffer | ...

        // @ts-ignore: Type definition mismatch for ESM usage
        const markdown = await pdf2md(new Uint8Array(data));
        return markdown;

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