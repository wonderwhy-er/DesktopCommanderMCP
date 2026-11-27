// Shared setup for the device-context suites (node test/device-context/<suite>.test.mjs [distDir]).
// Every suite gets an isolated home (journal, config: never the developer's real ~/.claude-server-commander),
// the built modules, and checks that fail loudly: a check over a list fails when the list is empty.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process'; import { pathToFileURL } from 'url';

export const DIST = path.resolve(process.argv[2] || './dist');
export const LINUX = process.platform === 'linux';
const imp = (f) => import(pathToFileURL(path.join(DIST, 'device-context', f)).href);

let mods = null;
async function modules() {
  mods ??= {
    dc: await imp('index.js'), shell: await imp('shell.js'), verbs: await imp('verbs.js'), observe: await imp('observe.js'),
    projects: await imp('projects.js'), privacy: await imp('privacy.js'), rank: await imp('rank.js'), card: await imp('card.js'),
    nudge: await imp('nudge.js'), machine: await imp('machine.js'), store: await imp('store.js'), settings: await imp('settings.js'),
    history: await imp('history.js'),
  };
  return mods;
}

/**
 * A fresh, isolated device: temp home, mode in the env (config `deviceContext` unset unless given), config served
 * to device context the way server.ts serves configManager's. `allowedDirectories: []` (everything) unless given.
 * Can be called again in the same process for another home.
 */
export async function setup({ prefix = 'dc-', mode = 'both', config = {}, env = {}, running = false } = {}) {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(H, '.claude-server-commander'), { recursive: true });
  Object.assign(process.env, { DC_DEVICE_CONTEXT_HOME: H, DESKTOP_COMMANDER_DEVICE_CONTEXT: mode, ...env });
  if (running) delete process.env.DC_DEVICE_CONTEXT_NO_RUNNING; else process.env.DC_DEVICE_CONTEXT_NO_RUNNING = '1';
  const m = await modules();
  const cfg = { allowedDirectories: [], ...config };
  m.settings.setConfigSource(() => cfg);
  await m.settings.refreshSettings();
  m.nudge._resetEpisodesForTests(); m.dc._resetForTests(); m.machine._resetMachineCachesForTests(); m.card._resetGitCacheForTests();
  const dcDir = path.join(H, '.claude-server-commander');
  return {
    H, dcDir, cfg, ...m,
    journalFile: path.join(dcDir, 'device-context-events.jsonl'),
    /** the journal as stored on disk */
    journal: () => readJsonl(path.join(dcDir, 'device-context-events.jsonl')),
    writeJournal: (rows) => fs.writeFileSync(path.join(dcDir, 'device-context-events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')),
    /** replace the config the way an edit of config.json would, and let device context read it */
    async setConfig(c) { for (const k of Object.keys(cfg)) delete cfg[k]; Object.assign(cfg, c); await m.settings.refreshSettings(); },
  };
}

export function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/** Make a folder with files (paths may contain subfolders). */
export function mk(p, files = {}) {
  fs.mkdirSync(p, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(p, f)), { recursive: true }); fs.writeFileSync(path.join(p, f), c); }
  return p;
}
/** A path quoted for a command line (temp folders can contain spaces). */
export const q = (p) => `"${p}"`;
export const ok = (t = '...') => ({ content: [{ type: 'text', text: t }] });
export const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same folder, however it is spelled (case on Windows/macOS, 8.3 names, /private on macOS). */
export function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const k = (p) => (process.platform === 'linux' ? real(p) : real(p).toLowerCase());
  return !!a && !!b && k(a) === k(b);
}

export const NOTE = /💡 (Recent work on this device|Projects Desktop Commander has seen)/;
/** The device-context block of a result (from its first line to the end of that block), or ''. */
export function blockOf(out) {
  const t = out.content.map((c) => c.text || '').join('\n');
  const m = t.match(NOTE);
  return m ? t.slice(m.index) : '';
}
/** A project's own numbered line on the card ("3. `root` — …"), not the "Last session" line that also names it. */
export const projectLine = (card, root) => String(card ?? '').split('\n').find((l) => /^\d+\. `/.test(l) && l.toLowerCase().includes('`' + root.toLowerCase() + '`')) ?? '';
/** How many content blocks of a result carry a device-context note. */
export const notesIn = (out) => out.content.filter((c) => NOTE.test(c.text || '')).length;

/** Checks: `check(name, cond, detail)`; `done()` prints "all passed" / "N FAILED" and exits. */
export function checker() {
  let fails = 0;
  const check = (name, cond, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
    if (!cond) { fails++; if (detail !== '') console.log('       ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900).replace(/\n/g, '\n       ')); }
  };
  const section = (s) => console.log(s);
  const done = () => { console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0); };
  return { check, section, done };
}
/** Non-empty and every item matches: `every()` alone passes on an empty list. */
export const allOf = (list, pred) => list.length > 0 && list.every(pred);

/**
 * A small HTTP server started from `cwd`, listening on a port the OS picks (no clash with ports in use).
 * Resolves once it is listening, with { port, pid, kill }; rejects if it exits first or does not start in time.
 */
export function startServer(cwd, { host = '127.0.0.1', port = 0, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const code = `const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(${Number(port)},${JSON.stringify(host)},()=>console.log('PORT '+s.address().port))`;
    const child = spawn(process.execPath, ['-e', code], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`fixture server did not start in ${timeoutMs} ms: ${out}`)); }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/PORT (\d+)/);
      if (m) { clearTimeout(timer); resolve({ port: Number(m[1]), pid: child.pid, kill: () => child.kill() }); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`fixture server exited (${c}) before listening: ${out}`)); });
  });
}
