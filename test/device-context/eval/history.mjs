// "Earlier chats" for the eval: real Desktop Commander calls (no AI), so they land in DC's history and the
// device-context journal. Each session runs its own DC with the clock shifted back (DC_DEVICE_CONTEXT_NOW),
// so the journal says "10 / 3 / 2 / 1 days ago".
//   -10d shop-old     glance (archived copy with a similar name)
//    -3d travel-blog  edit a post, start the blog, stop it
//    -2d handmade-shop the break: .env DATA_FILE -> data/catalog.json (missing), restart -> crash
//    -1d travel-blog  edit a post again (the LAST session is not the one that broke the shop)
// Usage (from the fork root): node test/device-context/eval/history.mjs <projectsRoot>
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
if (process.env.DC_DEV_TOOLS !== '1') { console.error('Dev-only script: rewrites test projects and DC\'s tool history. Set DC_DEV_TOOLS=1 to run it.'); process.exit(1); }

// Runs from the fork root (cwd); the kit itself may live elsewhere, so load the MCP SDK from the fork
const fork = process.cwd();
const req = createRequire(path.join(fork, 'package.json'));
const sdk = async (p) => import(pathToFileURL(req.resolve(p)).href);
const { Client } = await sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await sdk('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.resolve(process.argv[2] || 'C:\\dev');
const shop = path.join(root, 'handmade-shop');
const old = path.join(root, 'shop-old');
const blog = path.join(root, 'travel-blog');
const dist = path.resolve('dist/index.js');
const DAY = 86400e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Files that cannot be shipped remotely (.env) are created here, before any "chat"
fs.writeFileSync(path.join(shop, '.env'), 'PORT=3000\nSHOP_NAME=Clay & Co\nDATA_FILE=data/products.json\n');
fs.writeFileSync(path.join(old, '.env'), 'PORT=3001\nSHOP_NAME=Clay & Co (old)\nDATA_FILE=data/products.json\n');

// EVAL_VARIANT: twin = a second live shop with the same description, worked on last (healthy);
//               stale = after the break the shop folder was renamed outside DC, so memory points at a missing path
const VARIANT = process.env.EVAL_VARIANT || '';
const twin = path.join(root, 'clayco-shop');
const moved = path.join(root, 'clay-shop');
if (VARIANT === 'twin') {
  fs.cpSync(shop, twin, { recursive: true });
  fs.writeFileSync(path.join(twin, '.env'), 'PORT=3002\nSHOP_NAME=Clay & Co\nDATA_FILE=data/products.json\n');
}

const spans = []; // [wallStart, wallEnd, daysAgo]: to shift DC's own history to the same dates as the journal
async function session(daysAgo, label, steps) {
  const wallStart = Date.now();
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  const t = new StdioClientTransport({ command: process.execPath, args: [dist],
    env: { ...process.env, DESKTOP_COMMANDER_DEVICE_CONTEXT: 'both', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_DEVICE_CONTEXT_NOW: at } });
  const c = new Client({ name: `history-${label}`, version: '1' });
  await c.connect(t);
  const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content || []).map((x) => x.text || '').join(' ');
    console.log(`[${label} -${daysAgo}d] ${name} -> ${r.isError ? 'ERROR ' : ''}${text.replace(/\s+/g, ' ').slice(0, 100)}`);
    return text;
  };
  await steps(call);
  await sleep(1500); // let DC finish the journal append and its tool-history flush before the process goes away
  await c.close();
  spans.push([wallStart, Date.now(), daysAgo]);
}
const pidOf = (text) => Number(text.match(/PID (\d+)/)?.[1]);
const start = (call, dir) => call('start_process', { command: `node "${path.join(dir, 'server.js')}"`, timeout_ms: 4000 });

// Build the journal from the (real) tool history first, with a call that records nothing itself,
// so no backfilled row can pick up a shifted clock
await session(0, 'init', async (call) => { await call('get_config', {}); });

await session(10, 'shop-old', async (call) => {
  await call('list_directory', { path: old });
  await call('read_file', { path: path.join(old, 'README.md') });
});

await session(3, 'blog', async (call) => {
  await call('read_file', { path: path.join(blog, 'README.md') });
  await call('edit_block', { file_path: path.join(blog, 'posts', 'rome.md'), old_string: 'Three days of walking, gelato and old stones.', new_string: 'Three days of walking, gelato and old stones. Best: Trastevere at night.' });
  const pid = pidOf(await start(call, blog));
  if (pid) await call('force_terminate', { pid });
});

await session(2, 'shop', async (call) => {
  let pid = pidOf(await start(call, shop));
  await call('read_file', { path: path.join(shop, 'README.md') });
  await call('read_file', { path: path.join(shop, '.env') });
  await call('edit_block', { file_path: path.join(shop, '.env'), old_string: 'DATA_FILE=data/products.json', new_string: 'DATA_FILE=data/catalog.json' });
  if (pid) await call('force_terminate', { pid });
  await sleep(1000);
  pid = pidOf(await start(call, shop));
  await sleep(1500);
  if (pid) await call('read_process_output', { pid, timeout_ms: 1000 });
});

await session(1, 'blog', async (call) => {
  await call('read_file', { path: path.join(blog, 'posts', 'porto.md') });
  await call('edit_block', { file_path: path.join(blog, 'posts', 'porto.md'), old_string: 'River, tiles and port wine.', new_string: 'River, tiles and port wine. Took the tram to Foz.' });
});

if (VARIANT === 'twin') {
  // the most recent session: the OTHER shop, edited and started fine, then stopped
  await session(0.5, 'twin', async (call) => {
    await call('read_file', { path: path.join(twin, 'README.md') });
    await call('edit_block', { file_path: path.join(twin, 'data', 'products.json'), old_string: '"Vase"', new_string: '"Tall vase"' });
    const pid = pidOf(await start(call, twin));
    await sleep(1500);
    if (pid) await call('force_terminate', { pid });
  });
}

// DC's tool-history.jsonl has wall-clock timestamps: move each session's calls to its "days ago" date,
// so get_recent_tool_calls (what the no-memory arms see) tells the same story as the journal
const dcDir = path.join(os.homedir(), '.claude-server-commander');
const hf = path.join(dcDir, 'tool-history.jsonl');
if (fs.existsSync(hf)) {
  const out = fs.readFileSync(hf, 'utf8').split('\n').map((l) => {
    try {
      const r = JSON.parse(l); const ts = Date.parse(r.timestamp);
      const s = spans.find(([a, b]) => ts >= a - 500 && ts <= b + 2000);
      if (s && s[2]) { r.timestamp = new Date(ts - s[2] * DAY).toISOString(); return JSON.stringify(r); }
    } catch { /* keep the line as is */ }
    return l;
  }).filter(Boolean);
  // keep the file chronological (DC reads "recent" from the end)
  const key = (l) => { try { return Date.parse(JSON.parse(l).timestamp) || 0; } catch { return 0; } };
  out.sort((x, y) => key(x) - key(y));
  fs.writeFileSync(hf, out.join('\n') + '\n');
}

if (VARIANT === 'stale') fs.renameSync(shop, moved); // renamed by hand after the break, outside DC

// The run is only valid if the memory really holds the break and the later blog session
const j = fs.existsSync(path.join(dcDir, 'device-context-events.jsonl')) ? fs.readFileSync(path.join(dcDir, 'device-context-events.jsonl'), 'utf8') : '';
if (!/handmade-shop[^\n]*"failed":true/.test(j) || !j.includes('porto.md')) { console.error('HISTORY INCOMPLETE: journal is missing the failed shop start or the blog session'); process.exit(1); }
console.log('\nhistory done: shop broken 2 days ago, last session = blog 1 day ago');
process.exit(0);
