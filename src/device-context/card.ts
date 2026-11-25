/**
 * Device context — the "resume card": what a new chat needs to pick up work on this machine.
 *   last session (when, which project, what was edited / run)
 *   projects: what each one is, how it runs, when it last changed
 *   what else is running
 * Absolute UTC times and a "how to verify" hint, because models double-check memory against disk.
 * ~250–450 tokens.
 */
import path from 'path';
import fs from 'fs';
import { keyOf, isInside, safe, stackOf, gitFacts, findProject, isLookVerb, type JournalRow, type RankedProject } from './core.js';
import * as machine from './machine.js';
import { describeProject, runAsync, runningMap, type RunningEntry } from './machine.js';

const SESSION_GAP_MS = 30 * 60_000;

export const utc = (t: number | string) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

/** Count of uncommitted changes (git status --porcelain). Runs in the background and is cached for 60 s: the card
 * shows the last known count and never waits for git; a repo seen for the first time gets its count on the next card. */
const gitCache = new Map<string, { at: number; value: number | null }>();
const gitRunning = new Map<string, Promise<void>>();   // in-flight checks, so callers can wait for the same one
export function refreshUncommitted(root: string): Promise<void> {
    const running = gitRunning.get(root);
    if (running) return running;
    if (!fs.existsSync(path.join(root, '.git'))) { gitCache.set(root, { at: Date.now(), value: null }); return Promise.resolve(); }
    // Never let a repo's own config run code when we only want a count (fsmonitor, filters, hooks, or any of
    // those pulled in through [include] / [includeIf], which this text check can't follow)
    try { if (/fsmonitor|hookspath|\[filter|textconv|\bsshcommand|\[include/i.test(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'))) { gitCache.set(root, { at: Date.now(), value: null }); return Promise.resolve(); } }
    catch { gitCache.set(root, { at: Date.now(), value: null }); return Promise.resolve(); }
    const p = runAsync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', '-C', root, 'status', '--porcelain', '--untracked-files=no'],
        2000, { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
        .then((out) => { gitCache.set(root, { at: Date.now(), value: out === null ? null : out.split('\n').filter(Boolean).length }); })
        .finally(() => { gitRunning.delete(root); });
    gitRunning.set(root, p);
    return p;
}
function uncommitted(root: string): number | null {
    const hit = gitCache.get(root);
    if (!hit || Date.now() - hit.at > 60_000) void refreshUncommitted(root);
    return hit?.value ?? null;
}
export function _resetGitCacheForTests() { gitCache.clear(); gitRunning.clear(); }

/** Looks like something that is meant to run (a server/app), so "nothing running" is worth saying. */
function startable(root: string, verbs: Map<string, number>): boolean {
    if ([...verbs.keys()].some((v) => /^(pm2 (start|restart)|npm start|node|python3?|systemctl (start|restart)|docker compose up|docker run|uvicorn|gunicorn)/.test(v))) return true;
    try { if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))?.scripts?.start) return true; } catch { /* no package.json */ }
    return ['server.js', 'app.py', 'manage.py', 'main.py', 'Procfile', 'compose.yml', 'docker-compose.yml', 'compose.yaml'].some((f) => fs.existsSync(path.join(root, f)));
}
const shortAgo = (ms: number) => { const h = ms / 3600000; return h < 1 ? 'now' : h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`; };

/** The latest cluster of activity (rows closer than 30 min to each other). */
export function lastSession(rows: JournalRow[]): { start: number; end: number; byRoot: Map<string, { edited: Set<string>; verbs: Set<string>; failed: Set<string>; root: string }> } | null {
    if (!rows.length) return null;
    const sorted = [...rows].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    let i = sorted.length - 1;
    const end = Date.parse(sorted[i].t);
    let start = end;
    while (i > 0 && start - Date.parse(sorted[i - 1].t) < SESSION_GAP_MS) { i--; start = Date.parse(sorted[i].t); }
    const byRoot = new Map<string, { edited: Set<string>; verbs: Set<string>; failed: Set<string>; root: string }>();
    for (const r of sorted.slice(i)) {
        const k = keyOf(r.root);
        if (!byRoot.has(k)) byRoot.set(k, { edited: new Set(), verbs: new Set(), failed: new Set(), root: r.root });
        const e = byRoot.get(k)!;
        if (r.kind === 'edit' && r.file) e.edited.add(r.file);
        if (r.verb) { e.verbs.add(r.verb); if (r.failed) e.failed.add(r.verb); else e.failed.delete(r.verb); }
    }
    // read-only glances are noise in "last session" when there was real work
    if ([...byRoot.values()].some((e) => e.edited.size || e.verbs.size)) for (const [k, e] of byRoot) if (!e.edited.size && !e.verbs.size) byRoot.delete(k);
    return { start, end, byRoot };
}

/** Commands whose latest run in this project failed ("node", "npm test"): the first thing to check when "it's broken". */
function lastFailed(rows: JournalRow[], root: string): Array<{ verb: string; t: number }> {
    const k = keyOf(root);
    const latest = new Map<string, JournalRow>();
    for (const r of rows) if (r.verb && !isLookVerb(r.verb) && keyOf(r.root) === k) { const p = latest.get(r.verb); if (!p || r.t >= p.t) latest.set(r.verb, r); }
    return [...latest.values()].filter((r) => r.failed).map((r) => ({ verb: r.verb!, t: Date.parse(r.t) }));
}

/** Edited, then within a day a run failed, all within the last 30 days. */
function unfinished(rows: JournalRow[], root: string, nowMs: number): boolean {
    const k = keyOf(root);
    const edits = rows.filter((r) => r.kind === 'edit' && keyOf(r.root) === k).map((r) => Date.parse(r.t));
    return lastFailed(rows, root).some((f) => nowMs - f.t < 30 * 86400e3 && edits.some((e) => e <= f.t && f.t - e < 86400e3));
}

function lastChange(rows: JournalRow[], root: string): { t: number; file?: string } | null {
    const k = keyOf(root);
    let best: JournalRow | null = null;
    for (const r of rows) if (keyOf(r.root) === k && r.kind === 'edit' && (!best || r.t > best.t)) best = r;
    return best ? { t: Date.parse(best.t), file: best.file } : null;
}

export interface CardOptions {
    now: Date;
    home?: string;
    limit?: number;
    /** When set (remote callers with allowedDirectories), only folders inside these are shown. */
    allowed?: string[];
    toolAvailable?: boolean;
    running?: RunningEntry[];
    /** whether listening ports could be attributed to folders (only then "NOT running now" is trustworthy) */
    portsVisible?: boolean;
}

export function renderCard(rows: JournalRow[], ranking: RankedProject[], opts: CardOptions): string | null {
    const allowedOk = (p?: string) => !opts.allowed?.length ? true : !!p && opts.allowed.some((a) => isInside(p, a));
    const projects = ranking.filter((r) => fs.existsSync(r.root) && allowedOk(r.root)); // stable sort below keeps score order otherwise
    const running = (opts.running ?? runningMap()).filter((e) => allowedOk(e.dir));
    if (!projects.length && !running.length && !ranking.some((r) => !fs.existsSync(r.root))) return null;
    const nowMs = opts.now.getTime();
    const lines: string[] = [];
    // Worded like Desktop Commander's other notes (💡 tips), not like a system message
    lines.push(`💡 Recent work on this device, from Desktop Commander's record of earlier sessions; it may be out of date (now ${utc(nowMs)}, server tz ${tz()}). Check the files before relying on it.`);

    const sess = lastSession(rows.filter((r) => allowedOk(r.root)));
    // The last session's projects go first: "continue" almost always means the latest work
    if (sess) {
        const first = [...sess.byRoot.values()].sort((x, y) => (y.edited.size + y.verbs.size) - (x.edited.size + x.verbs.size)).map((e) => keyOf(e.root));
        projects.sort((x, y) => {
            const ix = first.indexOf(keyOf(x.root)), iy = first.indexOf(keyOf(y.root));
            return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
        });
    }
    if (sess) {
        const parts = [...sess.byRoot.values()].slice(0, 3).map((e) => {
            const bits = [safe(e.root, 100)];
            if (e.edited.size) bits.push(`edited ${[...e.edited].slice(0, 4).map((f) => safe(f, 50)).join(', ')}`);
            if (e.verbs.size) bits.push(`ran ${[...e.verbs].slice(0, 3).map((v) => safe(v, 30) + (e.failed.has(v) ? ' (failed)' : '')).join(', ')}`);
            return bits.join(' — ');
        });
        lines.push(`Last session: ${utc(sess.start)}–${utc(sess.end).slice(11)}: ${parts.join('; ')}`);
    }

    const limit = opts.limit ?? 5;
    // Unfinished work (its last run failed, within a month) stays on the card even when other projects
    // were busier since: "it never finished" is exactly what a later chat comes back for
    // ("unfinished" = within a month, something was edited and then, within a day, a run failed: a job, not a stray probe).
    // Never at the cost of the last session's projects; small cards get no pins.
    const top = projects.slice(0, limit);
    const sessN = sess ? projects.filter((r) => sess.byRoot.has(keyOf(r.root))).length : 0;
    const room = limit < 3 ? 0 : Math.max(0, Math.min(2, limit - Math.max(sessN, 1)));
    const pinned = room ? projects.filter((r) => !top.includes(r) && unfinished(rows, r.root, nowMs)).slice(0, room) : [];
    const shown = [...top.slice(0, limit - pinned.length), ...pinned];
    const usedRunning = new Set<RunningEntry>();
    if (shown.length) lines.push('Projects (last session first, then most active):');
    shown.forEach((r, i) => {
        const facts: string[] = [];
        const d = describeProject(r.root);
        if (d) facts.push(safe(d, 60));
        const st = stackOf(r.root); if (st) facts.push(st.split(' ')[0]);
        const g = gitFacts(r.root); facts.push(g ? `git ${safe(g.branch, 30)}` : 'no git');
        const label = path.basename(r.root).toLowerCase();
        // nginx sites without a folder: attach by name ("shop.example.com" -> ~/code/shop)
        const mine = running.filter((e) => (e.dir && isInside(e.dir, r.root)) || (!e.dir && e.kind === 'nginx' && label.length >= 3 && e.label.toLowerCase().includes(label.split(/[-_.]/)[0])));
        mine.forEach((e) => usedRunning.add(e));
        const up = mine.filter((e) => e.kind !== 'nginx' && !e.down);
        const conf = mine.filter((e) => e.kind === 'nginx' || e.down);
        if (up.length) facts.push(`running: ${up.slice(0, 3).map((e) => safe(e.label, 60)).join(', ')}`);
        else if ((opts.portsVisible ?? machine.portsVisible) && startable(r.root, r.verbs)) facts.push('NOT running now (no listening port from this folder)');
        if (conf.length) facts.push(conf.slice(0, 2).map((e) => safe(e.label, 70)).join(', '));
        const failed = lastFailed(rows, r.root);
        if (failed.length) facts.push(`last run failed: ${failed.slice(0, 2).map((f) => `${safe(f.verb, 30)} (${utc(f.t)})`).join(', ')}`);
        const u = uncommitted(r.root);
        if (u) facts.push(`${u} uncommitted change${u === 1 ? '' : 's'}`);
        const ch = lastChange(rows, r.root);
        facts.push(ch ? `last change ${utc(ch.t)}${ch.file ? ' ' + safe(ch.file, 40) : ''}` : `last active ${utc(r.last)}`);
        lines.push(`${i + 1}. ${safe(r.root, 110)} — ${facts.join(' · ')}`);
    });

    // Running things outside the listed projects: show only those that live in a project-like folder
    // (a service never touched through DC is exactly what "my shop is down" needs), skip shells/agents in $HOME
    const other = running.filter((e) => !usedRunning.has(e) && !(e.kind === 'docker' && e.down)).map((e) => {
        if (!e.dir) return e.kind === 'port' ? null : { e, where: null as string | null };
        if (opts.home && keyOf(e.dir) === keyOf(opts.home)) return null;
        const proj = findProject(e.dir, opts.home ?? '/');
        return proj ? { e, where: proj.root } : null;
    }).filter(Boolean) as Array<{ e: RunningEntry; where: string | null }>;
    if (other.length) lines.push(`Also on this machine: ${other.slice(0, 5).map(({ e, where }) => safe(e.label, 60) + (where ? ` in ${safe(where, 80)}` : '')).join('; ')}`);

    const rest = projects.filter((r) => !shown.includes(r)).slice(0, 8);
    const short = (p: string) => (opts.home && isInside(p, opts.home) ? '~/' + path.relative(opts.home, p).split(path.sep).join('/') : p);
    if (rest.length) lines.push(`Other known projects: ${rest.map((r) => `${safe(short(r.root), 60)} (${shortAgo(nowMs - r.last)})`).join(', ')}`);
    // Recent work whose folder is gone (renamed, moved or deleted outside DC). Dropping it silently leaves the model
    // with the other projects only; saying so tells it to look for the project under another name.
    const gone = ranking.filter((r) => !fs.existsSync(r.root) && allowedOk(r.root) && nowMs - r.last < 14 * 86400e3).map((r) => {
        const c = lastChange(rows, r.root), f = lastFailed(rows, r.root)[0];
        const facts = [c ? `last change ${utc(c.t)}${c.file ? ` ${safe(c.file, 40)}` : ''}` : '', f ? `last run failed: ${safe(f.verb, 30)}` : ''].filter(Boolean);
        return facts.length ? `${safe(short(r.root), 60)} (${facts.join(' · ')})` : null;
    }).filter(Boolean).slice(0, 2);
    if (gone.length) lines.push(`Folder no longer found (renamed, moved or deleted?): ${gone.join(', ')}`);
    if (lines.length === 1) return null; // nothing worth a card
    if (opts.toolAvailable) lines.push('More per project is available from get_device_context with project set to its path.');
    return lines.join('\n');
}

/** Used by tests and the replay: which roots the card lists, in order. */
export function cardRoots(card: string): string[] {
    return [...card.matchAll(/^\d+\. `([^`]+)`/gm)].map((m) => path.normalize(m[1]));
}
