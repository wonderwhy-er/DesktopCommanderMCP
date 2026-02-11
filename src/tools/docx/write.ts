/**
 * writeDocxPatched - the patch-based "update" orchestrator.
 *
 * Single Responsibility: coordinate the full update pipeline:
 *   1. Open DOCX ZIP
 *   2. Parse word/document.xml
 *   3. Snapshot before
 *   4. Apply operations (pass zip for ops that touch auxiliary files)
 *   5. Snapshot after
 *   6. Validate invariants (accounting for structural deltas)
 *   7. Serialize and save
 *
 * Each step delegates to a single-purpose module, keeping this file
 * a pure orchestrator with no direct DOM/XML/ZIP logic.
 */

import { loadDocxZip, getDocumentXml, saveDocxZip } from './zip.js';
import { parseXml, serializeXml, getBody } from './dom.js';
import { captureSnapshot, validateInvariants } from './validate.js';
import { applyOp } from './ops/index.js';
import type { DocxOp, OpResult, WriteDocxStats, WriteDocxResult } from './types.js';

/** Structural op types that add/remove body children. */
const STRUCTURAL_INSERT_OPS = new Set([
    'insert_paragraph_after_text',
    'insert_table',
    'insert_image',
]);
const STRUCTURAL_DELETE_OPS = new Set(['delete_paragraph_at_body_index']);

export async function writeDocxPatched(
    inputPath: string,
    outputPath: string,
    ops: DocxOp[],
): Promise<WriteDocxResult> {
    // 1. Load ZIP
    const zip = await loadDocxZip(inputPath);

    // 2. Parse document.xml
    const xmlStr = getDocumentXml(zip);
    const doc = parseXml(xmlStr);
    const body = getBody(doc);

    // 3. Before-snapshot
    const before = captureSnapshot(body);

    // 4. Apply ops — pass zip for ops that modify auxiliary files
    const results: OpResult[] = [];
    const warnings: string[] = [];

    for (const op of ops) {
        try {
            const result = applyOp(body, op, zip);
            results.push(result);

            if (result.status === 'skipped') {
                warnings.push(`Op ${op.type} skipped: ${result.reason ?? 'unknown'}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(`Op ${op.type} failed: ${msg}`);
            results.push({
                op,
                status: 'skipped',
                matched: 0,
                reason: `error: ${msg}`,
            });
        }
    }

    // 5. Compute expected structural delta from applied ops
    let expectedChildDelta = 0;
    let expectedTableDelta = 0;
    for (const r of results) {
        if (r.status !== 'applied') continue;
        if (STRUCTURAL_INSERT_OPS.has(r.op.type)) expectedChildDelta += 1;
        if (STRUCTURAL_DELETE_OPS.has(r.op.type)) expectedChildDelta -= 1;
        if (r.op.type === 'insert_table') expectedTableDelta += 1;
    }

    // 6. After-snapshot
    const after = captureSnapshot(body);

    // 7. Validate — throws if structural invariants are broken
    validateInvariants(before, after, { expectedChildDelta, expectedTableDelta });

    // 8. Serialize and save (document.xml + any zip-level changes)
    const newXml = serializeXml(doc);
    await saveDocxZip(zip, newXml, outputPath);

    // 9. Build stats
    const stats: WriteDocxStats = {
        tablesBefore: before.tableCount,
        tablesAfter: after.tableCount,
        bodyChildrenBefore: before.bodyChildCount,
        bodyChildrenAfter: after.bodyChildCount,
        bodySignatureBefore: before.signature,
        bodySignatureAfter: after.signature,
    };

    return { outputPath, results, stats, warnings };
}
