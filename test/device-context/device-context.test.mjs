// The note (nudge/both): which calls get the card, which get a targeted block, which get nothing; episodes; safety.
import fs from 'fs'; import path from 'path';
import { setup, mk, ok, err, q, wait, blockOf, checker } from './harness.mjs';

const t = await setup({ prefix: 'dch-', env: { DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG: '1' } });
const { H, dc, nudge } = t;
const { check, section, done } = checker();
const code = path.join(H, 'code');
const fastapi = mk(path.join(code, 'full-stack-fastapi-template'), { '.git/HEAD': 'ref: refs/heads/master\n', 'compose.yml': 'x', 'backend/app/core/config.py': 'x', '.env': 'POSTGRES_PORT=5433' });
const express = mk(path.join(code, 'express'), { '.git/HEAD': 'ref: refs/heads/master\n', 'package.json': '{}', 'Readme.md': '# express' });
const oldCopy = mk(path.join(code, 'express-old-copy'), { 'package.json': '{}', 'Readme.md': '# old' });
const django = mk(path.join(code, 'djangoproject.com'), { '.git/HEAD': 'ref: refs/heads/main\n', 'requirements/common.txt': 'Django==6.1.1', 'manage.py': '' });

// day 1 activity; command paths are quoted, so a temp folder with a space in it still works
for (const [tool, args] of [
  ['read_multiple_files', { paths: [path.join(fastapi, 'compose.yml')] }],
  ['edit_block', { file_path: path.join(fastapi, 'compose.yml'), old_string: 'a', new_string: 'b' }],
  ['edit_block', { file_path: path.join(fastapi, '.env'), old_string: 'a', new_string: 'b' }],
  ['edit_block', { file_path: path.join(fastapi, 'compose.yml'), old_string: 'c', new_string: 'd' }],
  ['edit_block', { file_path: path.join(fastapi, 'backend', 'app', 'core', 'config.py'), old_string: 'c', new_string: 'd' }],
  ['start_process', { command: `cd ${q(fastapi)} && git diff --check` }],
  ['write_file', { path: path.join(express, 'Readme.md'), content: 'x', mode: 'append' }],
  ['start_process', { command: `git -C ${q(express)} status --short` }],
  ['start_process', { command: `cd ${q(django)} && ls -la` }],
  ['read_file', { path: path.join(oldCopy, 'Readme.md') }],
  ['start_process', { command: `echo token=ghp_${'a'.repeat(36)} > /tmp/x` }],
]) dc.observeToolCall(tool, args, ok('done'), true);
const J = t.journal();
check('journal: 4 folders incl. the copy, .env only by name, no secret', new Set(J.map((r) => r.root.toLowerCase())).size === 4 && J.some((r) => r.file === '.env') && !JSON.stringify(J).includes('ghp_'), J);

const call = (tool, args, r = ok('...'), meta = {}) => { const out = dc.maybeAppendDeviceContext(tool, args, r, meta); return { block: blockOf(out), out, same: out === r }; };
const kind = (b) => (!b ? 'none' : b.includes('Known project(s) matching') ? 'targeted' : 'general');
const fresh = () => nudge._resetEpisodesForTests();

section('ChatGPT-style shell exploration');
fresh(); let r = call('start_process', { command: "pwd; printf '\\nHome:\\n'; ls -la ~; printf '\\nTop-level:\\n'; ls -la /" });
check('pwd; ls ~; ls / -> general top-5', kind(r.block) === 'general', r.block);
check('fastapi ranked first (edits)', r.block.split('\n').find((l) => /^\d\. /.test(l))?.includes('full-stack-fastapi-template'), r.block);
r = call('start_process', { command: 'ls -la /srv /var/www' });
check('second blind call same episode -> nothing', kind(r.block) === 'none');
fresh(); r = call('start_process', { command: 'pwd; ls -la; python3 -m django --version' });
check('pwd; ls; python -m django -> general', kind(r.block) === 'general', r.block);
fresh(); r = call('start_process', { command: `find / -maxdepth 4 -type d -name '*fastapi*' 2>/dev/null` });
check('find / -name *fastapi* -> targeted fastapi', kind(r.block) === 'targeted' && r.block.includes('full-stack-fastapi-template'), r.block);
fresh(); r = call('start_process', { command: `fd express ${q(H)}` });
check('fd PATTERN PATH -> targeted on the pattern', kind(r.block) === 'targeted' && r.block.includes(express), r.block);

section('DC tools');
fresh(); r = call('start_search', { path: H, pattern: 'express', searchType: 'files' });
check('start_search home "express" -> targeted express, exact name before the copy', kind(r.block) === 'targeted' && r.block.includes(express) && r.block.indexOf('old-copy') > r.block.indexOf(express + '`') && /no git|git: /.test(r.block), r.block);
fresh(); r = call('read_file', { path: path.join(H, 'projects', 'express', 'Readme.md') }, err(`Error: ENOENT: no such file or directory, open '${path.join(H, 'projects', 'express', 'Readme.md')}'`));
check('missing ~/projects/express/Readme.md -> did you mean', r.block.includes(`Did you mean: \`${path.join(express, 'Readme.md')}\``), r.block);
fresh(); r = call('start_process', { command: `cat ${q(path.join(H, 'projects', 'express', 'Readme.md'))}` }, ok(`cat: ${path.join(H, 'projects', 'express', 'Readme.md')}: No such file or directory`));
check('shell says a guessed path is missing -> did you mean', r.block.includes(`Did you mean: \`${path.join(express, 'Readme.md')}\``), r.block);
fresh(); r = call('list_directory', { path: H, depth: 2 });
check('list_directory ~ -> general', kind(r.block) === 'general');
fresh(); r = call('read_file', { path: path.join(express, 'Readme.md') });
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
check('get_device_context(project="express") -> express details', tool.includes(express) && tool.includes('Readme.md'), tool);

section('a project the card already showed is not repeated, one it left out is named');
fresh(); r = call('list_directory', { path: H });
check('card shown', kind(r.block) === 'general', r.block);
r = call('start_search', { path: H, pattern: 'fastapi' });
check('search for a project on the card -> nothing new', kind(r.block) === 'none', r.block);

section('episodes');
fresh(); process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_EPISODE_MIN = String(0.3 / 60); // 0.3 s
r = call('list_directory', { path: H }); check('first -> general', kind(r.block) === 'general');
r = call('list_directory', { path: '/' }); check('immediately again -> nothing', kind(r.block) === 'none');
await wait(400);
r = call('list_directory', { path: H }); check('after idle gap -> general again', kind(r.block) === 'general');
fresh(); r = call('list_directory', { path: H }, ok('x'), { 'openai/session': 'A' }); check('chat A -> general', kind(r.block) === 'general');
r = call('list_directory', { path: H }, ok('x'), { 'openai/session': 'B' }); check('chat B -> general', kind(r.block) === 'general');
r = call('list_directory', { path: H }, ok('x'), { 'openai/session': 'A' }); check('chat A again -> nothing', kind(r.block) === 'none');
delete process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_EPISODE_MIN;

section('safety');
fresh(); const orig = ok('listing'); const out = dc.maybeAppendDeviceContext('list_directory', { path: H }, orig, {});
check('original result object not mutated', orig.content.length === 1 && orig.content[0].text === 'listing' && out !== orig);
check('...and the note is its own block after the listing', out.content.length === 2 && out.content[0].text === 'listing' && kind(out.content[1].text) === 'general', out.content);
fresh(); check('ui-origin call untouched', dc.maybeAppendDeviceContext('list_directory', { path: H, origin: 'ui' }, orig, {}) === orig);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'tool'; fresh();
check('mode=tool -> no note', dc.maybeAppendDeviceContext('list_directory', { path: H }, orig, {}) === orig);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'off'; fresh();
check('mode=off -> no note', dc.maybeAppendDeviceContext('list_directory', { path: H }, orig, {}) === orig);

section('history tool');
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; fresh();
{
  const hr = ok('Recent tool calls: ...');
  const o = dc.maybeAppendDeviceContext('get_recent_tool_calls', { maxResults: 40 }, hr, {});
  check('get_recent_tool_calls -> card as its own block on top', o.content.length === 2 && o.content[0].text.startsWith('💡 Recent work on this device') && o.content[1].text === 'Recent tool calls: ...', o.content);
  const r2 = call('list_directory', { path: H }); check('then ls ~ -> nothing (already shown)', kind(r2.block) === 'none');
  const o2 = dc.maybeAppendDeviceContext('get_recent_tool_calls', { maxResults: 40 }, hr, {}); check('second history call -> untouched', o2 === hr);
}

section('debug log');
await wait(300); // written in the background
const dbg = fs.readFileSync(path.join(t.dcDir, 'device-context-debug.jsonl'), 'utf8');
check('debug log has no secret', !dbg.includes('ghp_'), dbg.slice(0, 300));

console.log('\n--- sample general block ---'); fresh();
console.log(call('list_directory', { path: H }).block.replaceAll(H, '~'));
done();
