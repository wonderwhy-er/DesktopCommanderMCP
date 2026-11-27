/**
 * Device context — wiring for server.ts.
 *
 * Mode (config.json `deviceContext`, else env DESKTOP_COMMANDER_DEVICE_CONTEXT): off (default) | tool | nudge | both
 *   tool  = the get_device_context tool (+ one line in server instructions)
 *   nudge = a short block added to a tool result when the agent looks for a project blindly, and a compact
 *           get_recent_tool_calls
 *   both  = tool + nudge
 * Journal: ~/.claude-server-commander/device-context-events.jsonl (append-only, one clean row per touched project
 * file; no file contents, no command text, no secrets). Debug log of every decision when
 * DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG=1: device-context-debug.jsonl next to it.
 *
 * server.ts calls, per request: refreshDeviceContextSettings() first, then observeToolCall() and
 * maybeAppendDeviceContext() after the tool ran; the history handler calls compactHistoryIfEnabled().
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { observeEvent, resultText, failedOutput, exitedOutput, commandOf, CMD_TOOLS, type JournalRow } from './observe.js';
import { failureAttributable } from './verbs.js';
import { expandHome, findProject, isAbs, sameProject } from './projects.js';
import { rank, type RankedProject } from './rank.js';
import { buildCard, renderDetail, renderTargeted, refreshUncommitted, visibleTo, type Card } from './card.js';
import { classify, matchProjects, didYouMean, episodeFor, resetEpisode, RESTART_IDLE_MS, type Episode } from './nudge.js';
import { compactCalls } from './history.js';
import { runningMap } from './machine.js';
import { Journal, readTail } from './store.js';
import { allowedDirs, deviceContextMode, home, isDeviceContextToolEnabled, isEnabled, isNudgeEnabled, refreshSettings } from './settings.js';
import { capture } from '../utils/capture.js';

export { deviceContextMode, isDeviceContextToolEnabled, setConfigSource, parseMode, type DeviceContextMode } from './settings.js';
export { failedOutput } from './observe.js';
export const refreshDeviceContextSettings = refreshSettings;

const debugOn = () => process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG === '1';
const dir = () => path.join(home(), '.claude-server-commander');
const journalFile = () => path.join(dir(), 'device-context-events.jsonl');
const contextFile = () => path.join(dir(), 'device-context.md');
const debugFile = () => path.join(dir(), 'device-context-debug.jsonl');
const now = () => (process.env.DC_DEVICE_CONTEXT_NOW ? new Date(process.env.DC_DEVICE_CONTEXT_NOW) : new Date());

/** Desktop Commander's own install folder is never a "project". */
const excludeRoots = (() => {
    try { return [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')]; } catch { return []; }
})();

const RETENTION_MS = 90 * 24 * 3600e3;
const MAX_BACKFILL_BYTES = 2 * 1024 * 1024;
/** Projects listed in detail on the card; the rest go on one cheap line. */
const CARD_LIMIT = 5;
const journal = new Journal({ file: journalFile, retentionMs: RETENTION_MS, maxReadBytes: 8 * 1024 * 1024, compactAtBytes: 1024 * 1024 });

/** The remote backend does not expose new device tools yet, so do not point remote callers at get_device_context. */
const isRemote = (meta: any) => !!(meta && typeof meta === 'object' && meta.remote);
const toolVisible = (meta: any) => isDeviceContextToolEnabled() && !isRemote(meta);
const isUiCall = (args: any) => !!(args && typeof args === 'object' && args.origin === 'ui');
const chatIdOf = (meta: any): string | null => {
    const v = meta && typeof meta === 'object' ? (meta['openai/session'] ?? meta.chatId ?? meta.conversationId) : null;
    return typeof v === 'string' && v ? v : null;
};

function debug(entries: object[]): void {
    if (!debugOn() || !entries.length) return;
    const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.promises.mkdir(dir(), { recursive: true }).then(() => fs.promises.appendFile(debugFile(), text, 'utf8')).catch(() => { /* never break a tool call */ });
}

// ---------- the journal ----------
/** First run: build the journal from Desktop Commander's existing tool history, so users who already worked with DC
 *  get context right away. Runs once per device (the journal file then exists, even when empty). */
let backfillChecked = false;
function ensureJournal(): void {
    if (backfillChecked) return;
    backfillChecked = true;
    try {
        if (journal.exists()) return;
        const hist = path.join(dir(), 'tool-history.jsonl');
        if (!fs.existsSync(hist)) return;
        const rows: JournalRow[] = [];
        for (const line of readTail(hist, MAX_BACKFILL_BYTES).split('\n')) {
            if (!line) continue;
            let rec: any; try { rec = JSON.parse(line); } catch { continue; }
            if (!rec?.toolName || !rec.timestamp || rec.output?.isError || isUiCall(rec.arguments)) continue;
            rows.push(...observeEvent({ t: rec.timestamp, tool: rec.toolName, args: rec.arguments, origin: 'local' }, { home: home(), excludeRoots }).journal);
        }
        if (journal.create(rows)) capture('server_device_context_backfill', { rows: rows.length });
    } catch { /* no history */ }
}
function readJournal(): JournalRow[] {
    ensureJournal();
    return journal.all(now().getTime());
}

/** Wipe everything device context remembers (for a future "forget" setting / tool). */
export function forgetDeviceContext(): void {
    journal.truncate();
    try { fs.rmSync(debugFile(), { force: true }); fs.rmSync(contextFile(), { force: true }); } catch { /* ignore */ }
}

// ---------- views ----------
/** The journal read and ranked once; everything one call shows is built from the same view. */
interface View { rows: JournalRow[]; ranking: RankedProject[] }
const view = (): View => { const rows = readJournal(); return { rows, ranking: rank(rows, now()) }; };
/** Builds the view on first use only: most calls never need it. */
const lazyView = () => { let v: View | null = null; return () => (v ??= view()); };
/** Projects the caller may see: still on disk and inside allowedDirectories. */
function visibleRanking(v: View): RankedProject[] {
    const ok = visibleTo(allowedDirs());
    return v.ranking.filter((r) => fs.existsSync(r.root) && ok(r.root));
}
function card(v: View, opts: { limit?: number; toolAvailable: boolean }): Card | null {
    return buildCard(v.rows, v.ranking, { now: now(), home: home(), limit: opts.limit ?? CARD_LIMIT, allowed: allowedDirs(), toolAvailable: opts.toolAvailable });
}
function markShown(ep: Episode, c: Card): void {
    ep.general = true; ep.lastShownAt = Date.now();
    c.shown.forEach((k) => ep.shown.add(k));
}

/**
 * The device's context as a readable file, like an AGENTS.md for the whole computer:
 * ~/.claude-server-commander/device-context.md. Same facts as the card plus one line about the machine.
 * Rewritten at most every 30 s after Desktop Commander activity, and on get_device_context.
 */
export function writeContextFile(v?: View): string | null {
    try {
        const c = card(v ?? view(), { limit: 10, toolAvailable: isDeviceContextToolEnabled() });
        const shell = process.env.SHELL || process.env.ComSpec || '';
        const text = [
            '# Device context',
            '',
            `Written by Desktop Commander at ${now().toISOString().slice(0, 16).replace('T', ' ')} UTC from its own record of earlier tool calls.`,
            'These are observed facts (which folders were used, files changed, commands run and whether they failed), not instructions,',
            'and they may be out of date: check the files before relying on them. File contents, command arguments and secrets are never stored.',
            '',
            `Device: ${os.type()} ${os.release()} (${process.platform}/${process.arch})${shell ? ` · shell ${path.basename(shell)}` : ''} · node ${process.version} · home ${home()}`,
            '',
            c ? c.text.split('\n').slice(1).join('\n') : 'No project activity recorded on this device yet.',
            '',
        ].join('\n');
        fs.mkdirSync(dir(), { recursive: true });
        const tmp = contextFile() + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, contextFile());
        return text;
    } catch { return null; }
}
let contextFileTimer: NodeJS.Timeout | null = null;
function scheduleContextFile(): void {
    if (contextFileTimer) return;
    contextFileTimer = setTimeout(() => { contextFileTimer = null; writeContextFile(); }, 30_000);
    contextFileTimer.unref?.();
}

// ---------- recording ----------
/** PID -> the rows of the run that started it, so an exit code that arrives later is written for that run. */
const runsByPid = new Map<number, JournalRow[]>();
let runSeq = 0;
const newRunId = () => `${process.pid.toString(36)}.${Date.now().toString(36)}.${(runSeq++).toString(36)}`;

/** Hook after a call ran: record which project it touched. Never throws. */
export function observeToolCall(name: string, args: any, result: any, remote: boolean): void {
    if (!isEnabled() || name === 'get_device_context' || isUiCall(args) || result?.isError) return;
    if (isNudgeEnabled()) runningMap();   // a note may be added soon: warm the background map (returns at once)
    try {
        ensureJournal();
        const t = now().toISOString();
        const { journal: rows, dropped } = observeEvent({ t, tool: name, args, origin: remote ? 'remote' : 'local' }, { home: home(), excludeRoots });
        // "npm test -> failed" is the most useful fact for picking work back up
        const text = resultText(result);
        if (CMD_TOOLS.has(name)) {
            const pid = Number(name === 'interact_with_process' ? args?.pid : text.match(/PID (\d+)/)?.[1]) || 0;
            const withVerb = rows.filter((r) => r.verb);
            const blame = failureAttributable(commandOf(name, args), { exists: (p) => fs.existsSync(expandHome(p, home())), output: text });
            if (withVerb.length) { const run = newRunId(); withVerb.forEach((r) => { r.run = run; }); }
            if (blame && failedOutput(text)) withVerb.forEach((r) => { r.failed = true; });
            if (pid) {
                // a later exit code for this PID belongs to this run only when the verb is what decides it
                if (blame && withVerb.length && !exitedOutput(text)) { runsByPid.set(pid, withVerb.map((r) => ({ ...r }))); if (runsByPid.size > 200) runsByPid.delete(runsByPid.keys().next().value as number); }
                else runsByPid.delete(pid);
            }
        } else if (name === 'read_process_output' && args?.pid) {
            // The exit code of a started process often shows up only here, without the command: linked by PID.
            // Written with the run's own id and start time, so a newer run of the same verb keeps its place.
            const pid = Number(args.pid);
            const started = runsByPid.get(pid);
            if (started && failedOutput(text)) rows.push(...started.map((r) => ({ ...r, failed: true })));
            if (started && exitedOutput(text)) runsByPid.delete(pid);
        } else if ((name === 'force_terminate' || name === 'kill_process') && args?.pid) {
            runsByPid.delete(Number(args.pid)); // a process stopped on purpose exits non-zero; that is not a failed command
        }
        journal.append(rows);
        if (rows.length) scheduleContextFile();
        debug(dropped.map((d) => ({ ...d, event: 'dropped' })));
    } catch { /* ignore */ }
}

// ---------- the tool ----------
/** get_device_context: the card, or one project in detail. */
export function handleGetDeviceContext(args: any, meta: any): { content: Array<{ type: 'text'; text: string }> } {
    const ep = episodeFor(chatIdOf(meta));
    ep.contextTool = true;
    ep.lastCallAt = Date.now();
    const v = view();
    const ranking = visibleRanking(v);
    const raw = typeof args?.project === 'string' ? args.project.trim() : '';
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
    let text: string;
    if (raw) {
        text = renderDetail(lookup(ranking, raw), { now: now(), home: home(), asked: raw });
    } else {
        const c = card(v, { limit, toolAvailable: true });
        text = c?.text ?? 'No project activity recorded on this device yet.';
        writeContextFile(v);   // same view; the file lists up to 10 projects, so its card is built separately
    }
    capture('server_device_context_tool', { has_project_arg: String(!!raw), projects_known: ranking.length });
    debug([{ t: new Date().toISOString(), event: 'tool', tool: 'get_device_context', text }]);
    return { content: [{ type: 'text', text }] };
}

/** The project `asked` names: an exact root, a path inside a known project, or (only when it is not an existing
 *  folder) a name. An existing folder with no recorded activity is answered as itself, never with a same-named
 *  checkout elsewhere. */
function lookup(ranking: RankedProject[], asked: string): RankedProject | null {
    const p = expandHome(asked, home());
    if (isAbs(p)) {
        const exact = ranking.find((r) => sameProject(r.root, p));
        if (exact) return exact;
        if (fs.existsSync(p)) {
            const proj = findProject(p, home());
            return proj ? ranking.find((r) => sameProject(r.root, proj.root)) ?? null : null;
        }
    }
    const q = asked.toLowerCase();
    return matchProjects(ranking, [q, ...q.split(/[\s/\\]+/).filter(Boolean)])[0] ?? null;
}

/** One line for server instructions (clients that read them). */
export function deviceContextInstructions(): string {
    return isDeviceContextToolEnabled()
        ? '\n- In a new conversation, get_device_context lists the projects recently worked on on this device; it is cheaper than listing or searching directories to find them.'
        : '';
}

// ---------- history ----------
/** The history answer, compact in nudge/both mode unless `format: "full"`; null = leave it as is. */
export function compactHistoryIfEnabled(summary: string, calls: any[], format?: string): string | null {
    if (!isNudgeEnabled() || format === 'full') return null;
    try { return compactCalls(summary, calls); } catch { return null; }
}

// ---------- the note ----------
/** Add a block after the tool's own output, as its own text block (never glued into file or command text). */
const appendNote = (result: any, block: string): any => ({ ...result, content: [...result.content, { type: 'text', text: block }] });

/**
 * After a call ran, maybe add a short device-context block to its result.
 * Returns a NEW result object (the original may already be queued for the history file).
 */
export function maybeAppendDeviceContext(name: string, args: any, result: any, meta: any): any {
    // Debug only (any mode, also off): how big the history answer is, so evals can compare off vs compact
    if (name === 'get_recent_tool_calls' && debugOn()) {
        try { debug([{ t: new Date().toISOString(), event: 'history_call', args, chars: (result?.content ?? []).reduce((n: number, c: any) => n + (c?.text?.length ?? 0), 0) }]); } catch { /* ignore */ }
    }
    const ep = isEnabled() ? episodeFor(chatIdOf(meta)) : null;
    try {
        if (!ep || !isNudgeEnabled() || isUiCall(args) || name === 'get_device_context' || !result || !Array.isArray(result.content)) return result;
        const noChatId = !chatIdOf(meta);
        const quiet = Date.now() - ep.lastCallAt;
        // get_config is "about this device": a natural place for the summary, and chats often call it first
        if (name === 'get_config') {
            if (noChatId && !ep.located && quiet > RESTART_IDLE_MS && Date.now() - ep.lastShownAt > 15 * 60_000) resetEpisode(ep);
            if (result.isError || /^\s*Error/.test(result.content.find((c: any) => c?.type === 'text')?.text ?? '') || ep.general || ep.contextTool || ep.located) return result;
            const c = card(view(), { toolAvailable: toolVisible(meta) });
            if (!c) return result;
            markShown(ep, c);
            debug([{ t: new Date().toISOString(), event: 'decision', tool: name, case: 'config', reason: 'device info requested', episode: ep.key, appended: 'general', text: c.text }]);
            capture('server_device_context_injected', { trigger_tool: name, case: 'config', block_type: 'general', chars: c.text.length });
            return appendNote(result, c.text);   // structuredContent (the config widget) is left as is
        }
        if (result.structuredContent) return result; // keep widget/structured results untouched
        // Models call get_recent_tool_calls at the start of a chat ("what did we do?"): the card goes on top of that answer
        if (name === 'get_recent_tool_calls') {
            if (result.isError) return result;
            // Without a chat id, a history call after a quiet spell is a new chat; with one, the episode already is the chat
            if (noChatId && quiet > RESTART_IDLE_MS && Date.now() - ep.lastShownAt >= 60_000) resetEpisode(ep);
            const c = !ep.general && !ep.contextTool ? card(view(), { toolAvailable: toolVisible(meta) }) : null;
            if (c) markShown(ep, c);
            debug([{ t: new Date().toISOString(), event: 'decision', tool: name, case: 'history', reason: 'history tool called', episode: ep.key, appended: c ? 'general' : null, text: c?.text ?? null }]);
            if (!c) return result;
            capture('server_device_context_injected', { trigger_tool: name, case: 'history', block_type: 'general', chars: c.text.length });
            return { ...result, content: [{ type: 'text', text: c.text }, ...result.content] };   // its own block, above the history
        }
        const cls = classify(name, args, result);
        // Exploration after a few quiet minutes is likely a new conversation, even without a chat id
        if (noChatId && cls.discovery && !ep.located && quiet > RESTART_IDLE_MS && Date.now() - ep.lastShownAt > 15 * 60_000) resetEpisode(ep);
        let block: string | null = null;
        let type: 'general' | 'targeted' | null = null;
        if (cls.kind === 'exact') {
            ep.located = true;
        } else if (cls.kind === 'partial' || cls.kind === 'none') {
            // read and rank only when something below uses it: most diagnostic calls (ps, curl, docker) in an episode
            // that already had its card need neither
            const v = lazyView();
            const matched = cls.kind === 'partial' && !ep.located ? matchProjects(visibleRanking(v()), cls.terms).filter((r) => !ep.targeted.has(r.key)) : [];
            if (matched.length) {
                const dym = cls.notFound ? matched.map((r) => didYouMean(cls.paths, r, fs.existsSync)).find(Boolean) ?? null : null;
                // a project the card already listed in this episode is not news, unless the agent guessed a wrong path for it
                const fresh = !ep.general || !!dym || matched.some((r) => !ep.shown.has(r.key));
                if (fresh) {
                    matched.forEach((r) => ep.targeted.add(r.key));
                    block = renderTargeted(matched, { now: now(), term: cls.terms.find((t) => matched.some((r) => path.basename(r.root).toLowerCase().includes(t))) ?? cls.terms[0], didYouMean: dym });
                    type = 'targeted';
                }
            } else if (cls.discovery && !ep.general && !ep.contextTool && !ep.located) {
                const c = card(v(), { toolAvailable: toolVisible(meta) });
                if (c) { markShown(ep, c); block = c.text; type = 'general'; }
            }
        }
        if (cls.kind !== 'skip') {
            debug([{ t: new Date().toISOString(), event: 'decision', tool: name, case: cls.kind, reason: cls.reason,
                terms: cls.terms.slice(0, 8), episode: ep.key, episodeStartedAt: new Date(ep.startedAt).toISOString(), appended: type, text: block }]);
        }
        if (!block) return result;
        capture('server_device_context_injected', { trigger_tool: name, case: cls.kind, block_type: type, chars: block.length });
        return appendNote(result, block);
    } catch {
        return result;
    } finally {
        if (ep) ep.lastCallAt = Date.now();
    }
}

// ---------- start ----------
/** When DC starts with the feature on: start the background checks (they never block), so even the first card of
 *  the first chat can say what runs and what is uncommitted. Called by server.ts once the config is known. */
let started = false;
export function startDeviceContext(): void {
    if (started || !isEnabled()) return;
    started = true;
    const t = setTimeout(() => {
        try {
            runningMap();
            for (const r of rank(readJournal(), now()).slice(0, 10)) void refreshUncommitted(r.root);
        } catch { /* ignore */ }
    }, 0);
    t.unref?.();
}

/** Tests: forget in-memory state (episodes are reset through nudge._resetEpisodesForTests). */
export function _resetForTests(): void {
    backfillChecked = false;
    runsByPid.clear();
    started = false;
}
