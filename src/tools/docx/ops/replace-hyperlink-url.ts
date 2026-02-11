/**
 * Op: replace_hyperlink_url
 *
 * Find all hyperlink relationships in word/_rels/document.xml.rels
 * whose Target matches `oldUrl` and replace with `newUrl`.
 *
 * This op modifies the .rels file inside the ZIP — not document.xml body.
 * It receives the PizZip instance from the orchestrator.
 */

import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { nodeListToArray } from '../dom.js';
import type { ReplaceHyperlinkUrlOp, OpResult } from '../types.js';

export function applyReplaceHyperlinkUrl(
    _body: Element,
    op: ReplaceHyperlinkUrlOp,
    zip: PizZip,
): OpResult {
    const relsPath = 'word/_rels/document.xml.rels';
    const relsEntry = zip.file(relsPath);

    if (!relsEntry) {
        return { op, status: 'skipped', matched: 0, reason: 'no_rels_file' };
    }

    const relsXml = relsEntry.asText();
    const relsDom = new DOMParser().parseFromString(relsXml, 'application/xml');
    const relationships = relsDom.getElementsByTagName('Relationship');
    let matched = 0;

    for (const rel of nodeListToArray(relationships)) {
        const relEl = rel as Element;
        const target = relEl.getAttribute('Target');
        if (target === op.oldUrl) {
            relEl.setAttribute('Target', op.newUrl);
            matched++;
        }
    }

    if (matched === 0) {
        return { op, status: 'skipped', matched: 0, reason: 'url_not_found' };
    }

    // Write modified .rels back to zip
    const newRelsXml = new XMLSerializer().serializeToString(relsDom);
    zip.file(relsPath, newRelsXml);

    return { op, status: 'applied', matched };
}

