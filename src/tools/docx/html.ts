/**
 * DOCX to HTML Conversion using Mammoth
 * Uses mammoth library for reading Word documents and converting to HTML
 */

import fs from 'fs/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
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
    /** Section type: heading, paragraph, list, table, image */
    type: 'heading' | 'paragraph' | 'list' | 'table' | 'image';
    /** Section content as HTML */
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
    /** Document content as HTML */
    html: string;
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

/**
 * Convert DOCX to HTML using Mammoth
 * @param source Path to DOCX file or URL
 * @param options Conversion options
 * @returns Parsed DOCX result with HTML and metadata
 */
export async function parseDocxToHtml(
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

        // Use mammoth to convert DOCX to HTML
        const mammothOptions: any = {
            convertImage: includeImages ? mammoth.images.imgElement((image: any) => {
                return image.read('base64').then((imageBuffer: Buffer) => {
                    const base64 = imageBuffer.toString('base64');
                    return {
                        src: `data:${image.contentType};base64,${base64}`
                    };
                });
            }) : undefined,
            styleMap: styleMap.length > 0 ? styleMap : undefined
        };

        const result = await mammoth.convertToHtml({ buffer }, mammothOptions);

        // Extract HTML content
        let html = result.value;

        // Extract images from HTML (mammoth converts images to data URLs in the HTML)
        const images: DocxImage[] = [];
        try {
            // Parse HTML to extract image data URLs
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const imgElements = doc.getElementsByTagName('img');
            
            for (let i = 0; i < imgElements.length; i++) {
                const img = imgElements[i];
                const src = img.getAttribute('src') || '';
                const alt = img.getAttribute('alt') || '';
                
                // Extract base64 data from data URL
                const dataUrlMatch = src.match(/^data:([^;]+);base64,(.+)$/);
                if (dataUrlMatch) {
                    const mimeType = dataUrlMatch[1];
                    const base64Data = dataUrlMatch[2];
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    
                    images.push({
                        id: `img_${i}`,
                        data: base64Data,
                        mimeType,
                        altText: alt,
                        originalSize: imageBuffer.length
                    });
                }
            }
        } catch (error) {
            // If image extraction fails, continue without images
            console.warn('Failed to extract images from HTML:', error);
        }

        // Extract metadata from DOCX
        const metadata = await extractMetadata(source, buffer, fileSize);

        // Post-process HTML for better formatting
        html = postProcessHtml(html);

        // Parse into sections (optional advanced feature)
        const sections = parseIntoSections(html, images);

        return {
            html,
            metadata,
            images,
            sections
        };
    } catch (error) {
        console.error('Error converting DOCX to HTML:', error);
        throw new Error(
            `Failed to parse DOCX file: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Extract metadata from DOCX file
 * Uses proper XML parsing with DOMParser for better reliability
 */
async function extractMetadata(
    source: string,
    buffer: Buffer,
    fileSize?: number
): Promise<DocxMetadata> {
    try {
        const metadata: DocxMetadata = {
            fileSize
        };

        // Try to extract basic metadata if available
        try {
            // Attempt to read core properties using JSZip (DOCX is a ZIP file)
            const JSZip = require('jszip');
            const zip = await JSZip.loadAsync(buffer);
            
            // Read core properties XML
            const corePropsFile = zip.file('docProps/core.xml');
            if (corePropsFile) {
                const corePropsXml = await corePropsFile.async('string');
                
                // Use DOMParser for proper XML parsing (more reliable than regex)
                const doc = new DOMParser().parseFromString(corePropsXml, 'application/xml');
                
                // Helper to extract text content from elements with namespace handling
                const getTextContent = (tagName: string, namespaces: string[] = ['dc', 'cp']): string | undefined => {
                    for (const ns of namespaces) {
                        const elements = doc.getElementsByTagName(`${ns}:${tagName}`);
                        if (elements.length > 0 && elements[0].textContent) {
                            return elements[0].textContent.trim();
                        }
                    }
                    return undefined;
                };

                // Helper to extract date from dcterms elements
                const getDateContent = (tagName: string): Date | undefined => {
                    const elements = doc.getElementsByTagName(`dcterms:${tagName}`);
                    if (elements.length > 0 && elements[0].textContent) {
                        try {
                            const dateStr = elements[0].textContent.trim();
                            const date = new Date(dateStr);
                            // Validate date
                            if (!isNaN(date.getTime())) {
                                return date;
                            }
                        } catch {
                            // Invalid date format
                        }
                    }
                    return undefined;
                };

                // Extract standard Dublin Core properties
                metadata.title = getTextContent('title');
                metadata.author = getTextContent('creator');
                metadata.subject = getTextContent('subject');
                metadata.description = getTextContent('description');
                
                // Extract custom properties (cp namespace)
                metadata.lastModifiedBy = getTextContent('lastModifiedBy', ['cp']);
                metadata.revision = getTextContent('revision', ['cp']);
                
                // Extract dates from dcterms namespace
                metadata.creationDate = getDateContent('created');
                metadata.modificationDate = getDateContent('modified');
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
 * Post-process HTML for better formatting
 */
function postProcessHtml(html: string): string {
    // Clean up excessive whitespace
    html = html.replace(/\s+/g, ' ');
    
    // Ensure proper spacing around block elements
    html = html.replace(/>\s+</g, '><');
    html = html.replace(/>\s+/g, '>');
    html = html.replace(/\s+</g, '<');
    
    // Trim leading/trailing whitespace
    html = html.trim();
    
    return html;
}

/**
 * Parse HTML into structured sections
 */
function parseIntoSections(html: string, images: DocxImage[]): DocxSection[] {
    const sections: DocxSection[] = [];
    
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const body = doc.getElementsByTagName('body')[0];
        
        if (!body) {
            // If no body tag, treat entire HTML as one section
            sections.push({
                type: 'paragraph',
                content: html
            });
            return sections;
        }

        const children = body.childNodes;
        
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            
            if (child.nodeType === 1) { // Element node
                const element = child as Element;
                const tagName = element.tagName.toLowerCase();
                
                // Detect headings
                if (tagName.match(/^h[1-6]$/)) {
                    const level = parseInt(tagName.substring(1));
                    sections.push({
                        type: 'heading',
                        level,
                        content: element.outerHTML || element.innerHTML
                    });
                    continue;
                }
                
                // Detect images
                if (tagName === 'img') {
                    sections.push({
                        type: 'image',
                        content: element.outerHTML
                    });
                    continue;
                }
                
                // Detect tables
                if (tagName === 'table') {
                    sections.push({
                        type: 'table',
                        content: element.outerHTML
                    });
                    continue;
                }
                
                // Detect lists
                if (tagName === 'ul' || tagName === 'ol') {
                    sections.push({
                        type: 'list',
                        content: element.outerHTML
                    });
                    continue;
                }
                
                // Regular paragraphs
                if (tagName === 'p' || tagName === 'div') {
                    sections.push({
                        type: 'paragraph',
                        content: element.outerHTML
                    });
                    continue;
                }
            }
        }
    } catch (error) {
        // If parsing fails, return entire HTML as one section
        console.warn('Failed to parse HTML into sections:', error);
        sections.push({
            type: 'paragraph',
            content: html
        });
    }
    
    return sections;
}

