import { pathToFileURL } from 'url';
// Synthetic replay: does the card name the project a new session is about to work on, and what does it cost?
// Builds a temp home with ~30 projects, simulates 3 weeks of sessions, replays them through the real observer,
// and at the start of every session renders the card from what was recorded before it.
// Honest caveat: the workload model decides the answer; this checks ranking dynamics, not real users.
// Usage: node synthetic-eval.mjs [distDir] [seed]
import fs from 'fs'; import os from 'os'; import path from 'path';
const DIST = path.resolve(process.argv[2] || './dist');
let seed = Number(process.argv[3] || 7);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-'));
Object.assign(process.env, { DC_DEVICE_CONTEXT_HOME: H, DC_DEVICE_CONTEXT_NO_RUNNING: '1' });
const core = await import(pathToFileURL(path.resolve(DIST, 'device-context/core.js')).href);
const card = await import(pathToFileURL(path.resolve(DIST, 'device-context/card.js')).href);

// --- machine: clear names, opaque names, plain folders, decoys
const specs = [];
const clear = ['shop', 'blog', 'crm', 'invoice-api', 'landing', 'booking', 'newsletter', 'inventory', 'hr-portal', 'analytics'];
const opaque = ['proj2', 'app-new', 'test3', 'site-old', 'tmp-api', 'v2', 'client-x', 'demo1', 'stuff', 'work-2024'];
for (const n of clear) specs.push({ name: n, dir: path.join(H, 'code', n), kind: 'git' });
for (const n of opaque) specs.push({ name: n, dir: path.join(H, 'projects', n), kind: rnd() < 0.5 ? 'git' : 'plain' });
for (const n of ['wp-site', 'static-promo', 'old-shop']) specs.push({ name: n, dir: path.join(H, 'sites', n), kind: 'plain' });
for (const s of specs) {
  fs.mkdirSync(path.join(s.dir, 'src'), { recursive: true });
  if (s.kind === 'git') { fs.mkdirSync(path.join(s.dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(s.dir, '.git/HEAD'), 'ref: refs/heads/main\n'); fs.writeFileSync(path.join(s.dir, 'package.json'), JSON.stringify({ name: s.name })); }
  for (const f of ['src/index.js', 'src/config.js', 'README.md', 'index.html']) fs.writeFileSync(path.join(s.dir, f), 'x');
}
fs.mkdirSync(path.join(H, 'code', 'shop-backup'), { recursive: true }); fs.writeFileSync(path.join(H, 'code', 'shop-backup', 'index.html'), 'x');

// --- workload: hot set rotates weekly; sessions continue the last project half of the time
const DAY = 86400e3, start = Date.parse('2026-10-26T08:00:00Z');
const sessions = [];
let last = null;
for (let d = 0; d < 21; d++) {
  const hot = specs.slice((Math.floor(d / 7) * 3) % specs.length, (Math.floor(d / 7) * 3) % specs.length + 3);
  const n = d % 7 >= 5 ? Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 4);
  let t = start + d * DAY + rnd() * 2 * 3600e3;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const proj = last && r < 0.5 ? last : r < 0.85 ? pick(hot) : pick(specs);
    sessions.push({ t, proj, noise: rnd() < 0.15 });
    last = proj;
    t += (40 + rnd() * 240) * 60e3;
  }
}

// --- replay
const rows = [];
const history = []; // raw tool-history-like records, for the "raw dump" comparison
let top1 = 0, top5 = 0, anywhere = 0, lastSess = 0, rawHas = 0, cardTok = 0, rawTok = 0, k = 0, seenK = 0, seenTop5 = 0, seenAny = 0;
const seen = new Set();
let prev = null;
for (const s of sessions) {
  const now = new Date(s.t);
  // at session start: what would the new chat get?
  if (rows.length) {
    const ranking = core.rank(rows, now);
    const text = card.renderCard(rows, ranking, { now, home: H, limit: 5 }) || '';
    const listed = card.cardRoots(text);
    const want = path.normalize(s.proj.dir);
    k++;
    if (listed[0] === want) top1++;
    if (listed.slice(0, 5).includes(want)) top5++;
    if (text.includes('`' + want + '`')) anywhere++;
    if (seen.has(want)) { seenK++; if (listed.slice(0, 5).includes(want)) seenTop5++; if (text.includes('`' + want + '`')) seenAny++; }
    if (prev && prev.dir === s.proj.dir) lastSess++;
    const raw = JSON.stringify(history.slice(-50));
    if (raw.includes(want)) rawHas++;
    cardTok += text.length / 4; rawTok += raw.length / 4;
  }
  // the session itself
  const calls = 5 + Math.floor(rnd() * 20);
  let t = s.t;
  for (let i = 0; i < calls; i++) {
    t += (20 + rnd() * 180) * 1000;
    const f = path.join(s.proj.dir, pick(['src/index.js', 'src/config.js', 'README.md', 'index.html']));
    const r = rnd();
    const ev = r < 0.45 ? { tool: 'read_file', args: { path: f } }
      : r < 0.75 ? { tool: 'edit_block', args: { file_path: f, old_string: 'a', new_string: 'password = "hunter22222"' } }
      : { tool: 'start_process', args: { command: `cd ${s.proj.dir.replace(H, '~')} && ${pick(['npm test', 'git status', 'git diff', 'pm2 restart app', 'ls -la'])}` } };
    if (s.noise && i === 0) Object.assign(ev, { tool: 'start_process', args: { command: 'df -h; du -sh ~/Downloads' } });
    const iso = new Date(t).toISOString();
    rows.push(...core.observeEvent({ t: iso, tool: ev.tool, args: ev.args, origin: 'remote' }, { home: H }).journal);
    history.push({ timestamp: iso, toolName: ev.tool, arguments: ev.args, output: { content: [{ type: 'text', text: 'x'.repeat(200 + Math.floor(rnd() * 2800)) }] } });
  }
  prev = s.proj; seen.add(path.normalize(s.proj.dir));
}
const pct = (x) => `${Math.round((100 * x) / k)}%`;
console.log(`sessions evaluated: ${k}, projects: ${specs.length + 1}, journal rows: ${rows.length}`);
console.log(`card top-1: ${pct(top1)} · top-5: ${pct(top5)} · anywhere on card: ${pct(anywhere)}`);
console.log(`baseline "same as last session": ${pct(lastSess)} · raw last-50 calls mention it: ${pct(rawHas)}`);
console.log(`tokens per new chat: card ≈ ${Math.round(cardTok / k)} vs raw last-50 history ≈ ${Math.round(rawTok / k)}`);
console.log(`projects seen before (memory can know them): top-5 ${Math.round(100*seenTop5/seenK)}% · on card ${Math.round(100*seenAny/seenK)}% (n=${seenK})`);
console.log(JSON.stringify({ top1: top1 / k, top5: top5 / k, anywhere: anywhere / k, lastSess: lastSess / k, raw50: rawHas / k, cardTok: cardTok / k, rawTok: rawTok / k }));
