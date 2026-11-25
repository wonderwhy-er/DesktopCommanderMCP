// Photo scenario: "earlier chats" as real Desktop Commander calls (no AI), clock shifted per session.
//   -4d   travel-blog   edit a post (background)
//   -1d   public_html   resize product photos with sharp: crashes on a corrupt file at #181 (180 of 300 done)
//   -0.3d travel-blog   read a post (so the LAST session is not the photo job)
// Usage (cwd = DC fork root): node history.mjs <home>
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
if (process.env.DC_DEV_TOOLS !== '1') { console.error('Dev-only script for a throwaway VPS: replaces DC\'s tool history. Set DC_DEV_TOOLS=1 to run it.'); process.exit(1); }
const req = createRequire(path.join(process.cwd(), 'package.json'));
const sdk = async (p) => import(pathToFileURL(req.resolve(p)).href);
const { Client } = await sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await sdk('@modelcontextprotocol/sdk/client/stdio.js');
const home = path.resolve(process.argv[2] || os.homedir());
const site = path.join(home, 'public_html');
const blog = path.join(home, 'code', 'travel-blog');
const dist = path.resolve('dist/index.js');
const DAY = 86400e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spans = [];
async function session(daysAgo, label, steps) {
  const wallStart = Date.now();
  const t = new StdioClientTransport({ command: process.execPath, args: [dist],
    env: { ...process.env, DESKTOP_COMMANDER_DEVICE_CONTEXT: 'both', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_DEVICE_CONTEXT_NOW: new Date(Date.now() - daysAgo * DAY).toISOString() } });
  const c = new Client({ name: `history-${label}`, version: '1' });
  await c.connect(t);
  const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content || []).map((x) => x.text || '').join(' ');
    console.log(`[${label} -${daysAgo}d] ${name} -> ${r.isError ? 'ERROR ' : ''}${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    return text;
  };
  await steps(call);
  await sleep(1500);
  await c.close();
  spans.push([wallStart, Date.now(), daysAgo]);
}
await session(0, 'init', async (call) => { await call('get_config', {}); });
await session(4, 'blog', async (call) => {
  await call('read_file', { path: path.join(blog, 'posts', 'rome.md') });
  await call('edit_block', { file_path: path.join(blog, 'posts', 'rome.md'), old_string: 'Three days of walking, gelato and old stones.', new_string: 'Three days of walking, gelato and old stones. Best: Trastevere at night.' });
});
let tail = '';
const JOB_DAYS = process.env.WEEK === '1' ? 7 : 1;
await session(JOB_DAYS, 'photos', async (call) => {
  await call('list_directory', { path: site });
  await call('start_process', { command: `ls ${path.join(site, 'images', 'products')} | wc -l; du -sh ${path.join(site, 'images', 'products')}`, timeout_ms: 3000 });
  await call('start_process', { command: `cd ${path.join(site, 'tools')} && npm install sharp --no-audit --no-fund`, timeout_ms: 30000 });
  await call('write_file', { path: path.join(site, 'tools', 'resize.js'), content: fs.readFileSync(new URL('./resize.js', import.meta.url), 'utf8'), mode: 'rewrite' });
  const started = await call('start_process', { command: `cd ${path.join(site, 'tools')} && node resize.js`, timeout_ms: 3000 });
  const pid = Number(started.match(/PID (\d+)/)?.[1]);
  for (let i = 0; i < 60 && pid; i++) {
    await sleep(2000);
    tail = await call('read_process_output', { pid, timeout_ms: 1000 });
    if (/exit code|finished|Error/i.test(tail)) break;
  }
});
const WEEK = process.env.WEEK === '1';
if (!WEEK) {
  await session(0.3, 'blog-later', async (call) => { await call('read_file', { path: path.join(blog, 'posts', 'porto.md') }); });
} else {
  // A week of other work after the photo job: ~130 calls, so the job is far outside get_recent_tool_calls' default 50
  const code = path.join(home, 'code');
  const plan = [[6, ['express', 'body-parser']], [5, ['full-stack-fastapi-template']], [4, ['requests', 'httpx']], [3, ['handmade-shop', 'travel-blog']], [2, ['djangoproject.com']], [1, ['cobra', 'click']]];
  for (const [d, projects] of plan) {
    await session(d, `work-${d}`, async (call) => {
      for (const p of projects) {
        const root = path.join(code, p);
        if (!fs.existsSync(root)) continue;
        await call('list_directory', { path: root });
        const files = fs.readdirSync(root).filter((f) => /\.(md|json|toml|py|js|go|cfg|txt)$/i.test(f) && fs.statSync(path.join(root, f)).isFile()).slice(0, 6);
        for (const f of files) await call('read_file', { path: path.join(root, f), length: 60 });
        const sub = fs.readdirSync(root).find((f) => !f.startsWith('.') && fs.statSync(path.join(root, f)).isDirectory());
        if (sub) await call('list_directory', { path: path.join(root, sub) });
        for (const c of ['git status --short | head -5', 'git log --oneline -3', 'ls -la | head -12']) await call('start_process', { command: `cd ${root} && ${c}`, timeout_ms: 3000 });
      }
    });
  }
  await session(0.3, 'blog-later', async (call) => { await call('read_file', { path: path.join(blog, 'posts', 'porto.md') }); });
}

// DC's own history gets the same dates as the journal
const dcDir = path.join(os.homedir(), '.claude-server-commander');
const hf = path.join(dcDir, 'tool-history.jsonl');
const lines = fs.readFileSync(hf, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { const r = JSON.parse(l); const ts = Date.parse(r.timestamp); const s = spans.find(([a, b]) => ts >= a - 500 && ts <= b + 2000);
    if (s && s[2]) { r.timestamp = new Date(ts - s[2] * DAY).toISOString(); return JSON.stringify(r); } } catch {}
  return l;
});
const key = (l) => { try { return Date.parse(JSON.parse(l).timestamp) || 0; } catch { return 0; } };
lines.sort((x, y) => key(x) - key(y));
fs.writeFileSync(hf, lines.join('\n') + '\n');
// the resized files and the script "were made yesterday"
const web = path.join(site, 'images', 'products-web');
const y = new Date(Date.now() - (process.env.WEEK === '1' ? 7 : 1) * DAY);
for (const f of fs.existsSync(web) ? fs.readdirSync(web) : []) fs.utimesSync(path.join(web, f), y, y);
fs.utimesSync(path.join(site, 'tools', 'resize.js'), y, y);
const done = fs.existsSync(web) ? fs.readdirSync(web).length : 0;
const j = fs.readFileSync(path.join(dcDir, 'device-context-events.jsonl'), 'utf8');
const histN = lines.length; const jobIdx = lines.findIndex((l) => l.includes('resize.js')); console.log(`calls after the photo job in DC history: ${histN - jobIdx}`);
console.log(`\nresized yesterday: ${done} of 300; journal has public_html: ${j.includes('public_html')}; failed row: ${/public_html[^\n]*"failed":true/.test(j)}`);
if (done < 150 || done > 200) { console.error('HISTORY INCOMPLETE: expected the job to stop around #181'); process.exit(1); }
process.exit(0);
