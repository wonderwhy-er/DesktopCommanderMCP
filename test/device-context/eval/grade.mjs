// Grader for the device-context eval. Two commands:
//   node grade.mjs slice <runDir> <sinceISO>   copy this run's part of DC's logs into the run folder (UTF-8)
//   node grade.mjs summary <resultsDir>         grade every run folder, write summary.md + runs.csv
// A run folder holds: meta.json (arm, task, mode, prompt, claudeStart), claude.json, shop-status.txt,
// blog-check.txt, and after "slice": calls.jsonl, debug.jsonl.
import fs from 'fs';
import os from 'os';
import path from 'path';

const [, , cmd, a, b] = process.argv;
const dcDir = process.env.DC_LOG_DIR || path.join(os.homedir(), '.claude-server-commander');
const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/^﻿/, '') : '');
const jsonLines = (txt) => txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

if (cmd === 'slice') {
  const since = Date.parse(b);
  const keep = (rows, key) => rows.filter((r) => Date.parse(r[key]) >= since);
  const calls = keep(jsonLines(readText(path.join(dcDir, 'tool-history.jsonl'))), 'timestamp');
  const debug = keep(jsonLines(readText(path.join(dcDir, 'device-context-debug.jsonl'))), 't');
  fs.writeFileSync(path.join(a, 'calls.jsonl'), calls.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(a, 'debug.jsonl'), debug.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`sliced ${calls.length} calls, ${debug.length} debug rows`);
  process.exit(0);
}

const WRITE_TOOLS = new Set(['write_file', 'edit_block', 'move_file', 'create_directory', 'write_pdf']);
const argText = (r) => JSON.stringify(r.arguments ?? {}).replace(/\\\\/g, '/').toLowerCase();
const outText = (r) => (r.output?.content || []).map((c) => c.text || '').join('\n');
// "C:\\dev\\handmade-shop", "cd handmade-shop; node server.js", '...handmade-shop\\.env' — but not "handmade-shop-v2"
const mentions = (r, dir) => new RegExp(`(^|[^\\w.-])${dir}($|[^\\w-])`).test(argText(r));
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** All JSON events Claude Code printed (stream-json: one per line; plain json: just the result). */
function claudeEvents(dir) {
  return readText(path.join(dir, 'claude.json')).split(/\r?\n/).map((l) => {
    const i = l.indexOf('{'); if (i < 0) return null;
    try { return JSON.parse(l.slice(i)); } catch { return null; }
  }).filter(Boolean);
}
/** The model's tool calls with their results, from Claude Code's own stream (DC's history skips some tools). */
function streamCalls(ev) {
  const res = new Map(ev.filter((e) => e.type === 'user').flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => [c.tool_use_id, Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : String(c.content ?? '')]));
  return ev.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content || []).filter((c) => c.type === 'tool_use')
    .map((u) => ({ toolName: String(u.name).replace(/^mcp__dc__/, ''), arguments: u.input, output: { content: [{ type: 'text', text: res.get(u.id) || '' }] } }));
}

function claudeResult(dir) {
  for (const l of readText(path.join(dir, 'claude.json')).split(/\r?\n/)) {
    const i = l.indexOf('{'); if (i < 0) continue;
    try { const j = JSON.parse(l.slice(i)); if (j && j.type === 'result') return j; } catch { /* not json */ }
  }
  return null;
}

export function gradeRun(dir) {
  const meta = JSON.parse(readText(path.join(dir, 'meta.json')) || '{}');
  const target = meta.task === 'blog' ? 'travel-blog' : meta.variant === 'stale' ? 'clay-shop' : 'handmade-shop';
  const others = ['handmade-shop', 'shop-old', 'travel-blog', 'clayco-shop', 'clay-shop'].filter((x) => x !== target && !(meta.variant === 'stale' && x === 'handmade-shop'));
  const start = Date.parse(meta.claudeStart);
  const ev = claudeEvents(dir);
  const fromStream = streamCalls(ev);
  const fromDc = jsonLines(readText(path.join(dir, 'calls.jsonl'))).filter((r) => Date.parse(r.timestamp) >= start);
  const calls = fromStream.length ? fromStream : fromDc; // DC's history is the fallback (and a cross-check)
  const debug = jsonLines(readText(path.join(dir, 'debug.jsonl'))).filter((r) => Date.parse(r.t) >= start);
  const cr = claudeResult(dir);
  const u = cr?.usage ?? {};
  // reaching the target = a call that works on it; asking get_device_context about it does not count
  const locate = calls.findIndex((r) => r.toolName !== 'get_device_context' && mentions(r, target));
  const before = locate < 0 ? calls : calls.slice(0, locate);
  const success = meta.task === 'blog' ? readText(path.join(dir, 'blog-check.txt')).trim() === 'yes'
    : readText(path.join(dir, 'shop-status.txt')).trim() === '200';
  const final = String(cr?.result ?? '');
  return {
    run: path.basename(dir), arm: meta.arm, task: meta.task, mode: meta.mode,
    success,
    asked: !success && /\?/.test(final),
    claudeOk: !!cr && !cr.is_error,
    turns: cr?.num_turns ?? null,
    seconds: cr ? Math.round((cr.duration_ms ?? 0) / 1000) : null,
    costUsd: cr?.total_cost_usd ?? null,
    inputTokens: cr ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : null,
    outputTokens: u.output_tokens ?? null,
    dcCalls: calls.length,
    callsBeforeTarget: locate < 0 ? calls.length : locate, // never reached = every call was spent looking
    charsBeforeTarget: before.reduce((n, r) => n + outText(r).length, 0),
    reachedTarget: locate >= 0,
    visitedOther: calls.filter((r) => others.some((o) => mentions(r, o))).length,
    // any change on disk in another project (file hashes before/after the chat), shell writes included
    wroteOther: readText(path.join(dir, 'changed.txt')).split(',').map((x) => x.trim()).filter((x) => x && x !== target).length
      || calls.filter((r) => WRITE_TOOLS.has(r.toolName) && others.some((o) => mentions(r, o))).length,
    changed: readText(path.join(dir, 'changed.txt')).trim(),
    contextToolCalls: calls.filter((r) => r.toolName === 'get_device_context').length,
    cardAppends: debug.filter((r) => r.event === 'decision' && r.appended).length,
    cardsSeen: calls.filter((r) => /💡 (Recent work on this device|Projects Desktop Commander has seen)/.test(outText(r))).length,
    dcCallsInHistory: fromDc.length,
    historyCalls: calls.filter((r) => r.toolName === 'get_recent_tool_calls').length,
    historyChars: calls.filter((r) => r.toolName === 'get_recent_tool_calls').reduce((n, r) => n + outText(r).length, 0),
    final: final.replace(/\s+/g, ' ').slice(0, 300),
  };
}

if (cmd === 'summary') {
  const dirs = fs.readdirSync(a).map((d) => path.join(a, d)).filter((d) => fs.existsSync(path.join(d, 'meta.json')));
  const runs = dirs.map(gradeRun);
  const cols = Object.keys(runs[0] ?? {});
  fs.writeFileSync(path.join(a, 'runs.csv'), [cols.join(','), ...runs.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n') + '\n');
  const arms = [...new Set(runs.map((r) => r.arm))];
  const rows = arms.map((arm) => {
    const rs = runs.filter((r) => r.arm === arm);
    const n = rs.length;
    const m = (k) => median(rs.map((r) => r[k]));
    return { arm, task: rs[0].task, mode: rs[0].mode, n,
      success: `${rs.filter((r) => r.success).length}/${n}`, asked: `${rs.filter((r) => r.asked).length}/${n}`,
      reached: `${rs.filter((r) => r.reachedTarget).length}/${n}`,
      callsBeforeTarget: m('callsBeforeTarget'), dcCalls: m('dcCalls'), turns: m('turns'),
      inputTokens: m('inputTokens'), outputTokens: m('outputTokens'), costUsd: m('costUsd') == null ? null : +m('costUsd').toFixed(3),
      visitedOther: rs.reduce((s, r) => s + r.visitedOther, 0), wroteOther: rs.reduce((s, r) => s + r.wroteOther, 0),
      contextToolCalls: rs.reduce((s, r) => s + r.contextToolCalls, 0), cardAppends: rs.reduce((s, r) => s + r.cardAppends, 0),
      cardsSeen: rs.reduce((s, r) => s + r.cardsSeen, 0), charsBeforeTarget: m('charsBeforeTarget'),
      historyCalls: rs.reduce((s, r) => s + r.historyCalls, 0), claudeErrors: rs.filter((r) => !r.claudeOk).length };
  });
  const head = ['arm', 'task', 'mode', 'n', 'success', 'asked', 'reached', 'callsBeforeTarget', 'charsBeforeTarget', 'dcCalls', 'turns', 'inputTokens', 'outputTokens', 'costUsd', 'visitedOther', 'wroteOther', 'contextToolCalls', 'cardsSeen', 'historyCalls', 'claudeErrors'];
  const md = ['# Device-context eval', '', 'Medians per arm; counts are totals over the arm\'s runs.', '',
    `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${head.map((h) => r[h] ?? '–').join(' | ')} |`), '',
    '## Final answers', '', ...runs.map((r) => `- **${r.run}** (${r.success ? 'success' : 'no'}): ${r.final}`)].join('\n');
  fs.writeFileSync(path.join(a, 'summary.md'), md + '\n');
  console.log(md.split('\n').slice(0, rows.length + 6).join('\n'));
  process.exit(0);
}

if (cmd) { console.error('usage: grade.mjs slice <runDir> <sinceISO> | summary <resultsDir>'); process.exit(2); }
