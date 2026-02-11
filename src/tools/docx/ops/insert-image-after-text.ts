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
import { DOMParser } from '@xmldom/xmldom';
import { getBodyChildren, getParagraphText } from '../dom.js';
import { addImageRelationship, ensureContentType } from '../relationships.js';
import { escapeXmlAttr } from '../builders/utils.js';
import { pixelsToEmu, DEFAULT_IMAGE_WIDTH, DEFAULT_IMAGE_HEIGHT, NAMESPACES } from '../constants.js';
import type { InsertImageOp, OpResult } from '../types.js';

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

            // ── Read image (sync) ────────────────────────────────────
            const imgBuffer = fs.readFileSync(imgPath);
            const ext = path.extname(imgPath).toLowerCase();
            const baseName = path.basename(imgPath);

            // ── Find next available media filename ────────────────────
            let mediaIndex = 1;
            while (zip.file(`word/media/image${mediaIndex}${ext}`)) {
                mediaIndex++;
            }
            const mediaFileName = `image${mediaIndex}${ext}`;

            // ── Add image to ZIP ──────────────────────────────────────
            zip.file(`word/media/${mediaFileName}`, imgBuffer);

            // ── Add relationship ─────────────────────────────────────
            const rId = addImageRelationship(zip, mediaFileName);

            // ── Ensure Content_Types entry ───────────────────────────
            ensureContentType(zip, ext);

            // ── Compute dimensions (EMU) ─────────────────────────────
            const widthPx = op.width ?? DEFAULT_IMAGE_WIDTH;
            const heightPx = op.height ?? DEFAULT_IMAGE_HEIGHT;
            const widthEmu = pixelsToEmu(widthPx);
            const heightEmu = pixelsToEmu(heightPx);

            // ── Build drawing XML ────────────────────────────────────
            const altText = op.altText ?? baseName;
            const drawingXmlStr = buildDrawingXml(rId, widthEmu, heightEmu, altText, mediaFileName);

            // ── Parse drawing XML into a paragraph ───────────────────
            const drawingFragment = new DOMParser().parseFromString(
                `<w:p xmlns:w="${NAMESPACES.W}">` +
                `<w:r>${drawingXmlStr}</w:r></w:p>`,
                'application/xml',
            );

            const imgP = doc.importNode(drawingFragment.documentElement, true) as Element;

            // ── Insert at the correct position ──────────────────────
            if (position === 'before') {
                // Insert BEFORE the matched paragraph
                body.insertBefore(imgP, child);
            } else {
                // Insert AFTER the matched paragraph
                const nextSibling = child.nextSibling;
                if (nextSibling) {
                    body.insertBefore(imgP, nextSibling);
                } else {
                    body.appendChild(imgP);
                }
            }

            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

// ─── Drawing XML builder (shared with builders/image.ts) ────────────────

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
