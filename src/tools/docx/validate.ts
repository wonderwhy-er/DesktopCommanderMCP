/**
 * Invariant validation for DOCX write operations.
 *
 * Single Responsibility: capture a structural snapshot of w:body and
 * compare before / after snapshots to guarantee no accidental breakage.
 */

import { getBodyChildren, bodySignature, countTables } from './dom.js';
import type { BodySnapshot } from './types.js';

// ─── Options ─────────────────────────────────────────────────────────

export interface ValidationOptions {
    /**
     * Expected change in w:body direct child count.
     * Positive = inserts, negative = deletes.
     * Default 0 (no structural changes expected).
     */
    expectedChildDelta?: number;
}

// ─── Capture ─────────────────────────────────────────────────────────

/** Take a snapshot of the body's structural invariants. */
export function captureSnapshot(body: Element): BodySnapshot {
    const children = getBodyChildren(body);
    return {
        bodyChildCount: children.length,
        tableCount: countTables(children),
        signature: bodySignature(children),
    };
}

// ─── Validate ────────────────────────────────────────────────────────

/**
 * Compare before / after snapshots.
 * Throws a descriptive error if any invariant has been violated,
 * preventing the output file from being written.
 *
 * When `expectedChildDelta` is non-zero (structural ops like insert or
 * delete), signature validation is skipped because the body structure
 * is *expected* to change.  Child count is still validated against
 * the expected delta, and table count must remain unchanged.
 */
export function validateInvariants(
    before: BodySnapshot,
    after: BodySnapshot,
    options?: ValidationOptions,
): void {
    const delta = options?.expectedChildDelta ?? 0;
    const expectedChildCount = before.bodyChildCount + delta;
    const errors: string[] = [];

    if (expectedChildCount !== after.bodyChildCount) {
        errors.push(
            `Body child count mismatch: expected ${expectedChildCount} (before ${before.bodyChildCount} + delta ${delta}), got ${after.bodyChildCount}`,
        );
    }

    if (before.tableCount !== after.tableCount) {
        errors.push(
            `Table count changed: ${before.tableCount} → ${after.tableCount}`,
        );
    }

    // Only enforce signature stability when no structural ops changed the body
    if (delta === 0 && before.signature !== after.signature) {
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
