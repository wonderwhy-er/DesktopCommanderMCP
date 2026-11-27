// How much the compact get_recent_tool_calls saves on real history files.
// Usage (after build): node test/device-context/compact-history-size.mjs <tool-history.jsonl> [more.jsonl ...]
import fs from 'fs'; import path from 'path'; import { pathToFileURL } from 'url';
const { compactCalls } = await import(pathToFileURL(path.resolve('dist/device-context/history.js')).href);
let fails = 0; const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : '  ' + String(info).slice(0, 300)}`); if (!ok) fails++; };
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: compact-history-size.mjs <tool-history.jsonl> [...]'); process.exit(2); }
const calls = files.flatMap((f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
// the same shape DC's handler returns without compaction
const summary = `Tool Call History (${calls.length} results, ${calls.length} total in memory)`;
const raw = `${summary}\n\n${JSON.stringify(calls, null, 2)}`;
const compact = compactCalls(summary, calls);
const lines = compact.split('\n');
check('one line per call (+ header)', lines.length === calls.length + 1, `${lines.length} vs ${calls.length + 1}`);
check('no file contents (edit_block new_string) leak', !calls.some((c) => c.arguments?.new_string && c.arguments.new_string.length > 12 && compact.includes(c.arguments.new_string)));
check('secrets redacted', !compactCalls('H', [{ timestamp: '2026-11-21T10:00:00Z', toolName: 'start_process', arguments: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x' } }]).includes('abcdefghijklmnop'));
console.log(`\nchars: raw ${raw.length} -> compact ${compact.length}  (~${Math.round(raw.length / 4)} -> ~${Math.round(compact.length / 4)} tokens, ${(raw.length / compact.length).toFixed(1)}x)`);
console.log(`per call: raw ~${Math.round(raw.length / 4 / calls.length)} tokens, compact ~${Math.round(compact.length / 4 / calls.length)} tokens\n`);
console.log(lines.slice(0, 12).join('\n'));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
