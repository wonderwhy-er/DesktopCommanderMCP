import fs from 'fs'; import os from 'os'; import path from 'path'; import { execSync } from 'child_process';
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'dch-'));
process.env.DC_DEVICE_CONTEXT_HOME = H; process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG = '1';
const mk = (p, files = {}) => { fs.mkdirSync(p, { recursive: true }); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(p, f)), { recursive: true }); fs.writeFileSync(path.join(p, f), c); } };
const code = path.join(H, 'code');
mk(path.join(code, 'full-stack-fastapi-template'), { '.git/HEAD': 'ref: refs/heads/master\n', 'compose.yml': 'x', 'backend/app/core/config.py': 'x', '.env': 'POSTGRES_PORT=5433' });
mk(path.join(code, 'express'), { '.git/HEAD': 'ref: refs/heads/master\n', 'package.json': '{}', 'Readme.md': '# express' });
mk(path.join(code, 'express-old-copy'), { 'package.json': '{}', 'Readme.md': '# old' });
mk(path.join(code, 'djangoproject.com'), { '.git/HEAD': 'ref: refs/heads/main\n', 'requirements/common.txt': 'Django==6.1.1', 'manage.py': '' });
const dc = await import('../../dist/device-context/index.js');
const nudge = await import('../../dist/device-context/nudge.js');
const ok = (r) => ({ content: [{ type: 'text', text: r }] });
const err = (r) => ({ content: [{ type: 'text', text: r }], isError: true });
// day 1 activity (observation)
const obs = [
  ['read_multiple_files', { paths: [`${code}/full-stack-fastapi-template/compose.yml`] }],
  ['edit_block', { file_path: `${code}/full-stack-fastapi-template/compose.yml`, old_string: 'a', new_string: 'b' }],
  ['edit_block', { file_path: `${code}/full-stack-fastapi-template/.env`, old_string: 'a', new_string: 'b' }],
  ['edit_block', { file_path: `${code}/full-stack-fastapi-template/compose.yml`, old_string: 'c', new_string: 'd' }],
  ['edit_block', { file_path: `${code}/full-stack-fastapi-template/backend/app/core/config.py`, old_string: 'c', new_string: 'd' }],
  ['start_process', { command: `cd ${code}/full-stack-fastapi-template && git diff --check` }],
  ['write_file', { path: `${code}/express/Readme.md`, content: 'x', mode: 'append' }],
  ['start_process', { command: `git -C ${code}/express status --short` }],
  ['start_process', { command: `cd ${code}/djangoproject.com && ls -la` }],
  ['read_file', { path: `${code}/express-old-copy/Readme.md` }],
  ['start_process', { command: `echo token=ghp_${'a'.repeat(36)} > /tmp/x` }],
];
for (const [t, a] of obs) dc.observeToolCall(t, a, ok('done'), true);
await new Promise((r) => setTimeout(r, 200));
const J = fs.readFileSync(path.join(H, '.claude-server-commander/device-context-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
let fails = 0; const check = (n, c, d = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '\n       ' + d)); if (!c) fails++; };
check('journal: 4 folders incl. the copy, .env only by name, no secret', new Set(J.map((r) => r.root)).size === 4 && !JSON.stringify(J).includes('ghp_'), JSON.stringify(J));
const call = (t, a, r = ok('...'), meta = {}) => { const out = dc.maybeAppendDeviceContext(t, a, r, meta); const txt = out.content.map((c) => c.text || '').join('\n'); const m = txt.match(/💡 (Recent work on this device|Projects Desktop Commander has seen)/); return { block: m ? txt.slice(m.index) : '', same: out === r }; };
const kind = (b) => !b ? 'none' : b.includes('Known project(s) matching') ? 'targeted' : 'general';
const fresh = () => nudge._resetEpisodesForTests();
console.log('ChatGPT-style shell exploration');
fresh(); let r = call('start_process', { command: "pwd; printf '\\nHome:\\n'; ls -la ~; printf '\\nTop-level:\\n'; ls -la /" });
check('pwd; ls ~; ls / -> general top-5', kind(r.block) === 'general', r.block);
check('fastapi ranked first (edits)', r.block.split('\n')[1]?.includes('full-stack-fastapi-template'), r.block);
r = call('start_process', { command: 'ls -la /srv /var/www' });
check('second blind call same episode -> nothing', kind(r.block) === 'none');
fresh(); r = call('start_process', { command: 'pwd; ls -la; python3 -m django --version' });
check('pwd; ls; python -m django -> general', kind(r.block) === 'general', r.block);
fresh(); r = call('start_process', { command: `find / -maxdepth 4 -type d -name '*fastapi*' 2>/dev/null` });
check('find / -name *fastapi* -> targeted fastapi', kind(r.block) === 'targeted' && r.block.includes('full-stack-fastapi-template'), r.block);
console.log('DC tools');
fresh(); r = call('start_search', { path: H, pattern: 'express', searchType: 'files' });
check('start_search home "express" -> targeted express', kind(r.block) === 'targeted' && r.block.includes(path.join(code, 'express')) && r.block.indexOf('old-copy') > r.block.indexOf(path.join(code, 'express') + '`') && /no git|git: /.test(r.block), r.block);
fresh(); r = call('read_file', { path: `${H}/projects/express/Readme.md` }, err(`Error: ENOENT: no such file or directory, open '${H}/projects/express/Readme.md'`));
check('missing ~/projects/express/Readme.md -> did you mean', r.block.includes(`Did you mean: \`${path.join(code, 'express', 'Readme.md')}\``), r.block);
fresh(); r = call('list_directory', { path: H, depth: 2 });
check('list_directory ~ -> general', kind(r.block) === 'general');
fresh(); r = call('read_file', { path: `${code}/express/Readme.md` });
check('read inside project -> nothing', kind(r.block) === 'none');
r = call('list_directory', { path: H });
check('after locating, list ~ -> nothing', kind(r.block) === 'none');
fresh(); r = call('list_directory', { path: path.join(H, 'Downloads'), depth: 1 });
check('ls ~/Downloads depth 1 -> nothing', kind(r.block) === 'none');
fresh(); r = call('start_process', { command: 'du -sh /* 2>/dev/null | sort -h | tail -20; df -h' });
check('control: disk usage -> nothing', kind(r.block) === 'none', r.block);
fresh(); dc.handleGetDeviceContext({}, {}); r = call('list_directory', { path: H });
check('after get_device_context, ls ~ -> nothing', kind(r.block) === 'none');
const tool = dc.handleGetDeviceContext({ project: 'express' }, {}).content[0].text;
check('get_device_context(project="express") -> express details', tool.includes(path.join(code, 'express')) && tool.includes('Readme.md'), tool);
console.log('episodes');
fresh(); process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_EPISODE_MIN = String(0.3 / 60); // 0.3 s
r = call('list_directory', { path: H }); check('first -> general', kind(r.block) === 'general');
r = call('list_directory', { path: '/' }); check('immediately again -> nothing', kind(r.block) === 'none');
await new Promise((res) => setTimeout(res, 400));
r = call('list_directory', { path: H }); check('after idle gap -> general again', kind(r.block) === 'general');
fresh(); r = call('list_directory', { path: H }, ok('x'), { 'openai/session': 'A' }); check('chat A -> general', kind(r.block) === 'general');
r = call('list_directory', { path: H }, ok('x'), { 'openai/session': 'B' }); check('chat B -> general', kind(r.block) === 'general');
r = call('list_directory', { path: H }, ok('x'), { 'openai/session': 'A' }); check('chat A again -> nothing', kind(r.block) === 'none');
delete process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_EPISODE_MIN;
console.log('safety');
fresh(); const orig = ok('listing'); const out = dc.maybeAppendDeviceContext('list_directory', { path: H }, orig, {});
check('original result object not mutated', orig.content[0].text === 'listing' && out !== orig);
fresh(); check('ui-origin call untouched', dc.maybeAppendDeviceContext('list_directory', { path: H, origin: 'ui' }, orig, {}) === orig);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'tool'; fresh();
check('mode=tool -> no append', dc.maybeAppendDeviceContext('list_directory', { path: H }, orig, {}) === orig);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'off'; fresh();
check('mode=off -> no append', dc.maybeAppendDeviceContext('list_directory', { path: H }, orig, {}) === orig);
console.log("A' (history tool)"); process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both';
fresh(); { const hr = { content: [{ type: 'text', text: 'Recent tool calls: ...' }] };
  const o = dc.maybeAppendDeviceContext('get_recent_tool_calls', { maxResults: 40 }, hr, {});
  check('get_recent_tool_calls -> block prepended', o.content.length === 2 && o.content[0].text.startsWith('💡 Recent work on this device') && o.content[1].text === 'Recent tool calls: ...', JSON.stringify(o.content).slice(0, 300));
  const r2 = call('list_directory', { path: H }); check('then ls ~ -> nothing (already shown)', kind(r2.block) === 'none');
  const o2 = dc.maybeAppendDeviceContext('get_recent_tool_calls', { maxResults: 40 }, hr, {}); check('second history call -> untouched', o2 === hr); }
console.log('\n--- sample general block ---'); process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; fresh();
console.log(call('list_directory', { path: H }).block.replaceAll(H, '~'));
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`); process.exit(fails ? 1 : 0);
