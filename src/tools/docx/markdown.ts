/**
 * DOCX to Markdown Conversion
 * Uses mammoth.js for reading and converting Word documents
 */

import fs from 'fs/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');

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

/**
 * Convert DOCX to Markdown using mammoth.js
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

        // Configure mammoth options
        const mammothOptions: any = {
            convertImage: includeImages
                ? mammoth.images.imgElement(async (image: any) => {
                    // Extract image as base64
                    const imageBuffer = await image.read();
                    const base64 = imageBuffer.toString('base64');
                    const contentType = image.contentType || 'image/png';
                    
                    // Return data URI for inline embedding
                    return {
                        src: `data:${contentType};base64,${base64}`,
                        altText: image.altText || ''
                    };
                })
                : mammoth.images.imgElement(() => ({ src: '' })),
            
            // Style mappings for better markdown conversion
            styleMap: [
                // Default mappings for common styles
                "p[style-name='Heading 1'] => h1:fresh",
                "p[style-name='Heading 2'] => h2:fresh",
                "p[style-name='Heading 3'] => h3:fresh",
                "p[style-name='Heading 4'] => h4:fresh",
                "p[style-name='Heading 5'] => h5:fresh",
                "p[style-name='Heading 6'] => h6:fresh",
                "p[style-name='Title'] => h1:fresh",
                "p[style-name='Subtitle'] => h2:fresh",
                "p[style-name='Quote'] => blockquote:fresh",
                "p[style-name='Intense Quote'] => blockquote:fresh",
                "r[style-name='Strong'] => strong",
                "r[style-name='Emphasis'] => em",
                ...styleMap
            ]
        };

        // Convert to HTML first (mammoth's primary output)
        const htmlResult = await mammoth.convertToHtml({ buffer }, mammothOptions);
        
        // Convert to Markdown (better structured format)
        const markdownResult = await mammoth.convertToMarkdown({ buffer }, mammothOptions);
        
        // Extract images separately for structured access
        const images: DocxImage[] = [];
        if (includeImages) {
            const imageExtractor = await mammoth.extractRawText({ buffer });
            
            // Use mammoth's image extraction
            const docxImages = await mammoth.images.inline(async (element: any) => {
                try {
                    const imageBuffer = await element.read();
                    const base64 = imageBuffer.toString('base64');
                    const contentType = element.contentType || 'image/png';
                    
                    images.push({
                        id: element.imageId || `img_${images.length}`,
                        data: base64,
                        mimeType: contentType,
                        altText: element.altText,
                        originalSize: imageBuffer.length
                    });
                    
                    return { src: '' }; // We're just extracting, not converting
                } catch (error) {
                    console.warn('Failed to extract image:', error);
                    return { src: '' };
                }
            });
            
            // Extract images by converting with custom image handler
            await mammoth.convertToHtml({ buffer }, {
                convertImage: imageExtractor
            });
        }

        // Extract metadata from DOCX
        const metadata = await extractMetadata(source, buffer, fileSize);

        // Get the markdown content
        let markdown = markdownResult.value;
        
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
        // Mammoth doesn't directly expose core properties, so we'll use docx package
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

