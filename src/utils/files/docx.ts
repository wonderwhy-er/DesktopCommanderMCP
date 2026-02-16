/**
 * DOCX File Handler
 *
 * Approach: expose DOCX as filtered/raw XML through existing read_file + edit_block.
 *
 * READ (default): Returns a text-bearing outline — skips shapes, drawings, SVG noise.
 *   Shows paragraphs with text, tables with cell content, style info, and image refs.
 *   Each element shows its raw XML tag context so Claude can target it for editing.
 *
 * READ (with offset/length): Returns raw pretty-printed XML with line pagination,
 *   so Claude can drill into specific sections when the outline isn't enough.
 *
 * EDIT (old_string/new_string): Find/replace on the pretty-printed XML, then
 *   compact and repack into valid DOCX. Works exactly like text file editing.
 *
 * Round-trip: DOCX → unzip → pretty-print → [outline or raw] → edit → compact → repack
 */

import fs from 'fs/promises';
import PizZip from 'pizzip';
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';

// ════════════════════════════════════════════════════════════════
// XML Pretty-Print / Compact
// ════════════════════════════════════════════════════════════════

/**
 * Pretty-print XML: split tags onto separate lines with indentation.
 * Preserves text node content exactly. compact→pretty→compact is lossless.
 */
function prettyPrintXml(xml: string): string {
    const parts = xml.split(/(?<=>)(?=<)/);
    const lines: string[] = [];
    let depth = 0;

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const isClosing = trimmed.startsWith('</');
        const isSelfClosing = trimmed.endsWith('/>');
        const isProcessingInstruction = trimmed.startsWith('<?');
        const isInline = !isClosing && !isSelfClosing && trimmed.includes('</');

        if (isClosing) depth = Math.max(0, depth - 1);

        lines.push('  '.repeat(depth) + trimmed);

        if (!isClosing && !isSelfClosing && !isInline && !isProcessingInstruction) depth++;
    }

    return lines.join('\n');
}

/**
 * Compact pretty-printed XML back — strip leading indentation, join lines.
 * Does NOT touch whitespace inside <w:t> text nodes.
 */
function compactXml(prettyXml: string): string {
    return prettyXml.split('\n').map(l => l.trimStart()).join('');
}

// ════════════════════════════════════════════════════════════════
// DOCX ZIP helpers
// ════════════════════════════════════════════════════════════════

interface DocxZipContents {
    zip: PizZip;
    documentXml: string;
    /** All XML parts keyed by path (e.g. "word/header1.xml") */
    xmlParts: Map<string, string>;
}

function loadDocxZip(buf: Buffer): DocxZipContents {
    const zip = new PizZip(buf);
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

    const xmlParts = new Map<string, string>();
    // Collect all XML parts for potential editing
    const zipFiles = zip.files;
    for (const relativePath of Object.keys(zipFiles)) {
        if (relativePath.endsWith('.xml') || relativePath.endsWith('.rels')) {
            try {
                xmlParts.set(relativePath, zipFiles[relativePath].asText());
            } catch { /* skip binary entries */ }
        }
    }

    return {
        zip,
        documentXml: docFile.asText(),
        xmlParts,
    };
}

// ════════════════════════════════════════════════════════════════
// Outline extraction — the key feature
// ════════════════════════════════════════════════════════════════

interface OutlineItem {
    index: number;
    tag: string;
    style?: string;
    text?: string;
    textLength?: number;
    tableInfo?: string;
    imageInfo?: string;
    skippedReason?: string;
    /** Raw XML of this element (for small items) or truncated preview */
    xml?: string;
}

/**
 * Extract a text-bearing outline from document.xml.
 *
 * Walks direct children of <w:body> and for each:
 * - w:p (paragraph): extracts text from <w:t> elements, shows style
 * - w:tbl (table): extracts cell text for each row
 * - mc:AlternateContent / shapes / drawings: shows size, skips content
 * - w:sdt: looks inside for text/tables
 *
 * Returns a human-readable outline with enough context for editing.
 */
function extractOutline(xml: string): string {
    const lines: string[] = [];

    // Parse body children using regex — faster and more reliable than DOM for outline
    // Find <w:body>...</w:body>
    const bodyMatch = xml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
    if (!bodyMatch) return '[No w:body found in document.xml]';

    const bodyContent = bodyMatch[1];

    // Split into top-level children of w:body
    // We need to find top-level elements, respecting nesting
    const children = splitTopLevelElements(bodyContent);

    let paragraphCount = 0;
    let tableCount = 0;
    let imageCount = 0;

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const tagMatch = child.match(/^<(\S+?)[\s>\/]/);
        if (!tagMatch) continue;
        const tag = tagMatch[1];

        if (tag === 'w:p') {
            const text = extractAllText(child);
            const textFragments = extractTextFragments(child);
            const style = extractParagraphStyle(child);
            const hasDrawing = child.includes('<w:drawing') || child.includes('<mc:AlternateContent');

            let line = `[${i}] w:p`;
            if (style) line += ` style="${style}"`;

            if (text && hasDrawing) {
                line += ` (+ drawing/image)`;
                imageCount++;
            } else if (hasDrawing) {
                line += ` [drawing/image, ${(child.length / 1024).toFixed(1)}KB]`;
                imageCount++;
                if (!text) {
                    lines.push(line);
                    paragraphCount++;
                    continue;
                }
            }

            if (textFragments.length > 0) {
                const joined = textFragments.join('');
                if (joined.length > 200) {
                    line += `\n  ${textFragments.slice(0, 5).join('')}...`;
                } else {
                    line += `\n  ${joined}`;
                }
            } else if (!hasDrawing) {
                line += ' (empty)';
            }

            lines.push(line);
            paragraphCount++;
        } else if (tag === 'w:tbl') {
            const rows = extractTableRows(child);
            let line = `[${i}] w:tbl (${rows.length} rows)`;
            const style = extractTableStyle(child);
            if (style) line += ` style="${style}"`;
            // Show first few rows as preview
            for (let r = 0; r < Math.min(rows.length, 4); r++) {
                const cells = rows[r].map(c => {
                    if (!c || c.trim() === '') return '';
                    return c.length > 40 ? c.substring(0, 40) + '…' : c;
                });
                line += `\n  row${r}: [${cells.join(' | ')}]`;
            }
            if (rows.length > 4) line += `\n  ... (${rows.length - 4} more rows)`;
            lines.push(line);
            tableCount++;
        } else if (tag === 'w:sdt') {
            // Structured document tag — look inside for content
            const sdtFragments = extractTextFragments(child);
            const innerTables = (child.match(/<w:tbl[\s>]/g) || []).length;
            let line = `[${i}] w:sdt`;
            if (innerTables > 0) {
                line += ` (contains ${innerTables} table${innerTables > 1 ? 's' : ''})`;
                tableCount += innerTables;
            }
            if (sdtFragments.length > 0) {
                const joined = sdtFragments.join('');
                if (joined.length > 150) {
                    line += `\n  ${sdtFragments.slice(0, 3).join('')}...`;
                } else {
                    line += `\n  ${joined}`;
                }
            }
            lines.push(line);
        } else if (tag === 'w:sectPr') {
            lines.push(`[${i}] w:sectPr (section properties)`);
        } else if (tag === 'mc:AlternateContent') {
            lines.push(`[${i}] mc:AlternateContent [drawing, ${(child.length / 1024).toFixed(1)}KB — skipped]`);
            imageCount++;
        } else {
            lines.push(`[${i}] ${tag} (${(child.length / 1024).toFixed(1)}KB)`);
        }
    }

    // Summary header
    const header = `DOCX Outline: ${children.length} body children, ${paragraphCount} paragraphs, ${tableCount} tables, ${imageCount} images\n` +
        `Use read_file with offset/length to see raw XML of specific sections.\n` +
        `Use edit_block with old_string/new_string to edit the XML directly.\n` +
        '─'.repeat(70);

    return header + '\n' + lines.join('\n');
}

// ════════════════════════════════════════════════════════════════
// XML text extraction helpers (regex-based, no DOM needed)
// ════════════════════════════════════════════════════════════════

/** Extract all <w:t>...</w:t> text content from an XML fragment */
function extractAllText(xml: string): string {
    const texts: string[] = [];
    // Match <w:t> or <w:t xml:space="preserve"> but NOT <w:tbl>, <w:tc>, <w:tr>, etc.
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        if (m[1]) texts.push(m[1]);
    }
    return texts.join('').trim();
}

/** Extract <w:t>...</w:t> elements as XML fragments for use in edit_block */
function extractTextFragments(xml: string): string[] {
    const fragments: string[] = [];
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        if (m[1] && m[1].trim()) fragments.push(m[0]);
    }
    return fragments;
}

/** Extract paragraph style id from w:pPr/w:pStyle */
function extractParagraphStyle(xml: string): string | null {
    const m = xml.match(/<w:pStyle\s+w:val="([^"]+)"/);
    return m ? m[1] : null;
}

/** Extract table style from w:tblPr/w:tblStyle */
function extractTableStyle(xml: string): string | null {
    const m = xml.match(/<w:tblStyle\s+w:val="([^"]+)"/);
    return m ? m[1] : null;
}

/** Extract table rows as arrays of cell text */
function extractTableRows(tableXml: string): string[][] {
    const rows: string[][] = [];
    // Find each <w:tr>...</w:tr> using nesting-aware extraction
    const rowElements = extractNestedElements(tableXml, 'w:tr');
    for (const rowXml of rowElements) {
        const cells: string[] = [];
        const cellElements = extractNestedElements(rowXml, 'w:tc');
        for (const cellXml of cellElements) {
            cells.push(extractAllText(cellXml));
        }
        if (cells.length > 0) rows.push(cells);
    }
    return rows;
}

/**
 * Extract all occurrences of a named element from XML, respecting nesting.
 * Returns array of full element strings including open/close tags.
 */
function extractNestedElements(xml: string, tagName: string): string[] {
    const results: string[] = [];
    const openTag = `<${tagName}`;
    const closeTag = `</${tagName}>`;
    let searchFrom = 0;

    while (searchFrom < xml.length) {
        const openPos = xml.indexOf(openTag, searchFrom);
        if (openPos === -1) break;

        // Check it's actually a tag start (followed by space, >, or /)
        const charAfter = xml[openPos + openTag.length];
        if (charAfter !== ' ' && charAfter !== '>' && charAfter !== '/') {
            searchFrom = openPos + 1;
            continue;
        }

        // Check for self-closing
        const nextClose = xml.indexOf('>', openPos);
        if (nextClose !== -1 && xml[nextClose - 1] === '/') {
            results.push(xml.substring(openPos, nextClose + 1));
            searchFrom = nextClose + 1;
            continue;
        }

        // Find matching close tag respecting nesting
        let depth = 1;
        let pos = nextClose + 1;
        while (depth > 0 && pos < xml.length) {
            const nextOpen = xml.indexOf(openTag, pos);
            const nextCloseTag = xml.indexOf(closeTag, pos);

            if (nextCloseTag === -1) break; // malformed XML

            if (nextOpen !== -1 && nextOpen < nextCloseTag) {
                // Check it's actually an open tag
                const ca = xml[nextOpen + openTag.length];
                if (ca === ' ' || ca === '>' || ca === '/') {
                    depth++;
                }
                pos = nextOpen + openTag.length;
            } else {
                depth--;
                if (depth === 0) {
                    results.push(xml.substring(openPos, nextCloseTag + closeTag.length));
                }
                pos = nextCloseTag + closeTag.length;
            }
        }
        searchFrom = pos;
    }
    return results;
}

/**
 * Split XML into top-level elements respecting nesting depth.
 * E.g. for body content, returns each direct child element as a string.
 */
function splitTopLevelElements(xml: string): string[] {
    const elements: string[] = [];
    let depth = 0;
    let currentStart = -1;

    // Simple state machine: track < > and nesting
    let i = 0;
    while (i < xml.length) {
        if (xml[i] === '<') {
            // Check what kind of tag
            if (xml[i + 1] === '/') {
                // Closing tag
                depth--;
                if (depth === 0) {
                    // Find end of this closing tag
                    const closeEnd = xml.indexOf('>', i);
                    if (closeEnd !== -1 && currentStart !== -1) {
                        elements.push(xml.substring(currentStart, closeEnd + 1).trim());
                        currentStart = -1;
                    }
                    i = closeEnd + 1;
                    continue;
                }
            } else if (xml[i + 1] === '?' || xml[i + 1] === '!') {
                // Processing instruction or comment — skip
                const end = xml.indexOf('>', i);
                i = end + 1;
                continue;
            } else {
                // Opening tag
                if (depth === 0) currentStart = i;
                // Check for self-closing
                const tagEnd = xml.indexOf('>', i);
                if (tagEnd !== -1 && xml[tagEnd - 1] === '/') {
                    // Self-closing
                    if (depth === 0) {
                        elements.push(xml.substring(currentStart, tagEnd + 1).trim());
                        currentStart = -1;
                        i = tagEnd + 1;
                        continue;
                    }
                } else {
                    depth++;
                }
                i = tagEnd + 1;
                continue;
            }
        }
        i++;
    }

    return elements.filter(e => e.length > 0);
}

/**
 * Extract outline info for headers and footers from the DOCX zip.
 */
function extractHeaderFooterOutline(zip: PizZip): string {
    const parts: string[] = [];
    const zipFiles = zip.files;

    for (const relativePath of Object.keys(zipFiles)) {
        if ((relativePath.startsWith('word/header') || relativePath.startsWith('word/footer'))
            && relativePath.endsWith('.xml')) {
            try {
                const xml = zipFiles[relativePath].asText();
                const text = extractAllText(xml);
                const name = relativePath.replace('word/', '');
                if (text) {
                    parts.push(`${name}: "${text.length > 100 ? text.substring(0, 100) + '...' : text}"`);
                } else {
                    parts.push(`${name}: (no text content)`);
                }
            } catch { /* skip */ }
        }
    }

    return parts.length > 0 ? '\n\nHeaders/Footers:\n' + parts.join('\n') : '';
}

// ════════════════════════════════════════════════════════════════
// Count occurrences helper
// ════════════════════════════════════════════════════════════════

function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let pos = haystack.indexOf(needle);
    while (pos !== -1) {
        count++;
        pos = haystack.indexOf(needle, pos + 1);
    }
    return count;
}

// ════════════════════════════════════════════════════════════════
// DocxFileHandler — implements FileHandler
// ════════════════════════════════════════════════════════════════

export class DocxFileHandler implements FileHandler {
    private readonly extensions = ['.docx'];

    canHandle(path: string): boolean {
        return this.extensions.some(e => path.toLowerCase().endsWith(e));
    }

    /**
     * Read DOCX content.
     *
     * Default (offset=0, no explicit length or default length): returns outline
     * With offset/length: returns raw pretty-printed XML with line pagination
     */
    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        const buf = await fs.readFile(path);
        const { zip, documentXml } = loadDocxZip(buf);
        const pretty = prettyPrintXml(documentXml);
        const allLines = pretty.split('\n');
        const totalLines = allLines.length;
        const offset = options?.offset ?? 0;
        const length = options?.length;

        // If user explicitly requests non-zero offset, give raw XML with pagination
        const wantsRaw = offset !== 0;

        if (wantsRaw) {
            let startLine: number;
            let sliceLength: number;

            if (offset < 0) {
                startLine = Math.max(0, totalLines + offset);
                sliceLength = totalLines - startLine;
            } else {
                startLine = offset;
                sliceLength = length ?? totalLines;
            }

            const sliced = allLines.slice(startLine, startLine + sliceLength);
            const remaining = totalLines - (startLine + sliced.length);
            const status = `[DOCX XML: lines ${startLine}-${startLine + sliced.length - 1} of ${totalLines} (${remaining} remaining)]`;

            return {
                content: status + '\n' + sliced.join('\n'),
                mimeType: 'application/xml',
                metadata: { isDocx: true, lineCount: totalLines },
            };
        }

        // Default: return outline
        const outline = extractOutline(documentXml);
        const headerFooterInfo = extractHeaderFooterOutline(zip);
        const rawSizeKB = (documentXml.length / 1024).toFixed(1);

        return {
            content: outline + headerFooterInfo +
                `\n\nRaw XML: ${totalLines} lines, ${rawSizeKB}KB. Use offset/length to read raw XML sections.`,
            mimeType: 'text/plain',
            metadata: { isDocx: true, lineCount: totalLines },
        };
    }

    /**
     * Write DOCX — not directly supported.
     * Use edit_block for modifications.
     */
    async write(_path: string, _content: any, _mode?: 'rewrite' | 'append'): Promise<void> {
        throw new Error(
            'DOCX files cannot be created using write_file. ' +
            'Use edit_block with old_string/new_string to edit existing DOCX files.'
        );
    }

    /**
     * Edit DOCX via find/replace on pretty-printed XML.
     *
     * Works on the same representation that read() returns when using offset/length,
     * so XML fragments copied from read output work as search strings.
     * After editing, XML is compacted and repacked into the DOCX.
     */
    async editRange(
        path: string,
        _range: string,
        content: any,
        options?: Record<string, any>,
    ): Promise<EditResult> {
        try {
            let oldStr: string;
            let newStr: string;
            let expectedReplacements = 1;

            if (typeof content === 'object' && content !== null) {
                oldStr = content.oldStr || content.old_string || content.search || '';
                newStr = content.newStr || content.new_string || content.replace || '';
                expectedReplacements = content.expectedReplacements || content.expected_replacements || 1;
            } else {
                return {
                    success: false, editsApplied: 0,
                    errors: [{ location: 'docx', error: 'DOCX editing requires old_string and new_string' }],
                };
            }

            if (!oldStr) {
                return {
                    success: false, editsApplied: 0,
                    errors: [{ location: 'docx', error: 'old_string cannot be empty' }],
                };
            }

            // Load and pretty-print
            const buf = await fs.readFile(path);
            const zip = new PizZip(buf);
            const docFile = zip.file('word/document.xml');
            if (!docFile) throw new Error('Invalid DOCX: missing word/document.xml');

            const rawXml = docFile.asText();
            const pretty = prettyPrintXml(rawXml);

            // Also check headers/footers for the search string
            let targetPretty = pretty;
            let targetFile = 'word/document.xml';
            let matchCount = countOccurrences(pretty, oldStr);

            // If not found in document.xml, search through headers/footers
            if (matchCount === 0) {
                const xmlFiles = ['word/header1.xml', 'word/header2.xml', 'word/header3.xml',
                    'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'];
                for (const xmlPath of xmlFiles) {
                    const f = zip.file(xmlPath);
                    if (!f) continue;
                    const partPretty = prettyPrintXml(f.asText());
                    const c = countOccurrences(partPretty, oldStr);
                    if (c > 0) {
                        targetPretty = partPretty;
                        targetFile = xmlPath;
                        matchCount = c;
                        break;
                    }
                }
            }

            if (matchCount === 0) {
                return {
                    success: false, editsApplied: 0,
                    errors: [{ location: targetFile, error: `Search string not found in DOCX` }],
                };
            }

            if (matchCount !== expectedReplacements) {
                return {
                    success: false, editsApplied: 0,
                    errors: [{
                        location: targetFile,
                        error: `Expected ${expectedReplacements} occurrence(s) but found ${matchCount}. ` +
                            `Set expected_replacements to ${matchCount} to replace all, ` +
                            `or add more context to make the search unique.`,
                    }],
                };
            }

            // Apply replacement
            let edited = targetPretty;
            if (expectedReplacements === 1) {
                const idx = edited.indexOf(oldStr);
                edited = edited.substring(0, idx) + newStr + edited.substring(idx + oldStr.length);
            } else {
                edited = edited.split(oldStr).join(newStr);
            }

            // Compact and repack
            const compacted = compactXml(edited);
            zip.file(targetFile, compacted);

            const outBuf = zip.generate({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });
            await fs.writeFile(path, outBuf);

            return { success: true, editsApplied: matchCount };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false, editsApplied: 0,
                errors: [{ location: 'docx', error: errorMessage }],
            };
        }
    }

    /**
     * Get DOCX file info
     */
    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        let metadata: any = { isDocx: true };
        try {
            const buf = await fs.readFile(path);
            const { documentXml } = loadDocxZip(buf);
            const text = extractAllText(documentXml);
            const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
            const paragraphCount = (documentXml.match(/<w:p[\s>]/g) || []).length;
            const tableCount = (documentXml.match(/<w:tbl[\s>]/g) || []).length;
            const imageCount = (documentXml.match(/<w:drawing[\s>]/g) || []).length;

            metadata = {
                isDocx: true,
                paragraphCount,
                tableCount,
                imageCount,
                wordCount,
            };
        } catch { /* return basic info */ }

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: false,
            isFile: true,
            permissions: (stats.mode & 0o777).toString(8),
            fileType: 'docx' as any,
            metadata,
        };
    }
}
