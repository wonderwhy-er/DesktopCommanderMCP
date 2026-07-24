// Benchmark stripNullBytes against realistic tool-result shapes.
// Not part of the test suite (name doesn't match test*.js) — run manually:
//   npm run build && node test/bench-strip-null-bytes.mjs
import { stripNullBytes } from '../dist/remote-device/remote-channel.js';

const NUL = String.fromCharCode(0);

function bench(name, value, iterations) {
  // warm up JIT
  for (let i = 0; i < 5; i++) stripNullBytes(value);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) stripNullBytes(value);
  const t1 = process.hrtime.bigint();
  const perCallMs = Number(t1 - t0) / 1e6 / iterations;
  console.log(`${name.padEnd(46)} ${perCallMs.toFixed(4)} ms/call`);
}

const small = { content: [{ type: 'text', text: 'Process started with PID 1234' }] };
const typical = { content: [{ type: 'text', text: 'x'.repeat(10 * 1024) }] };       // 10 KB
const big = { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] };          // 1 MB
const huge = { content: [{ type: 'text', text: 'x'.repeat(13 * 1024 * 1024) }] };    // 13 MB (max seen in prod)
const withNul = { content: [{ type: 'text', text: ('x'.repeat(1024) + NUL).repeat(1024) }] }; // 1 MB w/ NULs
const manyKeys = Object.fromEntries(
  Array.from({ length: 500 }, (_, i) => [`key_${i}`, `value_${i}`])
);

console.log('--- no NUL present (the overwhelmingly common case) ---');
bench('small result (~30 B)', small, 20000);
bench('typical result (10 KB)', typical, 5000);
bench('big result (1 MB)', big, 200);
bench('huge result (13 MB, prod max)', huge, 20);
bench('object with 500 keys', manyKeys, 5000);

console.log('\n--- NUL present (rare) ---');
bench('1 MB with 1024 NULs', withNul, 200);

// Reference point: what the same payload costs to JSON-serialize, which the
// supabase client does on every write regardless.
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) JSON.stringify(huge);
const t1 = process.hrtime.bigint();
console.log(`\nreference: JSON.stringify(13 MB)               ${(Number(t1 - t0) / 1e6 / 20).toFixed(4)} ms/call`);
