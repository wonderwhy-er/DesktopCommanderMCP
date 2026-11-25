// Building a card never waits for git / ss / docker: they run in the background and the card shows the last result.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { execFileSync } from 'child_process'; import { pathToFileURL } from 'url';
const DIST = process.argv[2] || './dist';
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'dcb-'));
process.env.DC_DEVICE_CONTEXT_HOME = H; process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; process.env.DC_DEVICE_CONTEXT_NO_WARM = '1';
const repo = path.join(H, 'code', 'app'); fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"app"}'); fs.writeFileSync(path.join(repo, 'a.txt'), '1');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init'); fs.writeFileSync(path.join(repo, 'a.txt'), '2');
const imp = (m) => import(pathToFileURL(path.resolve(DIST, 'device-context', m)).href);
const dc = await imp('index.js'); const card = await imp('card.js'); const core = await imp('core.js'); const machine = await imp('machine.js');
dc.observeToolCall('edit_block', { file_path: path.join(repo, 'a.txt'), old_string: '1', new_string: '2' }, { content: [{ type: 'text', text: 'done' }] }, false);
await new Promise((r) => setTimeout(r, 300));
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) { failed++; if (detail) console.log('       ' + String(detail).slice(0, 400)); } };
const rows = fs.readFileSync(path.join(H, '.claude-server-commander', 'device-context-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
card._resetGitCacheForTests(); machine._resetMachineCachesForTests();
const t0 = performance.now();
const first = card.renderCard(rows, core.rank(rows, new Date()), { now: new Date(), home: H });
const ms = performance.now() - t0;
// generous bound for slow CI machines; the real check is that the first card has no count yet (it didn't wait for git)
check('first card is built without waiting for git or ss', ms < 1000, `${ms.toFixed(0)} ms`);
check('first card has no count yet', !/uncommitted change/.test(first), first);
await card.refreshUncommitted(repo); await machine.refreshRunningMap();
const second = card.renderCard(rows, core.rank(rows, new Date()), { now: new Date(), home: H });
check('next card shows the count from the background check', /1 uncommitted change/.test(second), second);
fs.rmSync(H, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
