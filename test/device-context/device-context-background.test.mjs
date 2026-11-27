// Building a card never waits for git / ss / docker: they run in the background and the card shows the last result.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
import { setup, mk, ok, checker } from './harness.mjs';

const t = await setup({ prefix: 'dcb-', running: true });
const { H, dc, card, rank, machine } = t;
const { check, done } = checker();
const repo = mk(path.join(H, 'code', 'app'), { 'package.json': '{"name":"app"}', 'a.txt': '1' });
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init'); fs.writeFileSync(path.join(repo, 'a.txt'), '2');
dc.observeToolCall('edit_block', { file_path: path.join(repo, 'a.txt'), old_string: '1', new_string: '2' }, ok('done'), false);
const rows = t.journal();
check('the edit was recorded', rows.length === 1 && rows[0].kind === 'edit', rows);
card._resetGitCacheForTests(); machine._resetMachineCachesForTests();
const t0 = performance.now();
const first = card.renderCard(rows, rank.rank(rows, new Date()), { now: new Date(), home: H });
const ms = performance.now() - t0;
// generous bound for slow CI machines; the real check is that the first card has no count yet (it didn't wait for git)
check('first card is built without waiting for git or ss', ms < 1000, `${ms.toFixed(0)} ms`);
check('first card lists the project but no count yet', !!first && first.includes(repo) && !/uncommitted change/.test(first), first);
await card.refreshUncommitted(repo); await machine.refreshRunningMap();
const second = card.renderCard(rows, rank.rank(rows, new Date()), { now: new Date(), home: H });
check('next card shows the count from the background check', /1 uncommitted change/.test(second), second);

// A .git from someone else must not make the background git status run a program. A filter driver runs when git
// re-reads a modified file; each case defines one where a check of .git/config alone would not see it.
// no system config here either (as in DC's own git calls): Git for Windows' core.autocrlf would change file sizes
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore', env: gitEnv });
const newRepo = (name) => { const r = mk(path.join(H, 'code', name), { 'a.txt': 'one\n' }); g(r, 'init', '-q'); g(r, 'add', '.'); g(r, 'commit', '-q', '-m', 'init'); return r; };
let n = 0;
/** Arm a repo: a.txt modified (same size, so git must read it) under a `filter=evil` attribute. Returns the filter's
 *  config text and the marker file it would write. */
function arm(r) {
  const marker = path.join(H, `marker-${++n}`);
  fs.writeFileSync(path.join(r, '.gitattributes'), '*.txt filter=evil\n');
  // same size as what is on disk: a size change alone tells git the file changed, without reading it (no filter)
  const before = fs.readFileSync(path.join(r, 'a.txt'));
  fs.writeFileSync(path.join(r, 'a.txt'), Buffer.from(before.toString('latin1').replace('one', 'two'), 'latin1'));
  // git config strips the outer double quotes; inside them ; and # are not comments
  return { marker, filter: `[filter "evil"]\n\tclean = "echo ran > '${marker.replace(/\\/g, '/')}' && cat"\n\trequired = false\n` };
}
const ranFilter = async (r, marker) => { card._resetGitCacheForTests(); await card.refreshUncommitted(r); return fs.existsSync(marker); };
{
  const r = newRepo('control'); const { marker, filter } = arm(r);
  fs.appendFileSync(path.join(r, '.git', 'config'), filter);
  try { execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', '-C', r, 'status', '--porcelain'], { stdio: 'ignore', env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1' } }); } catch { /* ignore */ }
  check('control: this setup really makes a plain git status run the filter', fs.existsSync(marker));
  fs.rmSync(marker, { force: true });
  check('filter in .git/config: not run', !(await ranFilter(r, marker)));
}
{
  const r = newRepo('worktree-config'); const { marker, filter } = arm(r);
  g(r, 'config', 'extensions.worktreeConfig', 'true');
  fs.writeFileSync(path.join(r, '.git', 'config.worktree'), filter);
  check('filter in .git/config.worktree: not run', !(await ranFilter(r, marker)));
}
{
  const r = newRepo('commondir'); const { marker, filter } = arm(r);
  const common = path.join(H, 'common-git'); fs.cpSync(path.join(r, '.git'), common, { recursive: true });
  fs.appendFileSync(path.join(common, 'config'), filter);
  fs.writeFileSync(path.join(r, '.git', 'commondir'), common + '\n');
  check('filter in the config of a .git/commondir: not run', !(await ranFilter(r, marker)));
}
{
  const r = newRepo('include'); const { marker, filter } = arm(r);
  const inc = path.join(H, 'included.gitconfig'); fs.writeFileSync(inc, filter);
  g(r, 'config', 'include.path', inc.replace(/\\/g, '/'));
  check('filter in an [include]d file: not run', !(await ranFilter(r, marker)));
}
{
  const sub = newRepo('sub-src');
  const r = newRepo('with-submodule');
  g(r, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replace(/\\/g, '/'), 'sub'); g(r, 'commit', '-q', '-m', 'sub');
  const { marker, filter } = arm(path.join(r, 'sub'));
  fs.appendFileSync(path.join(r, '.git', 'modules', 'sub', 'config'), filter);
  try { execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', '-C', r, 'status', '--porcelain', '--untracked-files=no'], { stdio: 'ignore', env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1' } }); } catch { /* ignore */ }
  check('control: a plain git status enters the submodule and runs its filter', fs.existsSync(marker));
  fs.rmSync(marker, { force: true });
  check('filter in a submodule\'s own config: not run (submodules are not entered)', !(await ranFilter(r, marker)));
}
{
  const r = newRepo('husky');
  g(r, 'config', 'core.hooksPath', '.husky');
  fs.writeFileSync(path.join(r, 'a.txt'), 'changed\n');
  card._resetGitCacheForTests(); await card.refreshUncommitted(r);
  const rows2 = [{ t: new Date().toISOString(), origin: 'local', root: r, kind: 'edit', file: 'a.txt' }];
  check('a repo with core.hooksPath (husky) still gets its count: hooks are off on the command line',
    /1 uncommitted change/.test(card.renderCard(rows2, rank.rank(rows2, new Date()), { now: new Date(), home: H }) ?? ''));
}
fs.rmSync(H, { recursive: true, force: true });
done();
