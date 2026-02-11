/**
 * DOCX relationship management — Single Responsibility: manage relationships
 * in word/_rels/document.xml.rels and Content_Types.xml.
 *
 * Used for adding images, hyperlinks, and other external resources.
 */

import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { nodeListToArray } from './dom.js';
import { getMimeType } from './constants.js';
import { DOCX_PATHS, NAMESPACES } from './constants.js';

/**
 * Add an image relationship to word/_rels/document.xml.rels and return the rId.
 *
 * @param zip The DOCX ZIP archive
 * @param mediaFileName The filename in word/media/ (e.g., "image1.png")
 * @returns The relationship ID (e.g., "rId1")
 */
export function addImageRelationship(zip: PizZip, mediaFileName: string): string {
    const relsPath = DOCX_PATHS.DOCUMENT_RELS;
    let relsEntry = zip.file(relsPath);

    // Create .rels file if it doesn't exist
    if (!relsEntry) {
        const emptyRels =
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            `<Relationships xmlns="${NAMESPACES.RELS}"></Relationships>`;
        zip.file(relsPath, emptyRels);
        relsEntry = zip.file(relsPath)!;
    }

    const relsXml = relsEntry.asText();
    const relsDom = new DOMParser().parseFromString(relsXml, 'application/xml');
    const relationships = relsDom.getElementsByTagName('Relationship');

    // Find max existing rId
    let maxId = 0;
    for (const rel of nodeListToArray(relationships)) {
        const id = (rel as Element).getAttribute('Id') || '';
        const match = id.match(/^rId(\d+)$/);
        if (match) {
            maxId = Math.max(maxId, parseInt(match[1], 10));
        }
    }

    const newRId = `rId${maxId + 1}`;

    // Create new Relationship element
    const newRel = relsDom.createElement('Relationship');
    newRel.setAttribute('Id', newRId);
    newRel.setAttribute('Type', `${NAMESPACES.R}/image`);
    newRel.setAttribute('Target', `media/${mediaFileName}`);

    relsDom.documentElement.appendChild(newRel);

    // Write back
    const newRelsXml = new XMLSerializer().serializeToString(relsDom);
    zip.file(relsPath, newRelsXml);

    return newRId;
}

/**
 * Ensure the Content_Types.xml has a Default entry for the given file extension.
 *
 * @param zip The DOCX ZIP archive
 * @param ext The file extension (e.g., ".png")
 */
export function ensureContentType(zip: PizZip, ext: string): void {
    const ctPath = DOCX_PATHS.CONTENT_TYPES;
    const ctEntry = zip.file(ctPath);
    if (!ctEntry) return;

    const ctXml = ctEntry.asText();
    const extNoDot = ext.replace(/^\./, '');

    // Check if already present
    if (ctXml.includes(`Extension="${extNoDot}"`)) return;

    const ctDom = new DOMParser().parseFromString(ctXml, 'application/xml');
    const types = ctDom.documentElement;

    const defaultEl = ctDom.createElement('Default');
    defaultEl.setAttribute('Extension', extNoDot);
    defaultEl.setAttribute('ContentType', getMimeType(ext));
    types.appendChild(defaultEl);

    const newCtXml = new XMLSerializer().serializeToString(ctDom);
    zip.file(ctPath, newCtXml);
}

