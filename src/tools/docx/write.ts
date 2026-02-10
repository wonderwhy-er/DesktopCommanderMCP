/**
 * writeDocxPatched - the patch-based "update" orchestrator.
 *
 * Single Responsibility: coordinate the full update pipeline:
 *   1. Open DOCX ZIP
 *   2. Parse word/document.xml
 *   3. Snapshot before
 *   4. Apply operations
 *   5. Snapshot after
 *   6. Validate invariants (throws -> output NOT written)
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

    // 4. Apply ops
    const results: OpResult[] = [];
    const warnings: string[] = [];

    for (const op of ops) {
        try {
            const result = applyOp(body, op);
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

    // 5. After-snapshot
    const after = captureSnapshot(body);

    // 6. Validate - throws if structural invariants are broken
    validateInvariants(before, after);

    // 7. Serialize and save
    const newXml = serializeXml(doc);
    await saveDocxZip(zip, newXml, outputPath);

    // 8. Build stats
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