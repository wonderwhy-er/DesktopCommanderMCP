// "Yesterday's chat": real calls through the fork's DC (so they land in DC history and the device-context journal).
// Starts the shop, then edits .env to point at a catalog file that does not exist and restarts -> the shop is down.
// Usage (from the fork root): node test/device-context/prior-chat.mjs <shopDir>
import path from 'path';
import fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.DC_DEV_TOOLS !== '1') { console.error('Dev-only script: rewrites the test shop and adds calls to your DC history. Set DC_DEV_TOOLS=1 to run it.'); process.exit(1); }
const shop = path.resolve(process.argv[2] || 'C:\\dev\\handmade-shop');
const dist = path.resolve('dist/index.js');
// start from the working shop every time (this part is "before the chat", not through DC)
fs.writeFileSync(path.join(shop, '.env'), 'PORT=3000\nSHOP_NAME=Clay & Co\nDATA_FILE=data/products.json\n');
const t = new StdioClientTransport({ command: process.execPath, args: [dist],
  env: { ...process.env, DESKTOP_COMMANDER_DEVICE_CONTEXT: 'both', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1' } });
const c = new Client({ name: 'prior-chat', version: '1' });
await c.connect(t);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content || []).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ').slice(0, 140);
  console.log(`${name} -> ${r.isError ? 'ERROR ' : ''}${text}`);
  return text;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = (text) => Number(text.match(/PID (\d+)/)?.[1]);

// plain `node <abs path>` works the same in bash, cmd and PowerShell
const run = () => call('start_process', { command: `node "${path.join(shop, 'server.js')}"`, timeout_ms: 4000 });

// 1) the shop runs
let out = await run();
let pid = pidOf(out);
await call('read_file', { path: path.join(shop, 'README.md') });
await call('read_file', { path: path.join(shop, '.env') });
// 2) "let's rename the catalog setting" -> points at a file that does not exist
await call('edit_block', { file_path: path.join(shop, '.env'), old_string: 'DATA_FILE=data/products.json', new_string: 'DATA_FILE=data/catalog.json' });
if (pid) await call('force_terminate', { pid });
await sleep(1000);
// 3) restart: crashes with ENOENT, nothing listens on :3000 any more
out = await run();
await sleep(1500);
pid = pidOf(out);
if (pid) await call('read_process_output', { pid, timeout_ms: 1000 });
await c.close();
console.log('\nprior chat done: shop .env now points at data/catalog.json (missing) and the shop is down.');
process.exit(0);
