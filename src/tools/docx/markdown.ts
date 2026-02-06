/**
 * DOCX to Markdown Conversion
 * Uses Docxtemplater + XML parsing for reading Word documents
 */

import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { DOMParser } = require('@xmldom/xmldom');

/**
 * DOCX metadata structure
 */
export interface DocxMetadata {
    /** Document title from core properties */
    title?: string;
    /** Document author */
    author?: string;
    /** Document creator */
    creator?: string;
    /** Document subject */
    subject?: string;
    /** Document description */
    description?: string;
    /** Creation date */
    creationDate?: Date;
    /** Last modification date */
    modificationDate?: Date;
    /** Last modified by */
    lastModifiedBy?: string;
    /** Document revision number */
    revision?: string;
    /** File size in bytes */
    fileSize?: number;
}

/**
 * Embedded image information
 */
export interface DocxImage {
    /** Unique identifier for the image */
    id: string;
    /** Base64-encoded image data */
    data: string;
    /** MIME type (e.g., "image/png", "image/jpeg") */
    mimeType: string;
    /** Alt text if available */
    altText?: string;
    /** Original size in bytes */
    originalSize?: number;
}

/**
 * DOCX section/paragraph structure
 */
export interface DocxSection {
    /** Section type: heading, paragraph, list, table */
    type: 'heading' | 'paragraph' | 'list' | 'table' | 'image';
    /** Section content as markdown */
    content: string;
    /** Heading level if type is heading */
    level?: number;
    /** Associated images if any */
    images?: DocxImage[];
}

/**
 * Complete DOCX parse result
 */
export interface DocxParseResult {
    /** Document content as markdown */
    markdown: string;
    /** Document metadata */
    metadata: DocxMetadata;
    /** Extracted images */
    images: DocxImage[];
    /** Structured sections (optional, for advanced parsing) */
    sections?: DocxSection[];
}

/**
 * Check if source is a URL
 */
const isUrl = (source: string): boolean =>
    source.startsWith('http://') || source.startsWith('https://');

/**
 * Load DOCX file as buffer
 */
async function loadDocxToBuffer(source: string): Promise<Buffer> {
    if (isUrl(source)) {
        const response = await fetch(source);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } else {
        return await fs.readFile(source);
    }
}

function readZipFileText(zip: any, filePath: string): string | null {
    const file = zip.file(filePath);
    if (!file) return null;
    if (typeof file.asText === 'function') {
        return file.asText();
    }
    if (typeof file.asBinary === 'function') {
        return Buffer.from(file.asBinary(), 'binary').toString('utf8');
    }
    return null;
}

function readZipFileBuffer(zip: any, filePath: string): Buffer | null {
    const file = zip.file(filePath);
    if (!file) return null;
    if (typeof file.asUint8Array === 'function') {
        return Buffer.from(file.asUint8Array());
    }
    if (typeof file.asNodeBuffer === 'function') {
        return file.asNodeBuffer();
    }
    if (typeof file.asBinary === 'function') {
        return Buffer.from(file.asBinary(), 'binary');
    }
    return null;
}

function getMimeTypeForTarget(target: string): string {
    const ext = path.extname(target).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

function escapeTableCell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function getElementChildren(node: Node): Element[] {
    const children: Element[] = [];
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
            children.push(child as Element);
        }
    }
    return children;
}

function getAttributeValue(node: Element, name: string): string | null {
    return node.getAttribute(name) || node.getAttribute(`w:${name}`) || null;
}

function getHeadingLevelFromParagraph(paragraph: Element): number | null {
    const pPr = paragraph.getElementsByTagName('w:pPr')[0];
    if (!pPr) return null;
    const pStyle = pPr.getElementsByTagName('w:pStyle')[0];
    if (!pStyle) return null;
    const styleVal = getAttributeValue(pStyle, 'val');
    if (!styleVal) return null;
    const match = styleVal.match(/heading\s*([1-6])/i);
    if (!match) return null;
    return Number(match[1]);
}

function extractRelationshipMap(relsXml: string | null): Map<string, { target: string; type: string }> {
    const relMap = new Map<string, { target: string; type: string }>();
    if (!relsXml) return relMap;
    const relDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
    const rels = relDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
        const rel = rels[i];
        const id = rel.getAttribute('Id');
        const type = rel.getAttribute('Type') || '';
        const target = rel.getAttribute('Target') || '';
        if (id && target) {
            relMap.set(id, { target, type });
        }
    }
    return relMap;
}

function buildImageResolver(
    zip: any,
    relMap: Map<string, { target: string; type: string }>,
    images: DocxImage[],
    includeImages: boolean
): (relId: string | null) => string {
    const cache = new Map<string, DocxImage>();
    return (relId: string | null) => {
        if (!includeImages || !relId) return '';
        const rel = relMap.get(relId);
        if (!rel || !rel.type.includes('/image')) return '';
        if (cache.has(relId)) {
            const cached = cache.get(relId)!;
            return `![image](data:${cached.mimeType};base64,${cached.data})`;
        }
        const targetPath = rel.target.startsWith('word/')
            ? rel.target
            : `word/${rel.target.replace(/^\/?/, '')}`;
        const buffer = readZipFileBuffer(zip, targetPath);
        if (!buffer) return '';
        const mimeType = getMimeTypeForTarget(rel.target);
        const base64 = buffer.toString('base64');
        const image: DocxImage = {
            id: relId,
            data: base64,
            mimeType,
            originalSize: buffer.length,
        };
        images.push(image);
        cache.set(relId, image);
        return `![image](data:${mimeType};base64,${base64})`;
    };
}

function extractTextFromRun(run: Element, resolveImage: (relId: string | null) => string): string {
    let text = '';
    const children = getElementChildren(run);
    for (const child of children) {
        const nodeName = child.nodeName;
        if (nodeName === 'w:t') {
            text += child.textContent || '';
            continue;
        }
        if (nodeName === 'w:tab') {
            text += '\t';
            continue;
        }
        if (nodeName === 'w:br') {
            text += '\n';
            continue;
        }
        if (nodeName === 'w:drawing' || nodeName === 'w:pict') {
            const blips = child.getElementsByTagName('a:blip');
            for (let i = 0; i < blips.length; i++) {
                const blip = blips[i];
                const relId = blip.getAttribute('r:embed') || blip.getAttribute('embed');
                const imageMarkdown = resolveImage(relId);
                if (imageMarkdown) {
                    text += imageMarkdown;
                }
            }
        }
    }
    return text;
}

function extractParagraphText(paragraph: Element, resolveImage: (relId: string | null) => string): string {
    let text = '';
    const children = getElementChildren(paragraph);
    for (const child of children) {
        const nodeName = child.nodeName;
        if (nodeName === 'w:r') {
            text += extractTextFromRun(child, resolveImage);
            continue;
        }
        if (nodeName === 'w:hyperlink') {
            const runs = child.getElementsByTagName('w:r');
            for (let i = 0; i < runs.length; i++) {
                text += extractTextFromRun(runs[i], resolveImage);
            }
            continue;
        }
    }
    return text;
}

function convertTableToMarkdown(table: Element, resolveImage: (relId: string | null) => string): string | null {
    const rows: string[][] = [];
    const rowNodes = table.getElementsByTagName('w:tr');
    for (let i = 0; i < rowNodes.length; i++) {
        const row = rowNodes[i];
        const cells = row.getElementsByTagName('w:tc');
        const rowCells: string[] = [];
        for (let j = 0; j < cells.length; j++) {
            const cell = cells[j];
            const paragraphs = cell.getElementsByTagName('w:p');
            const cellTexts: string[] = [];
            for (let k = 0; k < paragraphs.length; k++) {
                const text = extractParagraphText(paragraphs[k], resolveImage).trim();
                if (text) {
                    cellTexts.push(text);
                }
            }
            const combined = cellTexts.length > 0 ? cellTexts.join('<br>') : ' ';
            rowCells.push(escapeTableCell(combined));
        }
        if (rowCells.length > 0) {
            rows.push(rowCells);
        }
    }

    if (rows.length === 0) return null;
    const maxCols = Math.max(...rows.map(row => row.length));
    for (const row of rows) {
        while (row.length < maxCols) {
            row.push(' ');
        }
    }

    const header = rows[0];
    const bodyRows = rows.slice(1);
    const headerLine = `| ${header.join(' | ')} |`;
    const separatorLine = `| ${header.map(() => '---').join(' | ')} |`;
    const dataLines = bodyRows.map(row => `| ${row.join(' | ')} |`);
    return [headerLine, separatorLine, ...dataLines].join('\n');
}

function convertBodyToMarkdown(
    body: Element,
    resolveImage: (relId: string | null) => string
): string {
    const blocks: string[] = [];
    const children = getElementChildren(body);

    for (const child of children) {
        const nodeName = child.nodeName;
        if (nodeName === 'w:p') {
            const text = extractParagraphText(child, resolveImage).trim();
            if (!text) continue;
            const headingLevel = getHeadingLevelFromParagraph(child);
            if (headingLevel && headingLevel >= 1 && headingLevel <= 6) {
                blocks.push(`${'#'.repeat(headingLevel)} ${text}`);
            } else {
                blocks.push(text);
            }
            continue;
        }
        if (nodeName === 'w:tbl') {
            const tableMarkdown = convertTableToMarkdown(child, resolveImage);
            if (tableMarkdown) {
                blocks.push(tableMarkdown);
            }
            continue;
        }
    }

    return blocks.join('\n\n');
}

/**
 * Convert DOCX to Markdown using Docxtemplater + XML parsing
 * @param source Path to DOCX file or URL
 * @param options Conversion options
 * @returns Parsed DOCX result with markdown and metadata
 */
export async function parseDocxToMarkdown(
    source: string,
    options: {
        /** Extract images as base64 */
        includeImages?: boolean;
        /** Preserve inline formatting (bold, italic) */
        preserveFormatting?: boolean;
        /** Custom style mapping */
        styleMap?: string[];
    } = {}
): Promise<DocxParseResult> {
    const {
        includeImages = true,
        preserveFormatting = true,
        styleMap = []
    } = options;

    try {
        // Load DOCX file
        const buffer = await loadDocxToBuffer(source);

        // Get file size (for local files)
        let fileSize: number | undefined;
        if (!isUrl(source)) {
            try {
                const stats = await fs.stat(source);
                fileSize = stats.size;
            } catch {
                // Ignore stat errors for URLs
            }
        }

        const zip = new PizZip(buffer);
        try {
            new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
        } catch (error) {
            console.warn('Docxtemplater validation failed, continuing with raw XML parsing:', error);
        }

        const documentXml = readZipFileText(zip, 'word/document.xml');
        if (!documentXml) {
            throw new Error('Invalid DOCX file: word/document.xml not found');
        }

        const relsXml = readZipFileText(zip, 'word/_rels/document.xml.rels');
        const relMap = extractRelationshipMap(relsXml);
        const images: DocxImage[] = [];
        const resolveImage = buildImageResolver(zip, relMap, images, includeImages);

        const doc = new DOMParser().parseFromString(documentXml, 'application/xml');
        const body = doc.getElementsByTagName('w:body')[0];
        if (!body) {
            throw new Error('Invalid DOCX file: <w:body> not found');
        }

        let markdown = convertBodyToMarkdown(body, resolveImage);

        // Extract metadata from DOCX
        const metadata = await extractMetadata(source, buffer, fileSize);

        // Post-process markdown for better formatting
        markdown = postProcessMarkdown(markdown);

        // Parse into sections (optional advanced feature)
        const sections = parseIntoSections(markdown, images);

        return {
            markdown,
            metadata,
            images,
            sections
        };
    } catch (error) {
        console.error('Error converting DOCX to Markdown:', error);
        throw new Error(
            `Failed to parse DOCX file: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Extract metadata from DOCX file
 */
async function extractMetadata(
    source: string,
    buffer: Buffer,
    fileSize?: number
): Promise<DocxMetadata> {
    try {
        // Core properties aren't exposed by the parser, so we'll use JSZip directly
        // For now, return basic metadata structure
        // TODO: Could enhance with docx-parser or officegen for full metadata
        
        const metadata: DocxMetadata = {
            fileSize
        };

        // Try to extract basic metadata if available
        // This is a simplified version - full implementation would use docx package
        try {
            // Attempt to read core properties using JSZip (DOCX is a ZIP file)
            const JSZip = require('jszip');
            const zip = await JSZip.loadAsync(buffer);
            
            // Read core properties XML
            const corePropsFile = zip.file('docProps/core.xml');
            if (corePropsFile) {
                const corePropsXml = await corePropsFile.async('string');
                
                // Basic XML parsing (ideally use proper XML parser)
                const extractTag = (xml: string, tag: string): string | undefined => {
                    const regex = new RegExp(`<dc:${tag}[^>]*>([^<]*)<\/dc:${tag}>`, 'i');
                    const match = xml.match(regex);
                    if (match) return match[1];
                    
                    // Try cp: namespace
                    const regex2 = new RegExp(`<cp:${tag}[^>]*>([^<]*)<\/cp:${tag}>`, 'i');
                    const match2 = xml.match(regex2);
                    return match2 ? match2[1] : undefined;
                };

                const extractDcmiTerms = (xml: string, tag: string): Date | undefined => {
                    const regex = new RegExp(`<dcterms:${tag}[^>]*>([^<]*)<\/dcterms:${tag}>`, 'i');
                    const match = xml.match(regex);
                    if (match) {
                        try {
                            return new Date(match[1]);
                        } catch {
                            return undefined;
                        }
                    }
                    return undefined;
                };

                metadata.title = extractTag(corePropsXml, 'title');
                metadata.author = extractTag(corePropsXml, 'creator');
                metadata.subject = extractTag(corePropsXml, 'subject');
                metadata.description = extractTag(corePropsXml, 'description');
                metadata.lastModifiedBy = extractTag(corePropsXml, 'lastModifiedBy');
                metadata.revision = extractTag(corePropsXml, 'revision');
                metadata.creationDate = extractDcmiTerms(corePropsXml, 'created');
                metadata.modificationDate = extractDcmiTerms(corePropsXml, 'modified');
            }
        } catch (metaError) {
            // Metadata extraction is optional, don't fail if it doesn't work
            console.warn('Could not extract detailed metadata:', metaError);
        }

        return metadata;
    } catch (error) {
        // Return minimal metadata on error
        return { fileSize };
    }
}

/**
 * Post-process markdown for better formatting
 */
function postProcessMarkdown(markdown: string): string {
    // Clean up excessive newlines
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    
    // Ensure proper spacing around headings
    markdown = markdown.replace(/([^\n])\n(#+\s)/g, '$1\n\n$2');
    markdown = markdown.replace(/(#+\s[^\n]+)\n([^\n])/g, '$1\n\n$2');
    
    // Clean up list formatting
    markdown = markdown.replace(/\n([*-]\s)/g, '\n$1');
    
    // Ensure proper spacing around code blocks
    markdown = markdown.replace(/([^\n])\n```/g, '$1\n\n```');
    markdown = markdown.replace(/```\n([^\n])/g, '```\n\n$1');
    
    // Ensure proper spacing around tables
    markdown = markdown.replace(/([^\n])\n(\|[^\n]+\|)/g, '$1\n\n$2');
    markdown = markdown.replace(/(\|[^\n]+\|)\n([^\n|])/g, '$1\n\n$2');
    
    // Trim leading/trailing whitespace
    markdown = markdown.trim();
    
    return markdown;
}

/**
 * Parse markdown into structured sections
 */
function parseIntoSections(markdown: string, images: DocxImage[]): DocxSection[] {
    const sections: DocxSection[] = [];
    const lines = markdown.split('\n');
    
    let currentSection: DocxSection | null = null;
    let currentContent: string[] = [];
    
    for (const line of lines) {
        // Detect headings
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            // Save previous section
            if (currentSection) {
                currentSection.content = currentContent.join('\n').trim();
                sections.push(currentSection);
            }
            
            // Start new heading section
            currentSection = {
                type: 'heading',
                level: headingMatch[1].length,
                content: '' // Will be set later
            };
            currentContent = [line];
            continue;
        }
        
        // Detect images
        const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (imageMatch) {
            // Save previous section
            if (currentSection && currentContent.length > 0) {
                currentSection.content = currentContent.join('\n').trim();
                sections.push(currentSection);
            }
            
            // Create image section
            sections.push({
                type: 'image',
                content: line
            });
            
            currentSection = null;
            currentContent = [];
            continue;
        }
        
        // Detect lists
        if (line.match(/^[*\-+]\s/) || line.match(/^\d+\.\s/)) {
            if (!currentSection || currentSection.type !== 'list') {
                // Save previous section
                if (currentSection && currentContent.length > 0) {
                    currentSection.content = currentContent.join('\n').trim();
                    sections.push(currentSection);
                }
                
                // Start new list section
                currentSection = {
                    type: 'list',
                    content: ''
                };
                currentContent = [];
            }
            currentContent.push(line);
            continue;
        }
        
        // Regular paragraph content
        if (line.trim()) {
            if (!currentSection || (currentSection.type !== 'paragraph' && currentSection.type !== 'heading')) {
                // Save previous section
                if (currentSection && currentContent.length > 0) {
                    currentSection.content = currentContent.join('\n').trim();
                    sections.push(currentSection);
                }
                
                // Start new paragraph section
                currentSection = {
                    type: 'paragraph',
                    content: ''
                };
                currentContent = [];
            }
            currentContent.push(line);
        } else if (currentContent.length > 0) {
            // Empty line - finalize current section
            if (currentSection) {
                currentSection.content = currentContent.join('\n').trim();
                sections.push(currentSection);
            }
            currentSection = null;
            currentContent = [];
        }
    }
    
    // Save final section
    if (currentSection && currentContent.length > 0) {
        currentSection.content = currentContent.join('\n').trim();
        sections.push(currentSection);
    }
    
    return sections;
}

