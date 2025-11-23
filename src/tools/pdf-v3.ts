/**
 * PDF generation using pdf-lib
 * Creates PDF documents from markdown content with advanced layout support
 */

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import fs from 'fs/promises';

/**
 * Markdown JSON structure for rendering
 */
interface MarkdownBlock {
    type: string;
    text?: string;
    items?: string[];
    level?: number;
    imagePath?: string;
    imageAlt?: string;
}

/**
 * PDF generation options
 */
interface PdfOptions {
    pageMargin?: number;
    normalFontSize?: number;
    headerFontSizes?: number[];
    lineSpacing?: number;
    paragraphSpacing?: number;
    maxImageWidth?: number;
}

/**
 * Wrap text to fit within a maximum width
 */
function wrapText(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
    const words = text.split(" ");
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        const testLine = current ? current + " " + word : word;
        const width = font.widthOfTextAtSize(testLine, fontSize);

        if (width > maxWidth && current) {
            lines.push(current);
            current = word;
        } else {
            current = testLine;
        }
    }

    if (current) {
        lines.push(current);
    }

    return lines;
}

/**
 * Parse simple markdown to JSON blocks
 */
function parseMarkdownToBlocks(markdown: string): MarkdownBlock[] {
    const lines = markdown.split("\n");
    const blocks: MarkdownBlock[] = [];
    let currentParagraph = "";
    let inCodeBlock = false;
    let codeBlockContent = "";
    let listItems: string[] = [];

    const flushParagraph = () => {
        if (currentParagraph.trim()) {
            blocks.push({
                type: "paragraph",
                text: currentParagraph.trim()
            });
            currentParagraph = "";
        }
    };

    const flushList = () => {
        if (listItems.length > 0) {
            blocks.push({
                type: "list-unordered",
                items: [...listItems]
            });
            listItems = [];
        }
    };

    const flushCodeBlock = () => {
        if (codeBlockContent) {
            blocks.push({
                type: "code",
                text: codeBlockContent.trim()
            });
            codeBlockContent = "";
        }
    };

    for (let line of lines) {
        // Code blocks
        if (line.trim().startsWith("```")) {
            if (inCodeBlock) {
                flushCodeBlock();
                inCodeBlock = false;
            } else {
                flushParagraph();
                flushList();
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            codeBlockContent += line + "\n";
            continue;
        }

        // Images
        const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (imageMatch) {
            flushParagraph();
            flushList();
            blocks.push({
                type: "image",
                imageAlt: imageMatch[1],
                imagePath: imageMatch[2]
            });
            continue;
        }

        // Headers
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            flushParagraph();
            flushList();
            const level = headerMatch[1].length;
            blocks.push({
                type: `header${level}`,
                text: headerMatch[2],
                level
            });
            continue;
        }

        // Unordered lists
        const listMatch = line.match(/^[-*+]\s+(.+)$/);
        if (listMatch) {
            flushParagraph();
            listItems.push(listMatch[1]);
            continue;
        }

        // Ordered lists
        const orderedListMatch = line.match(/^\d+\.\s+(.+)$/);
        if (orderedListMatch) {
            flushParagraph();
            if (listItems.length === 0 || blocks[blocks.length - 1]?.type !== "list-ordered") {
                flushList();
            }
            if (blocks[blocks.length - 1]?.type !== "list-ordered") {
                blocks.push({
                    type: "list-ordered",
                    items: []
                });
            }
            blocks[blocks.length - 1].items?.push(orderedListMatch[1]);
            continue;
        }

        // Empty line - paragraph break
        if (line.trim() === "") {
            flushParagraph();
            flushList();
            continue;
        }

        // Regular text - accumulate into paragraph
        flushList();
        if (currentParagraph) {
            currentParagraph += " " + line.trim();
        } else {
            currentParagraph = line.trim();
        }
    }

    // Flush remaining content
    flushParagraph();
    flushList();
    if (inCodeBlock) {
        flushCodeBlock();
    }

    return blocks;
}

/**
 * Check if we need a new page and add one if necessary
 */
function checkAndAddPage(
    pdfDoc: PDFDocument,
    currentPage: PDFPage,
    y: number,
    requiredSpace: number,
    font: PDFFont,
    options: Required<PdfOptions>
): { page: PDFPage; y: number } {
    if (y - requiredSpace < options.pageMargin) {
        const newPage = pdfDoc.addPage();
        const { height } = newPage.getSize();
        return {
            page: newPage,
            y: height - options.pageMargin
        };
    }
    return { page: currentPage, y };
}

/**
 * Load and embed image into PDF document
 */
async function embedImage(pdfDoc: PDFDocument, imagePath: string): Promise<{ image: any; width: number; height: number } | null> {
    try {
        let imageBytes: Uint8Array;

        // Check if it's a URL or local file
        if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
            const response = await fetch(imagePath);
            const arrayBuffer = await response.arrayBuffer();
            imageBytes = new Uint8Array(arrayBuffer);
        } else {
            const buffer = await fs.readFile(imagePath);
            imageBytes = new Uint8Array(buffer);
        }

        // Determine image type and embed
        let image;
        const isPng = imagePath.toLowerCase().endsWith('.png') ||
            (imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4E && imageBytes[3] === 0x47);

        if (isPng) {
            image = await pdfDoc.embedPng(imageBytes);
        } else {
            // Assume JPEG for other formats
            image = await pdfDoc.embedJpg(imageBytes);
        }

        const { width, height } = image.scale(1);
        return { image, width, height };
    } catch (error) {
        console.error(`Failed to embed image ${imagePath}:`, error);
        return null;
    }
}

/**
 * Render markdown blocks to PDF pages
 */
export async function renderMarkdownToPage(
    pdfDoc: PDFDocument,
    mdJson: MarkdownBlock[],
    options: PdfOptions = {}
): Promise<void> {
    const opts: Required<PdfOptions> = {
        pageMargin: options.pageMargin ?? 50,
        normalFontSize: options.normalFontSize ?? 12,
        headerFontSizes: options.headerFontSizes ?? [24, 20, 16, 14, 13, 12],
        lineSpacing: options.lineSpacing ?? 14,
        paragraphSpacing: options.paragraphSpacing ?? 10,
        maxImageWidth: options.maxImageWidth ?? 400
    };

    let page = pdfDoc.addPage();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const monoFont = await pdfDoc.embedFont(StandardFonts.Courier);

    const { width, height } = page.getSize();
    let y = height - opts.pageMargin;
    const maxWidth = width - opts.pageMargin * 2;

    for (const block of mdJson) {
        // -------- HEADERS --------
        if (block.type.startsWith("header")) {
            const level = block.level ?? Number(block.type.replace("header", ""));
            const fontSize = opts.headerFontSizes[level - 1] ?? opts.normalFontSize;
            const headerText = block.text ?? "";

            // Check if we need a new page
            const result = checkAndAddPage(pdfDoc, page, y, fontSize + 20, font, opts);
            page = result.page;
            y = result.y;

            page.drawText(headerText, {
                x: opts.pageMargin,
                y,
                size: fontSize,
                font: boldFont,
                color: rgb(0, 0, 0)
            });

            y -= fontSize + 20;
            continue;
        }

        // -------- PARAGRAPHS --------
        if (block.type === "paragraph") {
            const lines = wrapText(block.text ?? "", maxWidth, font, opts.normalFontSize);

            for (const line of lines) {
                // Check if we need a new page
                const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, font, opts);
                page = result.page;
                y = result.y;

                page.drawText(line, {
                    x: opts.pageMargin,
                    y,
                    size: opts.normalFontSize,
                    font
                });
                y -= opts.lineSpacing;
            }

            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- UNORDERED LISTS --------
        if (block.type === "list-unordered") {
            for (const item of block.items ?? []) {
                const bulletLine = `• ${item}`;
                const lines = wrapText(bulletLine, maxWidth - 10, font, opts.normalFontSize);

                for (let i = 0; i < lines.length; i++) {
                    // Check if we need a new page
                    const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, font, opts);
                    page = result.page;
                    y = result.y;

                    const xOffset = i === 0 ? opts.pageMargin : opts.pageMargin + 15;
                    page.drawText(lines[i], {
                        x: xOffset,
                        y,
                        size: opts.normalFontSize,
                        font
                    });
                    y -= opts.lineSpacing;
                }
            }

            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- ORDERED LISTS --------
        if (block.type === "list-ordered") {
            let index = 1;
            for (const item of block.items ?? []) {
                const numberedLine = `${index}. ${item}`;
                const lines = wrapText(numberedLine, maxWidth - 10, font, opts.normalFontSize);

                for (let i = 0; i < lines.length; i++) {
                    // Check if we need a new page
                    const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, font, opts);
                    page = result.page;
                    y = result.y;

                    const xOffset = i === 0 ? opts.pageMargin : opts.pageMargin + 20;
                    page.drawText(lines[i], {
                        x: xOffset,
                        y,
                        size: opts.normalFontSize,
                        font
                    });
                    y -= opts.lineSpacing;
                }
                index++;
            }

            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- CODE BLOCKS --------
        if (block.type === "code") {
            const codeLines = (block.text ?? "").split("\n");
            const codeFontSize = opts.normalFontSize - 1;

            for (const line of codeLines) {
                // Check if we need a new page
                const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, font, opts);
                page = result.page;
                y = result.y;

                page.drawText(line, {
                    x: opts.pageMargin + 10,
                    y,
                    size: codeFontSize,
                    font: monoFont,
                    color: rgb(0.2, 0.2, 0.2)
                });
                y -= opts.lineSpacing;
            }

            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- IMAGES --------
        if (block.type === "image" && block.imagePath) {
            const embeddedImage = await embedImage(pdfDoc, block.imagePath);

            if (embeddedImage) {
                const { image, width: imgWidth, height: imgHeight } = embeddedImage;

                // Calculate scaled dimensions to fit within maxImageWidth
                let scaledWidth = imgWidth;
                let scaledHeight = imgHeight;

                if (scaledWidth > opts.maxImageWidth) {
                    const scale = opts.maxImageWidth / scaledWidth;
                    scaledWidth = opts.maxImageWidth;
                    scaledHeight = imgHeight * scale;
                }

                // Also ensure it fits within page width
                if (scaledWidth > maxWidth) {
                    const scale = maxWidth / scaledWidth;
                    scaledWidth = maxWidth;
                    scaledHeight = scaledHeight * scale;
                }

                // Check if we need a new page
                const result = checkAndAddPage(pdfDoc, page, y, scaledHeight + opts.paragraphSpacing, font, opts);
                page = result.page;
                y = result.y;

                // Draw the image
                page.drawImage(image, {
                    x: opts.pageMargin,
                    y: y - scaledHeight,
                    width: scaledWidth,
                    height: scaledHeight
                });

                y -= scaledHeight + opts.paragraphSpacing;

                // Optionally draw alt text below image
                if (block.imageAlt) {
                    const altFontSize = opts.normalFontSize - 2;
                    const result2 = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, font, opts);
                    page = result2.page;
                    y = result2.y;

                    page.drawText(block.imageAlt, {
                        x: opts.pageMargin,
                        y,
                        size: altFontSize,
                        font,
                        color: rgb(0.4, 0.4, 0.4)
                    });
                    y -= opts.lineSpacing + opts.paragraphSpacing;
                }
            }
            continue;
        }
    }
}

/**
 * Create PDF from markdown string
 */
export async function createPdfFromMarkdown(
    markdown: string,
    options: PdfOptions = {}
): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.create();
    const blocks = parseMarkdownToBlocks(markdown);

    await renderMarkdownToPage(pdfDoc, blocks, options);

    return await pdfDoc.save();
}

/**
 * Create PDF from markdown JSON blocks
 */
export async function createPdfFromMarkdownJson(
    mdJson: MarkdownBlock[],
    options: PdfOptions = {}
): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.create();

    await renderMarkdownToPage(pdfDoc, mdJson, options);

    return await pdfDoc.save();
}

/**
 * PDF edit operation types
 */
export interface PdfEditOperation {
    type: 'delete' | 'insert';
    /** For delete: page index to delete (0-based). For insert: position to insert at (0-based) */
    pageIndex: number;
    /** For insert: markdown content to convert to PDF pages */
    markdown?: string;
    /** For insert: path to PDF file to insert pages from */
    sourcePdf?: string;
    /** For insert: array of page indices to copy from sourcePdf (0-based). If not specified, all pages are inserted. Only used with sourcePdf. */
    sourcePageIndices?: number[];
    /** For insert: optional PDF generation options (used with markdown) */
    pdfOptions?: PdfOptions;
}

/**
 * Edit an existing PDF by deleting and/or inserting pages
 * 
 * @param pdfPath - Path to the PDF file
 * @param operations - Array of edit operations to perform
 * @returns Modified PDF as Uint8Array
 * 
 * @example
 * // Delete pages 2 and 5 (0-based indexing)
 * await editPdf('input.pdf', [
 *   { type: 'delete', pageIndex: 2 },
 *   { type: 'delete', pageIndex: 5 }
 * ]);
 * 
 * @example
 * // Insert markdown content at position 3
 * await editPdf('input.pdf', [
 *   { type: 'insert', pageIndex: 3, markdown: '# New Page\nContent...' }
 * ]);
 * 
 * @example
 * // Insert pages from another PDF
 * await editPdf('input.pdf', [
 *   { type: 'insert', pageIndex: 0, sourcePdf: 'cover.pdf' }
 * ]);
 */
export async function editPdf(
    pdfPath: string,
    operations: PdfEditOperation[]
): Promise<Uint8Array> {
    // Load the source PDF
    const buffer = await fs.readFile(pdfPath);
    const pdfBytes = new Uint8Array(buffer);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Sort operations to handle them in the correct order
    // Process deletes in reverse order to maintain correct indices
    // Process inserts in forward order
    const deleteOps = operations
        .filter(op => op.type === 'delete')
        .sort((a, b) => b.pageIndex - a.pageIndex); // Reverse order for deletes

    const insertOps = operations
        .filter(op => op.type === 'insert')
        .sort((a, b) => a.pageIndex - b.pageIndex); // Forward order for inserts

    // First, perform all delete operations
    for (const op of deleteOps) {
        const totalPages = pdfDoc.getPageCount();
        if (op.pageIndex < 0 || op.pageIndex >= totalPages) {
            throw new Error(`Delete operation: page index ${op.pageIndex} is out of range (0-${totalPages - 1})`);
        }
        pdfDoc.removePage(op.pageIndex);
    }

    // Then, perform all insert operations
    for (const op of insertOps) {
        let sourcePdfDoc: PDFDocument;
        let pagesToCopy: number[];

        if (op.markdown) {
            // Case 1: Insert from Markdown
            const sourcePdfBytes = await createPdfFromMarkdown(op.markdown, op.pdfOptions);
            sourcePdfDoc = await PDFDocument.load(sourcePdfBytes);
            pagesToCopy = sourcePdfDoc.getPageIndices();
        } else if (op.sourcePdf) {
            // Case 2: Insert from existing PDF file
            const buffer = await fs.readFile(op.sourcePdf);
            const sourcePdfBytes = new Uint8Array(buffer);
            sourcePdfDoc = await PDFDocument.load(sourcePdfBytes);

            const sourceTotalPages = sourcePdfDoc.getPageCount();
            pagesToCopy = op.sourcePageIndices ?? Array.from({ length: sourceTotalPages }, (_, i) => i);

            // Validate source page indices
            for (const pageIdx of pagesToCopy) {
                if (pageIdx < 0 || pageIdx >= sourceTotalPages) {
                    throw new Error(`Insert operation: source page index ${pageIdx} is out of range (0-${sourceTotalPages - 1})`);
                }
            }
        } else {
            throw new Error('Insert operation requires either markdown or sourcePdf to be specified');
        }

        // Copy pages from the source PDF (either generated or loaded)
        const copiedPages = await pdfDoc.copyPages(sourcePdfDoc, pagesToCopy);

        // Insert pages at the specified position
        const totalPages = pdfDoc.getPageCount();
        const insertPosition = Math.min(op.pageIndex, totalPages); // Clamp to valid range

        for (let i = 0; i < copiedPages.length; i++) {
            pdfDoc.insertPage(insertPosition + i, copiedPages[i]);
        }
    }

    // Save and return the modified PDF
    return await pdfDoc.save();
}
