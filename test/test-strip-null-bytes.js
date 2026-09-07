#!/usr/bin/env node

/**
 * Regression tests for stripNullBytes (remote-device/remote-channel.ts).
 *
 * Postgres rejects a NUL (U+0000) in BOTH jsonb and text with 22P05, which
 * stranded remote calls at 'executing' until the 5-minute timeout. The first
 * implementation serialized to JSON and regex-replaced the ESCAPE TEXT, which
 * had two failure modes found in review (2026-07-24) — both covered here:
 *
 *   1. SILENT CORRUPTION: content containing the six literal characters
 *      backslash-u-0-0-0-0 (e.g. reading a source file with that escape in it)
 *      had those characters deleted from the tool result, undetected.
 *   2. THROW: a doubled-backslash form produced invalid JSON, so the write threw
 *      and the call was reported failed even though the tool had succeeded.
 *
 * Run: npm run build && node test/test-strip-null-bytes.js
 */

import { stripNullBytes } from '../dist/remote-device/remote-channel.js';

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`✅ PASS  ${name}`);
  } else {
    failures++;
    console.error(`❌ FAIL  ${name}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  }
}

// --- the bug it exists to fix: real NUL characters are removed ---------------
check('strips a real NUL from a string', stripNullBytes(`a${NUL}b`), 'ab');
check(
  'strips a real NUL nested in a tool result',
  stripNullBytes({ content: [{ type: 'text', text: `START${NUL}END` }] }),
  { content: [{ type: 'text', text: 'STARTEND' }] }
);
check('strips real NULs from object keys', stripNullBytes({ [`k${NUL}`]: 1 }), { k: 1 });

// --- regression 1: literal escape TEXT must be preserved, not corrupted ------
const literalEscape = `const re = /${BACKSLASH}u0000/g;`;
check('preserves literal backslash-u0000 text (no silent corruption)',
  stripNullBytes({ text: literalEscape }), { text: literalEscape });

// --- regression 2: doubled backslash must not throw --------------------------
const doubled = `x${BACKSLASH}${BACKSLASH}u0000y`;
let threw = null;
try {
  check('handles doubled backslash without throwing', stripNullBytes({ text: doubled }), { text: doubled });
} catch (e) {
  threw = e;
  failures++;
  console.error(`❌ FAIL  handles doubled backslash without throwing — threw: ${e.message}`);
}

// --- structure / passthrough ------------------------------------------------
check('leaves clean content untouched', stripNullBytes({ a: 'clean', b: [1, 2] }), { a: 'clean', b: [1, 2] });
check('passes through null', stripNullBytes(null), null);
check('passes through numbers/booleans', stripNullBytes({ n: 42, b: true }), { n: 42, b: true });
check('handles arrays of strings with NUL', stripNullBytes([`p${NUL}q`, 'clean']), ['pq', 'clean']);

// --- the property that actually matters for Postgres ------------------------
const out = JSON.stringify(stripNullBytes({ x: `${NUL}${NUL}`, y: literalEscape }));
if (out.includes(NUL)) {
  failures++;
  console.error('❌ FAIL  output still contains a raw NUL character');
} else {
  console.log('✅ PASS  output contains no raw NUL characters');
}

console.log(`\n${failures === 0 ? '✅' : '❌'} strip-null-bytes: ${failures} failing test(s).`);
process.exitCode = failures === 0 ? 0 : 1;
