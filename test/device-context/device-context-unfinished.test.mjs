// Unfinished work a week old vs a week of browsing other projects (the photo scenario that failed in ChatGPT)
import fs from 'fs'; import os from 'os'; import path from 'path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc7-'));
process.env.DC_DEVICE_CONTEXT_NO_RUNNING = '1';
const core = await import('../../dist/device-context/core.js');
const card = await import('../../dist/device-context/card.js');
let fails = 0; const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : '  ' + String(info).slice(0, 500)}`); if (!ok) fails++; };
const DAY = 86400e3, now = new Date('2026-11-22T21:00:00Z');
const at = (d) => new Date(now.getTime() - d * DAY).toISOString();
const mk = (name, marker = 'package.json') => { const d = path.join(home, 'code', name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, marker), '{}'); return d; };
const site = path.join(home, 'public_html'); fs.mkdirSync(path.join(site, 'images'), { recursive: true }); fs.writeFileSync(path.join(site, 'index.php'), '<?php');
const rows = [];
// the job, 7 days ago: script written, a run that failed
rows.push({ t: at(7), root: site, kind: 'cmd', verb: 'npm install' }, { t: at(7), root: site, kind: 'edit', file: 'resize.js' }, { t: at(7), root: site, kind: 'cmd', verb: 'node', failed: true });
// a week of browsing 9 other projects: reads, git status/log, ls
const names = ['express', 'body-parser', 'fastapi', 'requests', 'httpx', 'shop', 'blog', 'django', 'cobra'];
names.forEach((n, i) => { const d = mk(n); const day = 6 - (i % 6) + 0.1;
  for (const v of ['git status', 'git log', 'ls']) rows.push({ t: at(day), root: d, kind: 'cmd', verb: v });
  for (let k = 0; k < 6; k++) rows.push({ t: at(day), root: d, kind: 'read', file: `f${k}.md` }); });
const ranking = core.rank(rows, now);
const text = card.renderCard(rows, ranking, { now, home, limit: 5, running: [], portsVisible: false });
const listed = card.cardRoots(text);
check('unfinished job a week old is listed on the card', listed.includes(path.normalize(site)), text);
check('...with its failed run', /public_html — .*last run failed: `?node/.test(text) || text.split('\n').some((l) => l.includes(site) && l.includes('last run failed')), text);
check('card still lists 5 projects', listed.length === 5, listed.join(', '));
// look-only commands rank as reading
const a = mk('a'), b = mk('b');
const r2 = core.rank([{ t: at(1), root: a, kind: 'cmd', verb: 'git status' }, { t: at(1), root: b, kind: 'cmd', verb: 'npm test' }], now);
check('git status day < npm test day', r2.find((r) => r.root === a).dayScore < r2.find((r) => r.root === b).dayScore);
// a failing look command (git status outside a repo) does not pin a project
const c = mk('c');
const rows3 = [...rows.filter((r) => r.root !== site), { t: at(7), root: c, kind: 'cmd', verb: 'git status', failed: true }];
const t3 = card.renderCard(rows3, core.rank(rows3, now), { now, home, limit: 5, running: [], portsVisible: false });
check('failed git status does not pin', !card.cardRoots(t3).includes(path.normalize(c)), t3);
// old unfinished (40 days) is not pinned
const rows4 = [...rows.map((r) => (r.root === site ? { ...r, t: at(40) } : r)), ...names.map((n, i) => ({ t: at(1 + (i % 5)), root: path.join(home, 'code', n), kind: 'cmd', verb: 'npm test' }))];
const t4 = card.renderCard(rows4, core.rank(rows4, now), { now, home, limit: 5, running: [], portsVisible: false });
check('unfinished older than a month is not pinned', !card.cardRoots(t4).includes(path.normalize(site)));

// verbs as commandVerb() really names them
const V = (c) => core.commandVerb(c);
check('git global options skipped', V('git --no-pager log --oneline -5') === 'git log' && V('git -C /p --no-pager diff') === 'git diff', V('git --no-pager log --oneline -5') + ' / ' + V('git -C /p --no-pager diff'));
check('docker compose options skipped', V('docker compose -f x.yml ps') === 'docker compose ps' && V('docker-compose logs web') === 'docker compose logs', V('docker compose -f x.yml ps') + ' / ' + V('docker-compose logs web'));
check('systemctl --user status', V('systemctl --user status shop') === 'systemctl status', V('systemctl --user status shop'));
check('real step wins over a trailing look', V('npm run build && git status') === 'npm build', V('npm run build && git status'));
check('look verbs are looks', ['git log', 'git status', 'npm outdated', 'docker compose ps', 'systemctl status'].every((v) => core.isLookVerb(v)) && !core.isLookVerb('npm test') && !core.isLookVerb('node'));
const A = core.failureAttributable;
check('failure attribution', A('cd /x && node resize.js') && !A('npm test 2>&1 | grep FAIL') && !A('systemctl restart shop && curl localhost') && !A('git status') && A('npm test || true') === false ? true : A('cd /x && node resize.js') && !A('npm test 2>&1 | grep FAIL') && !A('systemctl restart shop && curl localhost') && !A('git status'),
  [A('cd /x && node resize.js'), A('npm test 2>&1 | grep FAIL'), A('systemctl restart shop && curl localhost'), A('git status')].join(','));
const idx = await import('../../dist/device-context/index.js');
check('Ctrl-C / SIGTERM is not a failure; timeout and OOM-kill are', ['143', '130'].every((c) => !idx.failedOutput(`Process completed with exit code ${c}`)) && ['1', '124', '137'].every((c) => idx.failedOutput(`Process completed with exit code ${c}`)));
check('package manager / docker global options', V('npm --prefix /p test') === 'npm test' && V('pnpm -C /p run build') === 'pnpm build' && V('yarn --cwd /p build') === 'yarn build' && V('docker --context x compose up -d') === 'docker compose up' && V('docker -H x ps') === 'docker ps',
  [V('npm --prefix /p test'), V('pnpm -C /p run build'), V('yarn --cwd /p build'), V('docker --context x compose up -d'), V('docker -H x ps')].join(' | '));
check('a chain of real steps is not blamed on the last', !A('npm install && npm test') && A('cd /p && npm test') && A('export X=1 && node a.js'));
// pins never push the last session off the card
const sessRoots = ['s1', 's2', 's3', 's4'].map((n) => mk(n));
const rows5 = [...rows, ...sessRoots.map((r) => ({ t: at(0.01), root: r, kind: 'edit', file: 'x.js' }))];
const t5 = card.renderCard(rows5, core.rank(rows5, now), { now, home, limit: 5, running: [], portsVisible: false });
const l5 = card.cardRoots(t5);
check('4-project last session all stay, 1 pin fits', sessRoots.every((r) => l5.includes(path.normalize(r))) && l5.includes(path.normalize(site)), l5.join(', '));
const t6 = card.renderCard(rows, core.rank(rows, now), { now, home, limit: 2, running: [], portsVisible: false });
check('limit 2: no pins, limit kept', card.cardRoots(t6).length === 2 && !card.cardRoots(t6).includes(path.normalize(site)), card.cardRoots(t6).join(', '));
// a failure with no edit before it (a stray probe) is not "unfinished"
const rows7 = rows.filter((r) => !(r.root === site && r.kind === 'edit'));
const t7 = card.renderCard(rows7, core.rank(rows7, now), { now, home, limit: 5, running: [], portsVisible: false });
check('failed run without an edit is not pinned', !card.cardRoots(t7).includes(path.normalize(site)), card.cardRoots(t7).join(', '));

// an empty start folder is the moment the agent is lost: nudge mode shows the summary there
const nudgeMod = await import('../../dist/device-context/nudge.js');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dc7-empty-'));
const c1 = nudgeMod.classify('list_directory', { path: empty }, { content: [] });
const c2 = nudgeMod.classify('list_directory', { path: empty }, { content: [{ type: 'text', text: '' }] });
const c3 = nudgeMod.classify('list_directory', { path: empty }, { content: [{ type: 'text', text: '[FILE] notes.txt' }] });
check('empty folder listing = discovery', c1.discovery && c2.discovery && c1.kind !== 'skip', JSON.stringify([c1.kind, c2.kind]));
check('non-empty folder listing is not', !c3.discovery, c3.kind);

// a project renamed outside DC: say the folder is gone (with its facts) instead of dropping it silently
const goneDir = path.join(home, 'code', 'renamed-shop');
const rowsG = [{ t: at(2), root: goneDir, kind: 'edit', file: '.env' }, { t: at(2), root: goneDir, kind: 'cmd', verb: 'node', failed: true }, ...rows.filter((r) => r.root !== site)];
const tG = card.renderCard(rowsG, core.rank(rowsG, now), { now, home, limit: 5, running: [], portsVisible: false });
check('renamed project: "Folder no longer found" line with its facts', /Folder no longer found[^\n]*renamed-shop[^\n]*last change[^\n]*\.env[^\n]*last run failed: `node`/.test(tG), tG);
check('...and it is not listed as a live project', !card.cardRoots(tG).includes(path.normalize(goneDir)));
const rowsOld = [{ t: at(30), root: goneDir, kind: 'edit', file: '.env' }, ...rows];
check('gone a month ago: not mentioned', !/Folder no longer found/.test(card.renderCard(rowsOld, core.rank(rowsOld, now), { now, home, limit: 5, running: [], portsVisible: false })));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
