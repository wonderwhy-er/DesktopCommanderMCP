/**
 * Op: header_replace_text_exact
 *
 * Find ALL header XML files (word/header1.xml, header2.xml, …)
 * in the ZIP, locate the first paragraph matching exact trimmed text,
 * and replace its text minimally.
 *
 * This op modifies header XML files inside the ZIP — not document.xml body.
 * It receives the PizZip instance from the orchestrator.
 */

import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { nodeListToArray, getParagraphText, setParagraphTextMinimal } from '../dom.js';
import type { HeaderReplaceTextExactOp, OpResult } from '../types.js';

export function applyHeaderReplaceTextExact(
    _body: Element,
    op: HeaderReplaceTextExactOp,
    zip: PizZip,
): OpResult {
    const target = op.from.trim();
    let totalMatched = 0;

    // Iterate over all files in word/ looking for header*.xml
    const files = zip.folder('word');
    if (!files) {
        return { op, status: 'skipped', matched: 0, reason: 'no_word_folder' };
    }

    // PizZip file listing
    const headerPattern = /^word\/header\d+\.xml$/;
    const allFiles = Object.keys(zip.files);
    const headerPaths = allFiles.filter((f) => headerPattern.test(f));

    if (headerPaths.length === 0) {
        return { op, status: 'skipped', matched: 0, reason: 'no_header_files' };
    }

    for (const headerPath of headerPaths) {
        const entry = zip.file(headerPath);
        if (!entry) continue;

        const xmlStr = entry.asText();
        const dom = new DOMParser().parseFromString(xmlStr, 'application/xml');

        // Find all w:p elements in the header
        const paragraphs = dom.getElementsByTagName('w:p');
        let modified = false;

        for (const p of nodeListToArray(paragraphs)) {
            const pEl = p as Element;
            if (getParagraphText(pEl).trim() === target) {
                setParagraphTextMinimal(pEl, op.to);
                totalMatched++;
                modified = true;
                break; // first match per header file
            }
        }

        if (modified) {
            const newXml = new XMLSerializer().serializeToString(dom);
            zip.file(headerPath, newXml);
        }
    }

    if (totalMatched === 0) {
        return { op, status: 'skipped', matched: 0, reason: 'no_match_in_headers' };
    }

    return { op, status: 'applied', matched: totalMatched };
}

