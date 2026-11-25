/**
 * Device context — wiring for server.ts.
 *
 * Mode (file ~/.claude-server-commander/device-context-mode, else env DESKTOP_COMMANDER_DEVICE_CONTEXT): off (default) | tool | nudge | both
 *   tool  = A: the get_device_context tool (+ one line in server instructions)
 *   nudge = B: append a short block to a tool result when the agent looks for a project blindly
 *   both  = A + B
 * Journal: ~/.claude-server-commander/device-context-events.jsonl (append-only, one clean row per touched project file;
 * no file contents, no command text, no secrets). Debug log of every decision when
 * DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG=1: device-context-debug.jsonl next to it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { observeEvent, failureAttributable, rank, render, renderTargeted, keyOf, isInside, redact, type JournalRow, type RankedProject } from './core.js';
import { classify, matchProjects, didYouMean, episodeFor, resetEpisode, RESTART_IDLE_MS } from './nudge.js';
import { renderCard, refreshUncommitted } from './card.js';
import { runningMap } from './machine.js';
import { capture } from '../utils/capture.js';

export type DeviceContextMode = 'off' | 'tool' | 'nudge' | 'both';

/** ~/.claude-server-commander/device-context-mode, read once per process. Wins over the env var: some clients
 *  (Claude Desktop) keep a server's env from when it was first added and ignore later config edits. */
let fileMode: string | null | undefined;
function modeFromFile(): string | null {
    if (fileMode === undefined) {
        try { fileMode = fs.readFileSync(path.join(process.env.DC_DEVICE_CONTEXT_HOME || os.homedir(), '.claude-server-commander', 'device-context-mode'), 'utf8').trim().toLowerCase() || null; }
        catch { fileMode = null; }
    }
    return fileMode;
}
export function _resetModeForTests() { fileMode = undefined; }

export function deviceContextMode(): DeviceContextMode {
    const v = String(modeFromFile() || process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT || 'off').toLowerCase();
    return v === 'tool' || v === 'nudge' || v === 'both' ? v : (v === '1' || v === 'true' || v === 'on' ? 'both' : 'off');
}
export const isDeviceContextToolEnabled = () => ['tool', 'both'].includes(deviceContextMode());
const isNudgeEnabled = () => ['nudge', 'both'].includes(deviceContextMode());
const isEnabled = () => deviceContextMode() !== 'off';
const debugOn = () => process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG === '1';

const home = () => process.env.DC_DEVICE_CONTEXT_HOME || os.homedir();
const dir = () => path.join(home(), '.claude-server-commander');
const journalFile = () => path.join(dir(), 'device-context-events.jsonl');
const contextFile = () => path.join(dir(), 'device-context.md');
const debugFile = () => path.join(dir(), 'device-context-debug.jsonl');
const now = () => (process.env.DC_DEVICE_CONTEXT_NOW ? new Date(process.env.DC_DEVICE_CONTEXT_NOW) : new Date());

/** Desktop Commander's own install folder is never a "project". */
const excludeRoots = (() => {
    try { return [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')]; } catch { return []; }
})();

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const COMPACT_AT_BYTES = 1024 * 1024;
const RETENTION_MS = 90 * 24 * 3600e3;
/** Projects listed in detail on the card; the rest go on one cheap line. */
const CARD_LIMIT = 5;
/** The remote backend does not expose new device tools yet, so do not point remote callers at get_device_context. */
const isRemote = (meta: any) => !!(meta && typeof meta === 'object' && meta.remote);
const toolVisible = (meta: any) => isDeviceContextToolEnabled() && !isRemote(meta);

/** The user's allowedDirectories from DC's config: never show folders outside them. */
let allowedCache: { at: number; value: string[] } | null = null;
function allowedDirs(): string[] {
    if (allowedCache && Date.now() - allowedCache.at < 60_000) return allowedCache.value;
    let value: string[] = [];
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir(), 'config.json'), 'utf8'));
        if (Array.isArray(cfg.allowedDirectories)) value = cfg.allowedDirectories.filter((x: unknown) => typeof x === 'string' && x).map((x: string) => x.replace(/^~(?=$|[\\/])/, home()));
    } catch { /* no config: no restriction */ }
    allowedCache = { at: Date.now(), value };
    return value;
}

function card(meta: any): string | null {
    const rows = readJournal();
    return renderCard(rows, rank(rows, now()), { now: now(), home: home(), limit: CARD_LIMIT, allowed: allowedDirs(), toolAvailable: toolVisible(meta) });
}

/** Projects the caller may see: still on disk and inside allowedDirectories (when set). */
function visibleRanking(rows = readJournal()): RankedProject[] {
    const allowed = allowedDirs();
    return rank(rows, now()).filter((r) => fs.existsSync(r.root) && (!allowed.length || allowed.some((a) => isInside(r.root, a))));
}

function appendLines(file: string, rows: object[]): void {
    if (!rows.length) return;
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.promises.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.appendFile(file, text, 'utf8'))
        .catch(() => { /* never break a tool call */ });
}

/**
 * First run: build the journal from Desktop Commander's existing tool history, so users who already
 * worked with DC get context right away. Runs once (the journal file then exists).
 */
let backfillDone = false;
function ensureJournal(): void {
    if (backfillDone) return;
    backfillDone = true;
    try {
        if (fs.existsSync(journalFile())) return;
        const hist = path.join(dir(), 'tool-history.jsonl');
        if (!fs.existsSync(hist)) return;
        const rows: JournalRow[] = [];
        let text = fs.readFileSync(hist, 'utf8');
        if (text.length > MAX_JOURNAL_BYTES) text = text.slice(text.length - MAX_JOURNAL_BYTES);
        for (const line of text.split('\n')) {
            if (!line) continue;
            let rec: any; try { rec = JSON.parse(line); } catch { continue; }
            if (!rec?.toolName || !rec.timestamp || rec.output?.isError || isUiCall(rec.arguments)) continue;
            rows.push(...observeEvent({ t: rec.timestamp, tool: rec.toolName, args: rec.arguments, origin: 'local' }, { home: home(), excludeRoots }).journal);
        }
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(journalFile(), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { flag: 'wx' });
        capture('server_device_context_backfill', { rows: rows.length });
    } catch { /* another process won the race, or no history */ }
}

let journalCache: { key: string; rows: JournalRow[] } | null = null;
function readJournal(): JournalRow[] {
    ensureJournal();
    let key = '';
    try { const st = fs.statSync(journalFile()); key = `${st.size}:${st.mtimeMs}`; } catch { return []; }
    if (journalCache && journalCache.key === key) return journalCache.rows;
    let text = '';
    try { text = fs.readFileSync(journalFile(), 'utf8'); } catch { return []; }
    if (text.length > MAX_READ_BYTES) text = text.slice(text.length - MAX_READ_BYTES); // compaction keeps it far below this
    const cutoff = Date.now() - RETENTION_MS;
    const rows: JournalRow[] = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        try {
            const r = JSON.parse(line);
            if (r && typeof r.root === 'string' && typeof r.t === 'string' && Date.parse(r.t) >= cutoff && ['read', 'edit', 'cmd'].includes(r.kind)) rows.push(r);
        } catch { /* skip a torn line */ }
    }
    if (text.length > COMPACT_AT_BYTES) compact(rows);
    journalCache = { key, rows };
    return rows;
}

/** Keep the journal small: rewrite it with the retained rows (atomic rename; a racing append may be lost, which is acceptable). */
let lastCompact = 0;
function compact(rows: JournalRow[]): void {
    if (Date.now() - lastCompact < 10 * 60_000) return;
    lastCompact = Date.now();
    try {
        const tmp = journalFile() + '.tmp-' + process.pid;
        // one row per (day, project, kind, file, verb) keeps every active day and file, drops repeats
        const keep = new Map<string, JournalRow>();
        for (const r of rows) {
            const k = [r.t.slice(0, 10), r.root, r.kind, r.file ?? '', r.verb ?? '', r.failed ? 1 : 0].join('|');
            const prev = keep.get(k);
            if (!prev || prev.t < r.t) keep.set(k, r);
        }
        const out = [...keep.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
        fs.writeFileSync(tmp, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.renameSync(tmp, journalFile());
    } catch { /* ignore */ }
}

/** Wipe everything device context remembers (for a future "forget" setting / tool). */
export function forgetDeviceContext(): void {
    // truncate (not delete): an existing journal means "do not rebuild it from tool history"
    try { fs.writeFileSync(journalFile(), ''); fs.rmSync(debugFile(), { force: true }); fs.rmSync(contextFile(), { force: true }); journalCache = null; } catch { /* ignore */ }
}

const isUiCall = (args: any) => !!(args && typeof args === 'object' && args.origin === 'ui');
const chatIdOf = (meta: any): string | null => {
    const v = meta && typeof meta === 'object' ? (meta['openai/session'] ?? meta.chatId ?? meta.conversationId) : null;
    return typeof v === 'string' && v ? v : null;
};

const resultTextOf = (result: any): string => (result?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('\n');
/** Uncaught errors that end a program (Node, Python, shells on Linux/Windows). */
const CRASH = /(^|\n)\s*(\w*Error|\w*Exception)\b[:\s]|Traceback \(most recent call last\)|\bENOENT\b|\bEADDRINUSE\b|Cannot find module|command not found|is not recognized as an internal or external command/;
/** A non-zero exit code, or a process that ended right after start with a crash in its output. */
export function failedOutput(text: string): boolean {
    // DC's own status lines win over anything the program printed ("... exit code 2" inside the output)
    const own = [...text.matchAll(/Process completed with exit code (-?\d+)|Execution failed \(exit code (-?\d+)\)/g)];
    // 130 Ctrl-C, 143 SIGTERM: stopped, not failed (124 timeout and 137 OOM-kill are real failures)
    const stopped = (c: string) => ['0', '130', '143'].includes(c);
    if (own.length) { const m = own[own.length - 1]; return !stopped(m[1] ?? m[2]); }
    if (/Process completed with signal/.test(text)) return false; // stopped on purpose
    const codes = [...text.matchAll(/exit(?:ed)? (?:with )?code:? (-?\d+)/gi)];
    const code = codes.length ? codes[codes.length - 1][1] : undefined;
    if (code !== undefined) return !stopped(code);
    return /has finished execution/.test(text) && CRASH.test(text);
}
/** PID -> the journal rows of the command that started it, so a later exit code can be attributed. */
const pidRows = new Map<number, JournalRow[]>();
function rememberPid(pid: number, rows: JournalRow[]) {
    pidRows.set(pid, rows.map(({ t, origin, root, sub, kind, file, verb }) => ({ t, origin, root, sub, kind, file, verb })));
    if (pidRows.size > 200) pidRows.delete(pidRows.keys().next().value as number);
}

/** Hook after a call ran: record which project it touched. Fire-and-forget, never throws. */
/**
 * The device's context as a readable file, like an AGENTS.md for the whole computer:
 * ~/.claude-server-commander/device-context.md. Same facts as the card (observed paths, verbs, file names; no file
 * contents, no command arguments, no secrets) plus one line about the machine. Any agent or person can read it,
 * also without calling a tool. Rewritten at most every 30 s after Desktop Commander activity and on get_device_context.
 */
export function writeContextFile(): string | null {
    try {
        const rows = readJournal();
        const card = renderCard(rows, rank(rows, now()), { now: now(), home: home(), limit: 10, allowed: allowedDirs(), toolAvailable: true });
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
            card ? card.split('\n').slice(1).join('\n') : 'No project activity recorded on this device yet.',
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

export function observeToolCall(name: string, args: any, result: any, isRemote: boolean): void {
    if (!isEnabled() || name === 'get_device_context' || isUiCall(args) || result?.isError) return;
    if (isNudgeEnabled()) runningMap();   // nudge/both: a note may be added soon, so warm the background map; returns at once
    try {
        ensureJournal();
        const { journal, dropped } = observeEvent({ t: now().toISOString(), tool: name, args, origin: isRemote ? 'remote' : 'local' },
            { home: home(), excludeRoots });
        // "npm test -> failed" is the most useful fact for picking work back up
        const text = resultTextOf(result);
        if (name === 'start_process' || name === 'interact_with_process') {
            const cmd = String((name === 'start_process' ? args?.command : args?.input) ?? '');
            const blame = failureAttributable(cmd);
            if (blame && failedOutput(text)) journal.forEach((r) => { if (r.verb) r.failed = true; });
            const pid = Number(name === 'interact_with_process' ? args?.pid : text.match(/PID (\d+)/)?.[1]);
            const withVerb = journal.filter((r) => r.verb);
            if (pid && withVerb.length && blame) rememberPid(pid, withVerb);
            else if (pid && !blame) pidRows.delete(pid); // a later exit code is no longer this verb's
        } else if (name === 'read_process_output' && args?.pid) {
            // The exit code of a started process often shows up only here, without the command: link it by PID
            const rows = pidRows.get(Number(args.pid));
            if (rows && failedOutput(text)) {
                const t = now().toISOString();
                journal.push(...rows.map((r) => ({ ...r, t, failed: true })));
                pidRows.delete(Number(args.pid));
            }
        } else if ((name === 'force_terminate' || name === 'kill_process') && args?.pid) {
            pidRows.delete(Number(args.pid)); // a process stopped on purpose exits non-zero; that is not a failed command
        }
        appendLines(journalFile(), journal);
        if (journal.length) scheduleContextFile();
        if (debugOn() && dropped.length) appendLines(debugFile(), dropped.map((d) => ({ ...d, event: 'dropped' })));
    } catch { /* ignore */ }
}

/** A: the get_device_context tool. */
export function handleGetDeviceContext(args: any, meta: any): { content: Array<{ type: 'text'; text: string }> } {
    const ep = episodeFor(chatIdOf(meta));
    ep.contextTool = true;
    ep.lastCallAt = Date.now();
    const ranking = visibleRanking();
    // Exact path as given (keyOf ignores case only where the file system does); lower case only for the name fallback
    const raw = typeof args?.project === 'string' ? args.project.trim() : '';
    const q = raw.toLowerCase();
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20);
    let text: string;
    if (q) {
        const hit = ranking.find((r) => keyOf(r.root) === keyOf(raw)) ?? matchProjects(ranking, [q, ...q.split(/[\s/\\]+/)])[0];
        text = render(ranking, { now: now(), home: home(), limit, project: hit?.root ?? raw });
    } else {
        // Same resume card as the safety net: last session, projects, what runs, what failed
        const rows = readJournal();
        text = renderCard(rows, rank(rows, now()), { now: now(), home: home(), limit, allowed: allowedDirs(), toolAvailable: true })
            ?? 'No project activity recorded on this device yet.';
    }
    if (!q) writeContextFile();
    capture('server_device_context_tool', { has_project_arg: String(!!q), projects_known: ranking.length });
    if (debugOn()) appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'tool', tool: 'get_device_context', text }]);
    return { content: [{ type: 'text', text }] };
}

/** One line for server instructions (clients that read them). */
export function deviceContextInstructions(): string {
    return isDeviceContextToolEnabled()
        ? '\n- In a new conversation, get_device_context lists the projects recently worked on on this device; it is cheaper than listing or searching directories to find them.'
        : '';
}

/** Key argument of a call, as short plain text (paths and commands only; secrets redacted). */
function keyArg(tool: string, a: any): string {
    if (!a || typeof a !== 'object') return '';
    const pick = a.path ?? a.file_path ?? (Array.isArray(a.paths) ? a.paths.slice(0, 3).join(', ') + (a.paths.length > 3 ? ` +${a.paths.length - 3}` : '') : undefined)
        ?? (a.source ? `${a.source} -> ${a.destination}` : undefined)
        ?? a.command ?? a.input ?? (a.pid !== undefined ? `pid ${a.pid}` : undefined) ?? a.pattern ?? a.sessionId ?? a.key ?? '';
    const extra = tool === 'start_search' && a.pattern && pick !== a.pattern ? ` "${a.pattern}"` : '';
    const one = redact(String(pick) + extra).replace(/\s+/g, ' ').trim();
    return one.length > 110 ? one.slice(0, 109) + '…' : one;
}

/** What happened, in a few words: ok, error with its first line, or a crash for processes. */
function outcome(tool: string, out: any): string {
    const text = (out?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('\n');
    const firstLine = (re: RegExp) => (text.split('\n').find((l: string) => re.test(l)) ?? '').trim().slice(0, 90);
    if (out?.isError) return `ERROR ${firstLine(/\S/) || ''}`.trim();
    if ((tool === 'start_process' || tool === 'interact_with_process' || tool === 'read_process_output') && failedOutput(text)) {
        const why = firstLine(/(Error|Exception|ENOENT|EADDRINUSE|exit code|not found|not recognized)/i);
        return `failed${why ? ': ' + why : ''}`;
    }
    const stop = text.match(/exit code (130|143)\b/);
    if (stop && (tool === 'start_process' || tool === 'interact_with_process' || tool === 'read_process_output')) return `stopped (exit ${stop[1]})`;
    if (tool === 'start_process' && /Process is running/.test(text)) return 'running';
    return 'ok';
}

/** Raw get_recent_tool_calls output ("summary\n\n[ ...json... ]") -> one line per call. Null when it does not parse. */
export function compactHistoryText(text: string): string | null {
    const at = text.indexOf('\n\n');
    if (at < 0) return null;
    let calls: any[];
    try { calls = JSON.parse(text.slice(at + 2)); } catch { return null; }
    if (!Array.isArray(calls)) return null;
    const head = text.slice(0, at).trim();
    const lines = calls.map((c) => {
        const when = String(c?.timestamp ?? '').replace('T', ' ').replace(/:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, '');
        const arg = keyArg(String(c?.toolName), c?.arguments);
        return `${when} ${c?.toolName ?? '?'}${arg ? ' ' + arg : ''} -> ${outcome(String(c?.toolName), c?.output)}`;
    });
    return `${head} (compact: one line per call; arguments and outputs left out. Full: get_recent_tool_calls with format "full", or read the files themselves)\n${lines.join('\n')}`;
}

/** Add the summary after the tool's own output as its own text block (never glued into file or command text). Returns a new result object. */
function appendNote(result: any, block: string): any {
    return { ...result, content: [...result.content, { type: 'text', text: block }] };
}

/**
 * B: after a call ran, maybe append a short device-context block to its result.
 * Returns a NEW result object (the original may already be queued for the history file).
 */
export function maybeAppendDeviceContext(name: string, args: any, result: any, meta: any): any {
    // Debug only (any mode, also off): how big the history answer is, so evals can compare off vs compact
    if (name === 'get_recent_tool_calls' && debugOn()) {
        try { appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'history_call', args, chars: (result?.content ?? []).reduce((n: number, c: any) => n + (c?.text?.length ?? 0), 0) }]); } catch { /* ignore */ }
    }
    const ep = isEnabled() ? episodeFor(chatIdOf(meta)) : null;
    try {
        if (!ep || !isNudgeEnabled() || isUiCall(args) || name === 'get_device_context' || !result || !Array.isArray(result.content)) return result;
        // get_config is "about this device": a natural place for the summary, and chats often call it first
        if (name === 'get_config') {
            if (!chatIdOf(meta) && !ep.located && Date.now() - ep.lastCallAt > RESTART_IDLE_MS && Date.now() - ep.lastShownAt > 15 * 60_000) resetEpisode(ep);
            if (result.isError || /^\s*Error/.test(result.content.find((c: any) => c?.type === 'text')?.text ?? '') || ep.general || ep.contextTool || ep.located) return result;
            const block = card(meta);
            if (!block) return result;
            ep.general = true; ep.lastShownAt = Date.now();
            if (debugOn()) appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'decision', tool: name, case: 'config', reason: 'device info requested', episode: ep.key, appended: 'general', text: block }]);
            capture('server_device_context_injected', { trigger_tool: name, case: 'config', block_type: 'general', chars: block.length });
            return appendNote(result, block); // structuredContent (the config widget) is left as is
        }
        if (result.structuredContent) return result; // keep widget/structured results untouched
        // A': models already call get_recent_tool_calls at the start of a chat ("what did we do?").
        // Put the compact project list on top of that answer: same moment, a fraction of the tokens.
        if (name === 'get_recent_tool_calls') {
            if (result.isError) return result;
            const content = [...result.content];
            const first = content[0];
            // C: one short line per call instead of full arguments and outputs (format: "full" keeps the old view)
            let compacted = false;
            if (args?.format !== 'full' && first?.type === 'text') {
                const compact = compactHistoryText(first.text ?? '');
                if (compact) { content[0] = { ...first, text: compact }; compacted = true; }
            }
            // A': the card on top. Asking for history is the clearest "new conversation" signal we get
            let block: string | null = null;
            // Without a chat id, a history call after a quiet spell is a new chat; with one, the episode already is the chat
            if (!chatIdOf(meta) && Date.now() - ep.lastCallAt > RESTART_IDLE_MS && Date.now() - ep.lastShownAt >= 60_000) resetEpisode(ep);
            if (!ep.general && !ep.contextTool) {
                block = card(meta);
                if (block) { ep.general = true; ep.lastShownAt = Date.now(); }
            }
            if (debugOn()) appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'decision', tool: name, case: 'history', reason: 'history tool called', episode: ep.key, appended: block ? 'general' : null, compacted, chars: { before: (first?.text ?? '').length, after: (content[0]?.text ?? '').length }, text: block }]);
            if (block) {
                capture('server_device_context_injected', { trigger_tool: name, case: 'history', block_type: 'general', chars: block.length });
                content.unshift({ type: 'text', text: block }); // its own block, above the history
            }
            return block || compacted ? { ...result, content } : result;
        }
        const cls = classify(name, args, result);
        // Exploration after a few quiet minutes is likely a new conversation, even without a chat id
        if (!chatIdOf(meta) && cls.discovery && !ep.located && Date.now() - ep.lastCallAt > RESTART_IDLE_MS && Date.now() - ep.lastShownAt > 15 * 60_000) resetEpisode(ep);
        let block: string | null = null;
        let type: 'general' | 'targeted' | null = null;
        if (cls.kind === 'exact') {
            ep.located = true;
        } else if (cls.kind === 'partial' || cls.kind === 'none') {
            const ranking = visibleRanking();
            const matched = cls.kind === 'partial' && !ep.located ? matchProjects(ranking, cls.terms).filter((r) => !ep.targeted.has(keyOf(r.root))) : [];
            if (matched.length) {
                const dym = cls.notFound ? matched.map((r) => didYouMean(cls.paths, r, fs.existsSync)).find(Boolean) ?? null : null;
                const fresh = !ep.general || !!dym || matched.some((r) => !ranking.slice(0, 5).includes(r));
                if (fresh) {
                    matched.forEach((r) => ep.targeted.add(keyOf(r.root)));
                    block = renderTargeted(matched, { now: now(), term: cls.terms.find((t) => matched.some((r) => path.basename(r.root).toLowerCase().includes(t))) ?? cls.terms[0], didYouMean: dym });
                    type = 'targeted';
                }
            } else if (cls.discovery && !ep.general && !ep.contextTool && !ep.located) {
                block = card(meta);
                if (block) { ep.general = true; ep.lastShownAt = Date.now(); type = 'general'; }
            }
        }
        if (debugOn() && cls.kind !== 'skip') {
            appendLines(debugFile(), [{ t: new Date().toISOString(), event: 'decision', tool: name, case: cls.kind, reason: cls.reason,
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

/** When DC starts with the feature on, start the background checks at once (they never block), so even the first
 *  summary of the first chat can say what runs and what is uncommitted. */
function warmAtStart(): void {
    if (!isEnabled() || process.env.DC_DEVICE_CONTEXT_NO_WARM === '1') return;
    const t = setTimeout(() => {
        try {
            runningMap();
            const rows = readJournal();
            for (const r of rank(rows, now()).slice(0, 10)) void refreshUncommitted(r.root);
        } catch { /* ignore */ }
    }, 0);
    t.unref?.();
}
warmAtStart();
