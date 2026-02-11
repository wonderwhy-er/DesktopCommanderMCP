/**
 * Op: insert_image
 *
 * Insert an image into the DOCX relative to a paragraph anchor.
 *
 * Supports two positioning modes:
 *   - `after`  — insert immediately AFTER the first paragraph matching text
 *   - `before` — insert immediately BEFORE the first paragraph matching text
 *
 * Exactly one of `after` or `before` must be provided.
 *
 * The image is read from disk, added to word/media/ in the ZIP,
 * and a w:drawing reference is created inside a new paragraph.
 *
 * Requires the PizZip instance because it modifies:
 *   - word/media/imageN.ext  (binary blob)
 *   - word/_rels/document.xml.rels  (relationship entry)
 *   - [Content_Types].xml  (content-type override)
 *
 * This is a structural op — increases bodyChildCount by 1.
 */

import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { getBodyChildren, getParagraphText, nodeListToArray } from '../dom.js';
import type { InsertImageOp, OpResult } from '../types.js';

// ─── MIME / extension helpers ────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

function getMimeType(ext: string): string {
    return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

// ─── EMU conversion (English Metric Units) ──────────────────────────
// 1 inch = 914400 EMU, 1 px ≈ 9525 EMU (at 96 DPI)
const PX_TO_EMU = 9525;

// ─── Relationship helpers ────────────────────────────────────────────

/**
 * Add a relationship to word/_rels/document.xml.rels and return the rId.
 */
function addImageRelationship(zip: PizZip, mediaFileName: string): string {
    const relsPath = 'word/_rels/document.xml.rels';
    let relsEntry = zip.file(relsPath);

    // Create .rels file if it doesn't exist
    if (!relsEntry) {
        const emptyRels =
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
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
    newRel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');
    newRel.setAttribute('Target', `media/${mediaFileName}`);

    relsDom.documentElement.appendChild(newRel);

    // Write back
    const newRelsXml = new XMLSerializer().serializeToString(relsDom);
    zip.file(relsPath, newRelsXml);

    return newRId;
}

/**
 * Ensure the Content_Types.xml has a Default entry for the image extension.
 */
function ensureContentType(zip: PizZip, ext: string): void {
    const ctPath = '[Content_Types].xml';
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

// ─── Drawing XML builder ─────────────────────────────────────────────

function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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
        `<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
        `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
        `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
        `<wp:docPr id="1" name="${fileName}" descr="${escapeXmlAttr(altText)}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr>` +
        `<pic:cNvPr id="0" name="${fileName}" descr="${escapeXmlAttr(altText)}"/>` +
        `<pic:cNvPicPr/>` +
        `</pic:nvPicPr>` +
        `<pic:blipFill>` +
        `<a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
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

// ─── Op implementation ───────────────────────────────────────────────

export function applyInsertImage(
    body: Element,
    op: InsertImageOp,
    zip: PizZip,
): OpResult {
    // ── Validate anchor ─────────────────────────────────────────────
    const anchorText = op.before ?? op.after;
    const position: 'before' | 'after' = op.before ? 'before' : 'after';

    if (!anchorText) {
        return { op, status: 'skipped', matched: 0, reason: 'no_anchor: provide "after" or "before"' };
    }

    // ── Validate image file exists ──────────────────────────────────
    const imgPath = op.imagePath;
    if (!fs.existsSync(imgPath)) {
        return { op, status: 'skipped', matched: 0, reason: `image_not_found: ${imgPath}` };
    }

    // ── Find target paragraph ───────────────────────────────────────
    const children = getBodyChildren(body);
    const target = anchorText.trim();

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeName !== 'w:p') continue;

        if (getParagraphText(child).trim() === target) {
            const doc = body.ownerDocument;
            if (!doc) return { op, status: 'skipped', matched: 0, reason: 'no_owner_document' };

            // ── Read image ──────────────────────────────────────────
            const imgBuffer = fs.readFileSync(imgPath);
            const ext = path.extname(imgPath).toLowerCase();
            const baseName = path.basename(imgPath);

            // ── Find next available media filename ──────────────────
            let mediaIndex = 1;
            while (zip.file(`word/media/image${mediaIndex}${ext}`)) {
                mediaIndex++;
            }
            const mediaFileName = `image${mediaIndex}${ext}`;

            // ── Add image to ZIP ────────────────────────────────────
            zip.file(`word/media/${mediaFileName}`, imgBuffer);

            // ── Add relationship ────────────────────────────────────
            const rId = addImageRelationship(zip, mediaFileName);

            // ── Ensure Content_Types entry ──────────────────────────
            ensureContentType(zip, ext);

            // ── Compute dimensions (EMU) ────────────────────────────
            const widthPx = op.width ?? 300;
            const heightPx = op.height ?? 200;
            const widthEmu = widthPx * PX_TO_EMU;
            const heightEmu = heightPx * PX_TO_EMU;

            // ── Build drawing XML and parse it ──────────────────────
            const drawingXmlStr = buildDrawingXml(
                rId,
                widthEmu,
                heightEmu,
                op.altText ?? baseName,
                mediaFileName,
            );

            // Parse the drawing XML fragment into a w:p element
            const drawingFragment = new DOMParser().parseFromString(
                `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
                `<w:r>${drawingXmlStr}</w:r></w:p>`,
                'application/xml',
            );

            const newP = doc.importNode(drawingFragment.documentElement, true);

            // ── Insert at the correct position ──────────────────────
            if (position === 'before') {
                // Insert BEFORE the matched paragraph
                body.insertBefore(newP, child);
            } else {
                // Insert AFTER the matched paragraph
                const nextSibling = child.nextSibling;
                if (nextSibling) {
                    body.insertBefore(newP, nextSibling);
                } else {
                    body.appendChild(newP);
                }
            }

            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}
