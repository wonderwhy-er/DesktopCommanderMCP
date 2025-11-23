/**
 * PDF generation using pdf-lib and remark
 * Creates PDF documents from markdown content with advanced layout support
 */

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, Color } from "pdf-lib";
import fs from 'fs/promises';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

/**
 * Text style and content
 */
interface TextSpan {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    break?: boolean; // Hard line break
}

/**
 * Markdown JSON structure for rendering
 */
interface MarkdownBlock {
    type: 'paragraph' | 'header' | 'list-unordered' | 'list-ordered' | 'code' | 'image' | 'table';
    level?: number;
    content?: TextSpan[];
    items?: TextSpan[][];
    code?: string;
    imagePath?: string;
    imageAlt?: string;
    tableRows?: TextSpan[][][];
    tableHeader?: TextSpan[][];
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
    codeFontSize?: number;
}

// Helper to parse rich text from remark nodes
function parseRichText(children: any[]): TextSpan[] {
    const spans: TextSpan[] = [];

    function traverse(nodes: any[], style: { bold?: boolean, italic?: boolean, code?: boolean } = {}) {
        for (const node of nodes) {
            if (node.type === 'text') {
                spans.push({ text: node.value, ...style });
            } else if (node.type === 'strong') {
                traverse(node.children, { ...style, bold: true });
            } else if (node.type === 'emphasis') {
                traverse(node.children, { ...style, italic: true });
            } else if (node.type === 'inlineCode') {
                spans.push({ text: node.value, ...style, code: true });
            } else if (node.type === 'link') {
                // For now, treat links as text, maybe add color later
                traverse(node.children, style);
            } else if (node.type === 'break') {
                spans.push({ text: '\n', break: true });
            } else if (node.children) {
                traverse(node.children, style);
            }
        }
    }

    traverse(children);
    return spans;
}

/**
 * Parse markdown to structured blocks using remark
 */
async function parseMarkdownToBlocks(markdown: string): Promise<MarkdownBlock[]> {
    const processor = unified().use(remarkParse).use(remarkGfm);
    const ast = processor.parse(markdown);

    const blocks: MarkdownBlock[] = [];

    function visit(node: any) {
        if (node.type === 'heading') {
            blocks.push({
                type: 'header',
                level: node.depth,
                content: parseRichText(node.children)
            });
        } else if (node.type === 'paragraph') {
            // Check if it's an image only paragraph
            if (node.children.length === 1 && node.children[0].type === 'image') {
                const img = node.children[0];
                blocks.push({
                    type: 'image',
                    imagePath: img.url,
                    imageAlt: img.alt
                });
            } else {
                blocks.push({
                    type: 'paragraph',
                    content: parseRichText(node.children)
                });
            }
        } else if (node.type === 'list') {
            blocks.push({
                type: node.ordered ? 'list-ordered' : 'list-unordered',
                items: node.children.map((li: any) => {
                    // Flatten list item content (usually paragraph)
                    // This is a simplification: we take all phrasing content from the list item
                    // If list item has multiple paragraphs, we merge them or take the first?
                    // Let's take all children's content flattened.
                    const itemSpans: TextSpan[] = [];
                    const extractSpans = (n: any) => {
                        if (n.type === 'paragraph' || n.type === 'heading') {
                            itemSpans.push(...parseRichText(n.children));
                        } else if (n.children) {
                            n.children.forEach(extractSpans);
                        }
                    };
                    li.children.forEach(extractSpans);
                    return itemSpans;
                })
            });
        } else if (node.type === 'code') {
            blocks.push({
                type: 'code',
                code: node.value
            });
        } else if (node.type === 'table') {
            const rows = node.children.map((row: any) =>
                row.children.map((cell: any) => parseRichText(cell.children))
            );
            // First row is header if align is present? remark-gfm usually treats first row as header
            // But let's just assume first row is header for styling purposes if needed, 
            // or we can check node.children[0] properties. 
            // Actually, let's just store all as rows, and maybe separate header.
            // remark-gfm table structure: Table -> TableRow -> TableCell
            // It doesn't explicitly separate header, but usually first row.
            blocks.push({
                type: 'table',
                tableHeader: rows[0],
                tableRows: rows.slice(1)
            });
        } else if (node.type === 'image') {
            blocks.push({
                type: 'image',
                imagePath: node.url,
                imageAlt: node.alt
            });
        }
    }

    ast.children.forEach(visit);
    return blocks;
}

/**
 * Measure text width with specific font
 */
function measureTextWidth(text: string, font: PDFFont, size: number): number {
    return font.widthOfTextAtSize(text, size);
}

/**
 * Wrap rich text into lines
 */
function wrapRichText(spans: TextSpan[], maxWidth: number, fonts: { regular: PDFFont, bold: PDFFont, italic: PDFFont, mono: PDFFont }, fontSize: number): TextSpan[][] {
    const lines: TextSpan[][] = [];
    let currentLine: TextSpan[] = [];
    let currentLineWidth = 0;

    for (const span of spans) {
        if (span.break) {
            lines.push(currentLine);
            currentLine = [];
            currentLineWidth = 0;
            continue;
        }

        const font = span.code ? fonts.mono : (span.bold ? fonts.bold : (span.italic ? fonts.italic : fonts.regular));
        // Replace newlines with spaces in the text before splitting, 
        // as WinAnsi fonts cannot encode newlines and they should be treated as spaces in paragraphs.
        const sanitizedText = span.text.replace(/\n/g, ' ');
        const words = sanitizedText.split(/(\s+)/); // Split by whitespace, keeping delimiters

        for (const word of words) {
            if (word === '') continue;

            const wordWidth = measureTextWidth(word, font, fontSize);

            if (currentLineWidth + wordWidth > maxWidth && currentLine.length > 0 && word.trim() !== '') {
                // Wrap to new line
                lines.push(currentLine);
                currentLine = [];
                currentLineWidth = 0;

                // If the word is a space at the start of a line, skip it
                if (/^\s+$/.test(word)) continue;
            }

            currentLine.push({ ...span, text: word });
            currentLineWidth += wordWidth;
        }
    }

    if (currentLine.length > 0) {
        lines.push(currentLine);
    }

    return lines;
}

/**
 * Check if we need a new page and add one if necessary
 */
function checkAndAddPage(
    pdfDoc: PDFDocument,
    currentPage: PDFPage,
    y: number,
    requiredSpace: number,
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
 * Draw a line of rich text
 */
function drawLine(
    page: PDFPage,
    line: TextSpan[],
    x: number,
    y: number,
    fonts: { regular: PDFFont, bold: PDFFont, italic: PDFFont, mono: PDFFont },
    fontSize: number
) {
    let currentX = x;
    for (const span of line) {
        const font = span.code ? fonts.mono : (span.bold ? fonts.bold : (span.italic ? fonts.italic : fonts.regular));
        const color = span.code ? rgb(0.2, 0.2, 0.2) : rgb(0, 0, 0);
        // If code, maybe draw a light gray background? (Too complex for now)

        page.drawText(span.text, {
            x: currentX,
            y,
            size: fontSize,
            font,
            color
        });
        currentX += font.widthOfTextAtSize(span.text, fontSize);
    }
}

/**
 * Load and embed image
 */
async function embedImage(pdfDoc: PDFDocument, imagePath: string): Promise<{ image: any; width: number; height: number } | null> {
    try {
        let imageBytes: Uint8Array;

        if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
            const response = await fetch(imagePath);
            const arrayBuffer = await response.arrayBuffer();
            imageBytes = new Uint8Array(arrayBuffer);
        } else {
            const buffer = await fs.readFile(imagePath);
            imageBytes = new Uint8Array(buffer);
        }

        let image;
        const isPng = imagePath.toLowerCase().endsWith('.png') ||
            (imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4E && imageBytes[3] === 0x47);

        if (isPng) {
            image = await pdfDoc.embedPng(imageBytes);
        } else {
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
        maxImageWidth: options.maxImageWidth ?? 400,
        codeFontSize: options.codeFontSize ?? 10
    };

    let page = pdfDoc.addPage();
    const fonts = {
        regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
        bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
        italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
        mono: await pdfDoc.embedFont(StandardFonts.Courier)
    };

    const { width, height } = page.getSize();
    let y = height - opts.pageMargin;
    const maxWidth = width - opts.pageMargin * 2;

    for (const block of mdJson) {
        // -------- HEADERS --------
        if (block.type === 'header') {
            const level = block.level ?? 1;
            const fontSize = opts.headerFontSizes[level - 1] ?? opts.normalFontSize;

            // Wrap header text if needed (though usually headers are short)
            // Use bold font for headers
            const headerFonts = { ...fonts, regular: fonts.bold };
            const lines = wrapRichText(block.content ?? [], maxWidth, headerFonts, fontSize);

            for (const line of lines) {
                const result = checkAndAddPage(pdfDoc, page, y, fontSize + 5, opts);
                page = result.page;
                y = result.y;

                drawLine(page, line, opts.pageMargin, y, headerFonts, fontSize);
                y -= fontSize + 5;
            }
            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- PARAGRAPHS --------
        if (block.type === 'paragraph') {
            const lines = wrapRichText(block.content ?? [], maxWidth, fonts, opts.normalFontSize);

            for (const line of lines) {
                const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, opts);
                page = result.page;
                y = result.y;

                drawLine(page, line, opts.pageMargin, y, fonts, opts.normalFontSize);
                y -= opts.lineSpacing;
            }
            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- LISTS --------
        if (block.type === 'list-unordered' || block.type === 'list-ordered') {
            let index = 1;
            for (const item of block.items ?? []) {
                const bullet = block.type === 'list-unordered' ? '• ' : `${index}. `;
                const bulletWidth = fonts.regular.widthOfTextAtSize(bullet, opts.normalFontSize);
                const contentMaxWidth = maxWidth - bulletWidth;

                const lines = wrapRichText(item, contentMaxWidth, fonts, opts.normalFontSize);

                for (let i = 0; i < lines.length; i++) {
                    const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, opts);
                    page = result.page;
                    y = result.y;

                    if (i === 0) {
                        page.drawText(bullet, {
                            x: opts.pageMargin,
                            y,
                            size: opts.normalFontSize,
                            font: fonts.regular
                        });
                    }

                    drawLine(page, lines[i], opts.pageMargin + bulletWidth, y, fonts, opts.normalFontSize);
                    y -= opts.lineSpacing;
                }
                index++;
            }
            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- CODE BLOCKS --------
        if (block.type === 'code') {
            const codeLines = (block.code ?? "").split("\n");

            // Draw background? Maybe later.

            for (const line of codeLines) {
                const result = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, opts);
                page = result.page;
                y = result.y;

                page.drawText(line, {
                    x: opts.pageMargin + 10,
                    y,
                    size: opts.codeFontSize,
                    font: fonts.mono,
                    color: rgb(0.2, 0.2, 0.2)
                });
                y -= opts.lineSpacing;
            }
            y -= opts.paragraphSpacing;
            continue;
        }

        // -------- IMAGES --------
        if (block.type === 'image' && block.imagePath) {
            const embeddedImage = await embedImage(pdfDoc, block.imagePath);

            if (embeddedImage) {
                const { image, width: imgWidth, height: imgHeight } = embeddedImage;

                let scaledWidth = imgWidth;
                let scaledHeight = imgHeight;

                if (scaledWidth > opts.maxImageWidth) {
                    const scale = opts.maxImageWidth / scaledWidth;
                    scaledWidth = opts.maxImageWidth;
                    scaledHeight = imgHeight * scale;
                }

                if (scaledWidth > maxWidth) {
                    const scale = maxWidth / scaledWidth;
                    scaledWidth = maxWidth;
                    scaledHeight = scaledHeight * scale;
                }

                const result = checkAndAddPage(pdfDoc, page, y, scaledHeight + opts.paragraphSpacing, opts);
                page = result.page;
                y = result.y;

                page.drawImage(image, {
                    x: opts.pageMargin,
                    y: y - scaledHeight,
                    width: scaledWidth,
                    height: scaledHeight
                });

                y -= scaledHeight + opts.paragraphSpacing;

                if (block.imageAlt) {
                    const altFontSize = opts.normalFontSize - 2;
                    const result2 = checkAndAddPage(pdfDoc, page, y, opts.lineSpacing, opts);
                    page = result2.page;
                    y = result2.y;

                    page.drawText(block.imageAlt, {
                        x: opts.pageMargin,
                        y,
                        size: altFontSize,
                        font: fonts.regular,
                        color: rgb(0.4, 0.4, 0.4)
                    });
                    y -= opts.lineSpacing + opts.paragraphSpacing;
                }
            }
            continue;
        }

        // -------- TABLES --------
        if (block.type === 'table') {
            const allRows = [block.tableHeader, ...(block.tableRows ?? [])].filter(r => r) as TextSpan[][][];
            if (allRows.length === 0) continue;

            const numCols = allRows[0].length;

            // Calculate column widths
            // Simple strategy: distribute evenly for now, or based on max content?
            // Let's do evenly to start, it's safer.
            const colWidth = maxWidth / numCols;
            const cellPadding = 5;

            // Draw rows
            for (let r = 0; r < allRows.length; r++) {
                const row = allRows[r];
                const isHeader = r === 0 && block.tableHeader;

                // Calculate max height for this row
                let maxRowHeight = 0;
                const rowCellLines: TextSpan[][][] = []; // [col][lines]

                for (let c = 0; c < numCols; c++) {
                    const cellSpans = row[c] ?? [];
                    const cellLines = wrapRichText(cellSpans, colWidth - cellPadding * 2, fonts, opts.normalFontSize);
                    rowCellLines.push(cellLines);

                    const cellHeight = cellLines.length * opts.lineSpacing + cellPadding * 2;
                    if (cellHeight > maxRowHeight) maxRowHeight = cellHeight;
                }

                // Check page break
                const result = checkAndAddPage(pdfDoc, page, y, maxRowHeight, opts);
                page = result.page;
                y = result.y;

                // Draw row background/border?
                // Let's draw a line below the header
                if (isHeader) {
                    page.drawLine({
                        start: { x: opts.pageMargin, y: y - maxRowHeight },
                        end: { x: opts.pageMargin + maxWidth, y: y - maxRowHeight },
                        thickness: 1,
                        color: rgb(0, 0, 0)
                    });
                }

                // Draw cells
                for (let c = 0; c < numCols; c++) {
                    const cellX = opts.pageMargin + c * colWidth;
                    const cellY = y - cellPadding - opts.normalFontSize; // Start drawing text from top

                    const cellLines = rowCellLines[c];
                    let currentY = cellY; // PDF coordinates y is bottom-up, but text is drawn at baseline.
                    // Actually, drawText y is baseline.
                    // So if we start at y (top of row), we need to go down.
                    // Let's say y is top of row.
                    // First line baseline is y - cellPadding - fontSize? No, usually y - fontSize.
                    // Let's adjust: y is the top y-coordinate of the row.

                    let lineY = y - cellPadding - (opts.normalFontSize * 0.8); // Approximate baseline

                    for (const line of cellLines) {
                        drawLine(page, line, cellX + cellPadding, lineY, isHeader ? { ...fonts, regular: fonts.bold } : fonts, opts.normalFontSize);
                        lineY -= opts.lineSpacing;
                    }
                }

                y -= maxRowHeight;
            }
            y -= opts.paragraphSpacing;
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
    const blocks = await parseMarkdownToBlocks(markdown);

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

// ... editPdf function remains mostly same but needs to use new createPdfFromMarkdown ...
// Actually, editPdf uses createPdfFromMarkdown which we just exported.
// But we need to include editPdf in the file.

/**
 * PDF edit operation types
 */
export interface PdfEditOperation {
    type: 'delete' | 'insert';
    pageIndex: number;
    markdown?: string;
    sourcePdf?: string;
    sourcePageIndices?: number[];
    pdfOptions?: PdfOptions;
}

export async function editPdf(
    pdfPath: string,
    operations: PdfEditOperation[]
): Promise<Uint8Array> {
    const buffer = await fs.readFile(pdfPath);
    const pdfBytes = new Uint8Array(buffer);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const deleteOps = operations
        .filter(op => op.type === 'delete')
        .sort((a, b) => b.pageIndex - a.pageIndex);

    const insertOps = operations
        .filter(op => op.type === 'insert')
        .sort((a, b) => a.pageIndex - b.pageIndex);

    for (const op of deleteOps) {
        const totalPages = pdfDoc.getPageCount();
        if (op.pageIndex < 0 || op.pageIndex >= totalPages) {
            throw new Error(`Delete operation: page index ${op.pageIndex} is out of range`);
        }
        pdfDoc.removePage(op.pageIndex);
    }

    for (const op of insertOps) {
        let sourcePdfDoc: PDFDocument;
        let pagesToCopy: number[];

        if (op.markdown) {
            const sourcePdfBytes = await createPdfFromMarkdown(op.markdown, op.pdfOptions);
            sourcePdfDoc = await PDFDocument.load(sourcePdfBytes);
            pagesToCopy = sourcePdfDoc.getPageIndices();
        } else if (op.sourcePdf) {
            const buffer = await fs.readFile(op.sourcePdf);
            const sourcePdfBytes = new Uint8Array(buffer);
            sourcePdfDoc = await PDFDocument.load(sourcePdfBytes);
            const sourceTotalPages = sourcePdfDoc.getPageCount();
            pagesToCopy = op.sourcePageIndices ?? Array.from({ length: sourceTotalPages }, (_, i) => i);
        } else {
            throw new Error('Insert operation requires either markdown or sourcePdf');
        }

        const copiedPages = await pdfDoc.copyPages(sourcePdfDoc, pagesToCopy);
        const totalPages = pdfDoc.getPageCount();
        const insertPosition = Math.min(op.pageIndex, totalPages);

        for (let i = 0; i < copiedPages.length; i++) {
            pdfDoc.insertPage(insertPosition + i, copiedPages[i]);
        }
    }

    return await pdfDoc.save();
}
