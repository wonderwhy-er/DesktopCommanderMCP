/**
 * Invariant validation for DOCX write operations.
 *
 * Single Responsibility: capture a structural snapshot of w:body and
 * compare before / after snapshots to guarantee no accidental breakage.
 */

import { getBodyChildren, bodySignature, countTables } from './dom.js';
import type { BodySnapshot } from './types.js';

// ─── Capture ────────────────────────────────────────────────────────

/** Take a snapshot of the body's structural invariants. */
export function captureSnapshot(body: Element): BodySnapshot {
    const children = getBodyChildren(body);
    return {
        bodyChildCount: children.length,
        tableCount: countTables(children),
        signature: bodySignature(children),
    };
}

// ─── Validate ───────────────────────────────────────────────────────

/**
 * Compare before / after snapshots.
 * Throws a descriptive error if any invariant has been violated,
 * preventing the output file from being written.
 */
export function validateInvariants(
    before: BodySnapshot,
    after: BodySnapshot,
): void {
    const errors: string[] = [];

    if (before.bodyChildCount !== after.bodyChildCount) {
        errors.push(
            `Body child count changed: ${before.bodyChildCount} → ${after.bodyChildCount}`,
        );
    }

    if (before.tableCount !== after.tableCount) {
        errors.push(
            `Table count changed: ${before.tableCount} → ${after.tableCount}`,
        );
    }

    if (before.signature !== after.signature) {
        errors.push(
            `Body signature changed:\n  before: ${before.signature}\n  after:  ${after.signature}`,
        );
    }

    if (errors.length > 0) {
        throw new Error(
            'DOCX structural validation failed — output NOT written.\n' +
                errors.join('\n'),
        );
    }
}

