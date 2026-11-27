// Unfinished work a week old vs a week of browsing other projects (the photo scenario that failed in ChatGPT),
// ranking of look-only days, gone folders, the empty start folder.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { setup, mk, checker } from './harness.mjs';

const t = await setup({ prefix: 'dc7-' });
const { H: home, rank, card, nudge } = t;
const { check, section, done } = checker();
const DAY = 86400e3, now = new Date('2026-11-22T21:00:00Z');
const at = (d) => new Date(now.getTime() - d * DAY).toISOString();
const proj = (name) => mk(path.join(home, 'code', name), { 'package.json': '{}' });
const render = (rows, limit = 5) => card.renderCard(rows, rank.rank(rows, now), { now, home, limit, running: [], attribution: 'none' });
const site = mk(path.join(home, 'public_html'), { 'index.php': '<?php', 'images/.keep': '' });
const rows = [];
// the job, 7 days ago: script written, a run that failed
rows.push({ t: at(7), root: site, kind: 'cmd', verb: 'npm install' }, { t: at(7), root: site, kind: 'edit', file: 'resize.js' }, { t: at(7), root: site, kind: 'cmd', verb: 'node', failed: true });
// a week of browsing 9 other projects: reads, git status/log, and one more command a day
const names = ['express', 'body-parser', 'fastapi', 'requests', 'httpx', 'shop', 'blog', 'django', 'cobra'];
names.forEach((n, i) => {
  const d = proj(n); const day = 6 - (i % 6) + 0.1;
  for (const v of ['git status', 'git log', 'ls']) rows.push({ t: at(day), root: d, kind: 'cmd', verb: v });
  for (let k = 0; k < 6; k++) rows.push({ t: at(day), root: d, kind: 'read', file: `f${k}.md` });
});

section('unfinished work stays on the card');
const text = render(rows);
const listed = card.cardRoots(text);
check('unfinished job a week old is listed on the card', listed.includes(path.normalize(site)), text);
check('...with its failed run', text.split('\n').some((l) => l.includes(site + '`') && /last run failed: `node`/.test(l)), text);
check('card still lists 5 projects', listed.length === 5, listed.join(', '));
const a = proj('a'), b = proj('b');
const r2 = rank.rank([{ t: at(1), root: a, kind: 'cmd', verb: 'git status' }, { t: at(1), root: b, kind: 'cmd', verb: 'npm test' }], now);
check('git status day < npm test day', r2.find((r) => r.root === a).dayScore < r2.find((r) => r.root === b).dayScore);
const c = proj('c');
const rows3 = [...rows.filter((r) => r.root !== site), { t: at(7), root: c, kind: 'cmd', verb: 'git status', failed: true }];
check('a failed look command (git status) does not pin', !card.cardRoots(render(rows3)).includes(path.normalize(c)));
const rows4 = [...rows.map((r) => (r.root === site ? { ...r, t: at(40) } : r)), ...names.map((n, i) => ({ t: at(1 + (i % 5)), root: path.join(home, 'code', n), kind: 'cmd', verb: 'npm test' }))];
check('unfinished older than a month is not pinned', !card.cardRoots(render(rows4)).includes(path.normalize(site)));
const sessRoots = ['s1', 's2', 's3', 's4'].map(proj);
const l5 = card.cardRoots(render([...rows, ...sessRoots.map((r) => ({ t: at(0.01), root: r, kind: 'edit', file: 'x.js' }))]));
check('4-project last session all stay, 1 pin fits', sessRoots.every((r) => l5.includes(path.normalize(r))) && l5.includes(path.normalize(site)), l5.join(', '));
const t6 = card.cardRoots(render(rows, 2));
check('limit 2: no pins, limit kept', t6.length === 2 && !t6.includes(path.normalize(site)), t6.join(', '));
check('a failed run without an edit before it (a stray probe) is not pinned', !card.cardRoots(render(rows.filter((r) => !(r.root === site && r.kind === 'edit')))).includes(path.normalize(site)));
// run A starts, run B starts and passes, then A's failure is reported (written with A's id and start time)
const jobA = (extra = []) => [...rows.filter((r) => r.root !== site), { t: at(7.2), root: site, kind: 'edit', file: 'resize.js' },
  { t: at(7.2), root: site, kind: 'cmd', verb: 'node', run: 'A' }, ...extra, { t: at(7.2), root: site, kind: 'cmd', verb: 'node', run: 'A', failed: true }];
check('control: a late failure with no newer run pins the job', card.cardRoots(render(jobA())).includes(path.normalize(site)), render(jobA()));
const withB = jobA([{ t: at(7.1), root: site, kind: 'cmd', verb: 'node', run: 'B' }]);
check('a late failure of an older run does not pin when a newer run passed', !card.cardRoots(render(withB)).includes(path.normalize(site)), render(withB));

section('an empty start folder is the moment the agent is lost');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dc7-empty-'));
const c1 = nudge.classify('list_directory', { path: empty }, { content: [] });
const c2 = nudge.classify('list_directory', { path: empty }, { content: [{ type: 'text', text: '' }] });
const c3 = nudge.classify('list_directory', { path: empty }, { content: [{ type: 'text', text: '[FILE] notes.txt' }] });
check('empty folder listing = discovery', c1.discovery && c2.discovery && c1.kind !== 'skip', [c1.kind, c2.kind]);
check('non-empty folder listing is not', !c3.discovery, c3.kind);

section('a project renamed outside DC');
const goneDir = path.join(home, 'code', 'renamed-shop');
const rowsG = [{ t: at(2), root: goneDir, kind: 'edit', file: '.env' }, { t: at(2), root: goneDir, kind: 'cmd', verb: 'node', failed: true }, ...rows.filter((r) => r.root !== site)];
const tG = render(rowsG);
check('"Folder no longer found" line with its facts', /Folder no longer found[^\n]*renamed-shop[^\n]*last change[^\n]*\.env[^\n]*last run failed: `node`/.test(tG), tG);
check('...and it is not listed as a live project', !card.cardRoots(tG).includes(path.normalize(goneDir)));
check('gone a month ago: not mentioned', !/Folder no longer found/.test(render([{ t: at(30), root: goneDir, kind: 'edit', file: '.env' }, ...rows])));
done();
