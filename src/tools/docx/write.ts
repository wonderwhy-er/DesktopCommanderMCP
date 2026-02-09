/**
 * DOCX writing and modification utilities
 * Modifies DOCX files while preserving formatting and styles
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { DocxModification } from './types.js';
import { nodeListToArray, getTextFromParagraph, setParagraphTextMinimal, styleParagraphRuns, colorParagraphRuns } from './utils.js';

/**
 * Load DOCX file and return ZIP archive
 */
async function loadDocx(path: string): Promise<PizZip> {
    const inputBuf = await fs.readFile(path);
    return new PizZip(inputBuf);
}

/**
 * Get all paragraph elements from body in document order
 */
function getParagraphs(body: Element): Element[] {
    const paragraphs: Element[] = [];
    for (const child of nodeListToArray(body.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:p') {
            paragraphs.push(child as Element);
        }
    }
    return paragraphs;
}

/**
 * Modify DOCX content with specified operations
 * Preserves all other files and components in the DOCX
 */
export async function modifyDocxContent(
    inputPath: string,
    outputPath: string,
    modifications: DocxModification[]
): Promise<void> {
    const inputBuf = await fs.readFile(inputPath);
    const zip = new PizZip(inputBuf);

    // Preserve ALL files in the ZIP - we'll only modify word/document.xml
    const docFile = zip.file('word/document.xml');
    if (!docFile) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }

    const xmlStr = docFile.asText();
    const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');

    // Locate body
    const body = dom.getElementsByTagName('w:body').item(0);
    if (!body) {
        throw new Error('Invalid DOCX: missing w:body');
    }

    // Apply modifications in order
    // Follow the reference pattern: iterate DIRECT children of body in order
    for (const mod of modifications) {
        switch (mod.type) {
            case 'replace': {
                // Iterate DIRECT children of body in order; only touch the matching paragraph
                // Follows exact same pattern as reference implementation
                if (mod.findText !== undefined) {
                    const findTextTrimmed = mod.findText.trim();
                    for (const child of nodeListToArray(body.childNodes)) {
                        if (child.nodeType !== 1) continue; // element nodes only
                        if ((child as Element).nodeName !== 'w:p') continue;

                        const txt = getTextFromParagraph(child as Element).trim();
                        if (txt === findTextTrimmed) {
                            // Only modify text if replaceText is provided
                            if (mod.replaceText !== undefined) {
                                setParagraphTextMinimal(child as Element, mod.replaceText);
                            }
                            // Apply style if provided (preserves existing styles, only adds/modifies specified)
                            if (mod.style) {
                                if (mod.style.color) {
                                    colorParagraphRuns(child as Element, mod.style.color);
                                }
                                if (mod.style.bold !== undefined || mod.style.italic !== undefined) {
                                    styleParagraphRuns(child as Element, mod.style);
                                }
                            }
                            break; // Only replace first match
                        }
                    }
                }
                break;
            }

            case 'insert': {
                if (mod.paragraphIndex !== undefined && mod.insertText !== undefined) {
                    const doc = body.ownerDocument;
                    if (!doc) break;

                    // Create new paragraph with minimal structure
                    const newP = doc.createElement('w:p');
                    const newR = doc.createElement('w:r');
                    const newT = doc.createElement('w:t');
                    newT.textContent = mod.insertText;
                    newR.appendChild(newT);
                    newP.appendChild(newR);

                    // Re-collect paragraphs to get current count
                    const paragraphs = getParagraphs(body);
                    const insertIndex = mod.paragraphIndex < 0
                        ? paragraphs.length + mod.paragraphIndex + 1
                        : mod.paragraphIndex;

                    // Insert at correct position by iterating DIRECT children
                    if (insertIndex >= 0 && insertIndex <= paragraphs.length) {
                        if (insertIndex === paragraphs.length) {
                            // Append to end
                            body.appendChild(newP);
                        } else if (insertIndex < paragraphs.length) {
                            // Find the paragraph at insertIndex by iterating DIRECT children
                            let currentIndex = 0;
                            for (const child of nodeListToArray(body.childNodes)) {
                                if (child.nodeType !== 1) continue;
                                if ((child as Element).nodeName !== 'w:p') continue;
                                
                                if (currentIndex === insertIndex) {
                                    body.insertBefore(newP, child);
                                    break;
                                }
                                currentIndex++;
                            }
                        }
                    }
                }
                break;
            }

            case 'delete': {
                if (mod.paragraphIndex !== undefined) {
                    // Re-collect paragraphs to get current count
                    const paragraphs = getParagraphs(body);
                    const deleteIndex = mod.paragraphIndex < 0
                        ? paragraphs.length + mod.paragraphIndex
                        : mod.paragraphIndex;

                    // Find and delete by iterating DIRECT children
                    if (deleteIndex >= 0 && deleteIndex < paragraphs.length) {
                        let currentIndex = 0;
                        for (const child of nodeListToArray(body.childNodes)) {
                            if (child.nodeType !== 1) continue;
                            if ((child as Element).nodeName !== 'w:p') continue;
                            
                            if (currentIndex === deleteIndex) {
                                body.removeChild(child);
                                break;
                            }
                            currentIndex++;
                        }
                    }
                }
                break;
            }

            case 'style': {
                if (mod.paragraphIndex !== undefined && mod.style) {
                    // Re-collect paragraphs to get current count
                    const paragraphs = getParagraphs(body);
                    const styleIndex = mod.paragraphIndex < 0
                        ? paragraphs.length + mod.paragraphIndex
                        : mod.paragraphIndex;

                    // Find paragraph by iterating DIRECT children
                    if (styleIndex >= 0 && styleIndex < paragraphs.length) {
                        let currentIndex = 0;
                        for (const child of nodeListToArray(body.childNodes)) {
                            if (child.nodeType !== 1) continue;
                            if ((child as Element).nodeName !== 'w:p') continue;
                            
                            if (currentIndex === styleIndex) {
                                // Apply style to existing paragraph (preserves other styles)
                                if (mod.style.color) {
                                    colorParagraphRuns(child as Element, mod.style.color);
                                }
                                if (mod.style.bold !== undefined || mod.style.italic !== undefined) {
                                    styleParagraphRuns(child as Element, mod.style);
                                }
                                break;
                            }
                            currentIndex++;
                        }
                    }
                }
                break;
            }
        }
    }

    // Serialize the modified document.xml
    const outXml = new XMLSerializer().serializeToString(dom);
    
    // Update ONLY word/document.xml in the ZIP
    // All other files (styles, images, relationships, etc.) are preserved automatically
    zip.file('word/document.xml', outXml);

    // Generate the output ZIP with all original files preserved
    // Use same generation method as reference implementation
    const outBuf = zip.generate({ type: 'nodebuffer' });
    
    await fs.writeFile(outputPath, outBuf);
}

/**
 * Replace body XML in existing DOCX file
 * This function copies the DOCX to a temp location, extracts document.xml to temp,
 * updates the body, generates the DOCX, and cleans up
 * This approach avoids "max compaction per block" errors
 */
export async function replaceBodyXml(
    inputPath: string,
    outputPath: string,
    newBodyXml: string
): Promise<void> {
    // Create temp file paths
    const tempDir = os.tmpdir();
    const tempDocxName = `docx_temp_${Date.now()}_${Math.random().toString(36).substring(7)}.docx`;
    const tempDocxPath = path.join(tempDir, tempDocxName);
    const tempXmlName = `docx_dom_${Date.now()}_${Math.random().toString(36).substring(7)}.xml`;
    const tempXmlPath = path.join(tempDir, tempXmlName);

    try {
        // Step 1: Copy DOCX to temp location
        const inputBuf = await fs.readFile(inputPath);
        await fs.writeFile(tempDocxPath, inputBuf);

        // Step 2: Load temp DOCX
        const zip = new PizZip(inputBuf);

        // Step 3: Extract document.xml to temp file
        const docFile = zip.file('word/document.xml');
        if (!docFile) {
            throw new Error('Invalid DOCX: missing word/document.xml');
        }

        const xmlStr = docFile.asText();
        await fs.writeFile(tempXmlPath, xmlStr);

        // Step 4: Parse the temp XML file
        const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');

        // Step 5: Locate body and replace with new body XML
        const body = dom.getElementsByTagName('w:body').item(0);
        if (!body) {
            throw new Error('Invalid DOCX: missing w:body');
        }

        // Parse the new body XML
        const newBodyDom = new DOMParser().parseFromString(
            `<root>${newBodyXml}</root>`,
            'application/xml'
        );
        const newBodyElement = newBodyDom.documentElement.firstChild as Element;
        
        if (!newBodyElement || newBodyElement.nodeName !== 'w:body') {
            throw new Error('Invalid body XML: must start with <w:body>');
        }

        // Replace the body: clear existing children and append new ones
        // We need to import the new body's children into the original document
        const doc = body.ownerDocument;
        if (!doc) {
            throw new Error('Document owner not found');
        }

        // Remove all existing children from body
        while (body.firstChild) {
            body.removeChild(body.firstChild);
        }

        // Import and append all children from new body
        for (const child of nodeListToArray(newBodyElement.childNodes)) {
            const importedChild = doc.importNode(child, true);
            body.appendChild(importedChild);
        }

        // Step 6: Serialize the updated DOM
        const outXml = new XMLSerializer().serializeToString(dom);
        
        // Step 7: Update document.xml in ZIP and generate output
        zip.file('word/document.xml', outXml);
        const outBuf = zip.generate({ type: 'nodebuffer' });
        await fs.writeFile(outputPath, outBuf);
    } finally {
        // Step 8: Clean up temp files
        try {
            await fs.unlink(tempDocxPath);
        } catch {
            // Ignore errors when cleaning up temp DOCX file
        }
        try {
            await fs.unlink(tempXmlPath);
        } catch {
            // Ignore errors when cleaning up temp XML file
        }
    }
}

/**
 * Create a new DOCX file from text content
 * Note: This creates a minimal DOCX structure
 */
export async function writeDocx(
    outputPath: string,
    content: string | DocxModification[]
): Promise<void> {
    if (typeof content === 'string') {
        // Create minimal DOCX from text
        const zip = new PizZip();
        
        // Create minimal document.xml
        const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${content.split('\n\n').map(para => {
            const escaped = para
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
            return `    <w:p>
      <w:r>
        <w:t>${escaped}</w:t>
      </w:r>
    </w:p>`;
        }).join('\n')}
  </w:body>
</w:document>`;

        zip.file('word/document.xml', docXml);
        
        // Create minimal [Content_Types].xml
        const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
        zip.file('[Content_Types].xml', contentTypes);

        // Create minimal _rels/.rels
        const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
        zip.folder('_rels')?.file('.rels', rels);

        // Create minimal word/_rels/document.xml.rels
        zip.folder('word')?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

        const outBuf = zip.generate({ type: 'nodebuffer' });
        await fs.writeFile(outputPath, outBuf);
    } else {
        // Modifications require an existing file
        throw new Error('Modifications require an existing DOCX file. Use modifyDocxContent() instead.');
    }
}
