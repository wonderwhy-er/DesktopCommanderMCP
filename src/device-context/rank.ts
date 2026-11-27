/**
 * Device context — ranking projects by recent work.
 *
 * Score = Σ per-day weight (a day with edits or real commands 1, a day of only looking 0.5) × a recency
 * multiplier of the last activity. Rows are grouped by project identity, so two spellings of one folder
 * rank as one project.
 */
import { projectKey } from './projects.js';
import { isLookVerb } from './verbs.js';
import type { JournalRow } from './observe.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function recencyMultiplier(ageMs: number): number {
    if (ageMs < HOUR) return 4;
    if (ageMs < DAY) return 2;
    if (ageMs < WEEK) return 0.5;
    return 0.25;
}

export interface RankedProject {
    root: string;
    /** identity of the project (see projectKey) */
    key: string;
    activeDays: number;
    dayScore: number;
    multiplier: number;
    score: number;
    last: number;
    files: Map<string, { count: number; last: number; edited: boolean }>;
    verbs: Map<string, number>;
    subs: Map<string, number>;
}

export function rank(journal: JournalRow[], now: Date): RankedProject[] {
    const byKey = new Map<string, { root: string; days: Map<string, number>; files: RankedProject['files']; verbs: Map<string, number>; subs: Map<string, number>; last: number; edits: number; cmds: number; runs: Set<string> }>();
    for (const e of journal) {
        const k = projectKey(e.root);
        let r = byKey.get(k);
        if (!r) { r = { root: e.root, days: new Map(), files: new Map(), verbs: new Map(), subs: new Map(), last: 0, edits: 0, cmds: 0, runs: new Set() }; byKey.set(k, r); }
        const t = Date.parse(e.t);
        // the latest spelling of a root is the one shown
        if (t >= r.last) r.root = e.root;
        const worked = e.kind === 'edit' || (e.kind === 'cmd' && !!e.verb && !isLookVerb(e.verb));
        const day = e.t.slice(0, 10);
        r.days.set(day, Math.max(r.days.get(day) ?? 0, worked ? 1 : 0.5));
        if (e.kind === 'edit') r.edits++;
        // a run's late failure row is the same run, not a second command
        const sameRun = !!e.run && r.runs.has(e.run);
        if (e.run) r.runs.add(e.run);
        if (e.kind === 'cmd' && e.verb && !isLookVerb(e.verb) && !sameRun) r.cmds++;
        r.last = Math.max(r.last, t);
        if (e.file) {
            const f = r.files.get(e.file);
            r.files.set(e.file, { count: (f?.count ?? 0) + 1, last: Math.max(f?.last ?? 0, t), edited: (f?.edited ?? false) || e.kind === 'edit' });
        }
        if (e.verb && !sameRun) r.verbs.set(e.verb, (r.verbs.get(e.verb) ?? 0) + 1);
        if (e.sub) r.subs.set(e.sub, (r.subs.get(e.sub) ?? 0) + 1);
    }
    const nowMs = now.getTime();
    return [...byKey.entries()].map(([key, r]) => {
        // Active days dominate; the amount of work within those days only breaks ties
        const dayScore = [...r.days.values()].reduce((a, b) => a + b, 0) + 0.25 * Math.log2(1 + r.edits) + 0.1 * Math.log2(1 + r.cmds);
        const multiplier = recencyMultiplier(nowMs - r.last);
        return { root: r.root, key, activeDays: r.days.size, dayScore, multiplier, score: +(dayScore * multiplier).toFixed(2), last: r.last, files: r.files, verbs: r.verbs, subs: r.subs };
    }).sort((a, b) => b.score - a.score || b.last - a.last);
}
