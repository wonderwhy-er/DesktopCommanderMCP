/**
 * Image builder — creates w:drawing elements and manages image relationships.
 */

import fs from 'fs/promises';
import path from 'path';
import PizZip from 'pizzip';
import { DOMParser } from '@xmldom/xmldom';
import type { DocxContentImage, InsertImageOp } from '../types.js';
import { addImageRelationship, ensureContentType } from '../relationships.js';
import { escapeXmlAttr } from './utils.js';
import { pixelsToEmu, DEFAULT_IMAGE_WIDTH, DEFAULT_IMAGE_HEIGHT, NAMESPACES } from '../constants.js';

/**
 * Build an image element and add it to the ZIP archive.
 *
 * @param doc The XML document
 * @param zip The DOCX ZIP archive
 * @param spec The image specification (from content or operation)
 * @returns A w:p element containing the image drawing
 */
export async function buildImageElement(
    doc: Document,
    zip: PizZip,
    spec: DocxContentImage | InsertImageOp,
): Promise<Element> {
    // Validate image exists
    try {
        await fs.access(spec.imagePath);
    } catch {
        throw new Error(`Image file not found: ${spec.imagePath}`);
    }

    // Read image
    const imgBuffer = await fs.readFile(spec.imagePath);
    const ext = path.extname(spec.imagePath).toLowerCase();
    const baseName = path.basename(spec.imagePath);

    // Find next available media filename
    let mediaIndex = 1;
    while (zip.file(`word/media/image${mediaIndex}${ext}`)) {
        mediaIndex++;
    }
    const mediaFileName = `image${mediaIndex}${ext}`;

    // Add image to ZIP
    zip.file(`word/media/${mediaFileName}`, imgBuffer);

    // Add relationship
    const rId = addImageRelationship(zip, mediaFileName);

    // Ensure Content_Types entry
    ensureContentType(zip, ext);

    // Compute dimensions (EMU)
    const widthPx = spec.width ?? DEFAULT_IMAGE_WIDTH;
    const heightPx = spec.height ?? DEFAULT_IMAGE_HEIGHT;
    const widthEmu = pixelsToEmu(widthPx);
    const heightEmu = pixelsToEmu(heightPx);

    // Build drawing XML
    const altText = spec.altText ?? baseName;
    const drawingXmlStr = buildDrawingXml(rId, widthEmu, heightEmu, altText, mediaFileName);

    // Parse drawing XML into a paragraph
    const drawingFragment = new DOMParser().parseFromString(
        `<w:p xmlns:w="${NAMESPACES.W}">` +
        `<w:r>${drawingXmlStr}</w:r></w:p>`,
        'application/xml',
    );

    return doc.importNode(drawingFragment.documentElement, true) as Element;
}

/**
 * Build the inline w:drawing XML for an image reference.
 */
function buildDrawingXml(
    rId: string,
    widthEmu: number,
    heightEmu: number,
    altText: string,
    fileName: string,
): string {
    return (
        `<w:drawing xmlns:w="${NAMESPACES.W}">` +
        `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
        `xmlns:wp="${NAMESPACES.WP}">` +
        `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
        `<wp:docPr id="1" name="${fileName}" descr="${escapeXmlAttr(altText)}"/>` +
        `<a:graphic xmlns:a="${NAMESPACES.A}">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="${NAMESPACES.PIC}">` +
        `<pic:nvPicPr>` +
        `<pic:cNvPr id="0" name="${fileName}" descr="${escapeXmlAttr(altText)}"/>` +
        `<pic:cNvPicPr/>` +
        `</pic:nvPicPr>` +
        `<pic:blipFill>` +
        `<a:blip r:embed="${rId}" xmlns:r="${NAMESPACES.R}"/>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</pic:blipFill>` +
        `<pic:spPr>` +
        `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `</pic:spPr>` +
        `</pic:pic>` +
        `</a:graphicData>` +
        `</a:graphic>` +
        `</wp:inline>` +
        `</w:drawing>`
    );
}

