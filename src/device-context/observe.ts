/**
 * Device context — one tool call -> clean journal rows (or the reasons it was dropped).
 *
 * Called right after the call ran, while the files it touched still exist. A row holds a project root, an
 * optional subfolder and file name, a kind (read / edit / cmd), an allow-listed verb, a time, and for
 * commands a run id and whether the run failed. Never command text, arguments or file contents.
 */
import fs from 'fs';
import path from 'path';
import { parseCommandLine, commandsOf, baseName } from './shell.js';
import { commandVerb, isCd, cdTarget } from './verbs.js';
import { findSecret, sensitivePath } from './privacy.js';
import { isAbs, expandHome, findProject, isInside, canonical } from './projects.js';

/** The text blocks of a tool result, joined. */
export function resultText(result: any): string {
    return (result?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('\n');
}

export type ActivityKind = 'read' | 'edit' | 'cmd';

/** One stored row. */
export interface JournalRow {
    t: string;
    origin: 'local' | 'remote';
    root: string;
    sub?: string;
    kind: ActivityKind;
    file?: string;
    verb?: string;
    /** one command run; a failure reported later (by PID) is written with the run's id and start time */
    run?: string;
    /** the command ran and exited non-zero */
    failed?: boolean;
}

export interface DroppedRow { t: string; tool: string; reason: string; preview: string }
export interface ToolEvent { t: string; tool: string; args: any; origin?: 'local' | 'remote' }

const READ_TOOLS = new Set(['read_file', 'read_multiple_files', 'get_file_info', 'list_directory', 'start_search']);
const EDIT_TOOLS = new Set(['write_file', 'edit_block', 'move_file', 'create_directory', 'write_pdf']);
export const CMD_TOOLS = new Set(['start_process', 'interact_with_process']);

function kindOf(tool: string): ActivityKind | null {
    if (EDIT_TOOLS.has(tool)) return 'edit';
    if (CMD_TOOLS.has(tool)) return 'cmd';
    if (READ_TOOLS.has(tool)) return 'read';
    return null;
}

/** The command text of a command tool call. */
export const commandOf = (tool: string, args: any): string => String((tool === 'start_process' ? args?.command : args?.input) ?? '');

function pathsFromArgs(tool: string, args: any): string[] {
    const a = args ?? {};
    switch (tool) {
        case 'read_file': return a.isUrl ? [] : [a.path];
        case 'read_multiple_files': return Array.isArray(a.paths) ? a.paths : [];
        case 'edit_block': return [a.file_path];
        case 'move_file': return [a.source, a.destination];
        case 'get_file_info': case 'list_directory': case 'create_directory':
        case 'write_file': case 'write_pdf': case 'start_search': return [a.path];
        default: return [];
    }
}

// unix paths stop at ':' (scp-style host:path, PATH-like lists); Windows drive letters are kept
const clip = (p: string) => (p.startsWith('/') || p.startsWith('~') ? p.split(':')[0] : p);
const DIR_OPTS = new Set(['-C', '--prefix', '--cwd', '--dir', '--project-directory', '--chdir', '--directory']);
const DIR_OPT_EQ = /^(--prefix|--cwd|--dir|--project-directory|--chdir|--directory)=(.+)$/;

/** Host side of a docker volume: "/host:/ctr:ro" -> /host, "C:\host:/ctr" -> C:\host, "data:/x" (named volume) -> null. */
function volumeHost(v: string | undefined): string | null {
    if (!v) return null;
    const host = /^[A-Za-z]:[\\/]/.test(v) ? v.slice(0, v.indexOf(':', 2) > 0 ? v.indexOf(':', 2) : v.length) : v.split(':')[0];
    return isAbs(host) || host.startsWith('~') ? host : null;
}
/** docker/podman: only host paths count (volumes, compose files, a build context); everything after the image
 *  name runs inside the container, where `/app` is not a folder on this machine. */
function dockerPaths(w: string[]): string[] {
    const out: string[] = [];
    const sub = w.find((x, i) => i > 0 && !x.startsWith('-'));
    for (let i = 1; i < w.length; i++) {
        const x = w[i];
        let v: string | null | undefined;
        if (x === '-v' || x === '--volume') v = volumeHost(w[++i]);
        else if (x.startsWith('--volume=')) v = volumeHost(x.slice(9));
        else if (x === '--mount' || x.startsWith('--mount=')) v = (x === '--mount' ? w[++i] : x.slice(8))?.match(/(?:^|,)(?:source|src)=([^,]+)/)?.[1];
        else if (['-f', '--file', '--project-directory', '--env-file'].includes(x)) v = w[++i];
        else if (sub === 'build' && i > 1 && !x.startsWith('-') && isAbs(x)) v = x;
        if (v && (isAbs(v) || v.startsWith('~'))) out.push(clip(v));
    }
    return out;
}

function pathsFromCommand(cmd: string): string[] {
    const found: string[] = [];
    for (const c of commandsOf(parseCommandLine(cmd))) {
        const w = c.argv;
        if (!w.length) continue;
        if (isCd(c)) { const t = cdTarget(c); if (t) found.push(clip(t)); continue; }
        const tool = baseName(w[0]).toLowerCase();
        if (tool === 'docker' || tool === 'podman') { found.push(...dockerPaths(w)); continue; }
        if (isAbs(w[0])) found.push(clip(w[0]));                                // a program inside a project: /p/node_modules/.bin/jest
        for (let i = 1; i < w.length; i++) {
            if (DIR_OPTS.has(w[i]) && w[i + 1]) { found.push(clip(w[++i])); continue; }
            const eq = w[i].match(DIR_OPT_EQ);
            if (eq) { found.push(clip(eq[2])); continue; }
            if (isAbs(w[i]) || /^~[\\/]/.test(w[i])) found.push(clip(w[i]));
        }
    }
    return found;
}

/** `p` relative to `root`, with the root in the file system's spelling and `p` possibly in another one
 *  (`~/code/shop/x.js` under the root `~/Code/Shop`); '' when it is not inside. */
function relInside(root: string, p: string): string {
    const full = canonical(p);
    const rel = path.relative(root, full);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    if (process.platform === 'linux') return '';
    // a file that does not exist (yet), under another case spelling of the root
    return full.toLowerCase().startsWith(root.toLowerCase() + path.sep) ? full.slice(root.length + 1) : '';
}

/** One tool call -> journal rows and dropped facts. Pure apart from looking at the touched paths on disk. */
export function observeEvent(ev: ToolEvent, opts: { home: string; excludeRoots?: string[] }): { journal: JournalRow[]; dropped: DroppedRow[] } {
    const journal: JournalRow[] = [];
    const dropped: DroppedRow[] = [];
    const kind = kindOf(ev.tool);
    if (!kind) return { journal, dropped };

    const isCmd = CMD_TOOLS.has(ev.tool);
    const cmd = isCmd ? commandOf(ev.tool, ev.args) : '';
    const candidates = (isCmd ? pathsFromCommand(cmd) : pathsFromArgs(ev.tool, ev.args)).filter(Boolean).map((p) => expandHome(String(p), opts.home));
    // Secrets are looked for only where we take data from: the command line and the paths.
    // File contents (edit_block/write_file) are never stored, so a secret inside them does not drop the row.
    const secret = findSecret(isCmd ? cmd : candidates.join('\n'));
    if (secret) {
        dropped.push({ t: ev.t, tool: ev.tool, reason: `secret: ${secret}`, preview: '(redacted)' });
        return { journal, dropped };
    }
    const verb = kind === 'cmd' ? commandVerb(cmd) : null;
    const seen = new Set<string>();
    for (const p of candidates) {
        if (!isAbs(p)) { dropped.push({ t: ev.t, tool: ev.tool, reason: 'relative path', preview: path.basename(p) }); continue; }
        const deny = sensitivePath(p);
        if (deny) { dropped.push({ t: ev.t, tool: ev.tool, reason: `sensitive path: ${deny}`, preview: path.basename(p) }); continue; }
        const proj = findProject(p, opts.home);
        if (!proj) { dropped.push({ t: ev.t, tool: ev.tool, reason: 'not inside a project', preview: path.basename(p) }); continue; }
        if ((opts.excludeRoots ?? []).some((x) => isInside(proj.root, x) || isInside(x, proj.root))) {
            dropped.push({ t: ev.t, tool: ev.tool, reason: 'Desktop Commander itself', preview: path.basename(proj.root) });
            continue;
        }
        if (/[\\/]node_modules([\\/]|$)/.test(proj.root)) { dropped.push({ t: ev.t, tool: ev.tool, reason: 'inside node_modules', preview: proj.root }); continue; }
        const inRoot = relInside(proj.root, p);
        let isFile = false;
        try { isFile = fs.statSync(p).isFile(); } catch { isFile = !!path.extname(p); }
        const row: JournalRow = { t: ev.t, origin: ev.origin ?? 'local', root: proj.root, kind };
        if (proj.sub) row.sub = path.relative(proj.root, proj.sub).split(path.sep).join('/');
        if (isFile && inRoot) row.file = inRoot.split(path.sep).join('/');
        if (verb) row.verb = verb;
        // `cd /p && node x` or `git -C /p status` name the same folder twice: one fact, one row
        const k = JSON.stringify(row);
        if (!seen.has(k)) { seen.add(k); journal.push(row); }
    }
    if (!journal.length && isCmd && !candidates.length) {
        dropped.push({ t: ev.t, tool: ev.tool, reason: 'command without a project path', preview: verb ?? '(verb not in allow-list)' });
    }
    return { journal, dropped };
}

// ---------- exit status ----------
/** Uncaught errors that end a program (Node, Python, shells on Linux/Windows). */
const CRASH = /(^|\n)\s*(\w*Error|\w*Exception)\b[:\s]|Traceback \(most recent call last\)|\bENOENT\b|\bEADDRINUSE\b|Cannot find module|command not found|is not recognized as an internal or external command/;
/** 130 Ctrl-C, 143 SIGTERM: stopped, not failed (124 timeout and 137 OOM-kill are real failures). */
const stopped = (c: string) => ['0', '130', '143'].includes(c);
/** DC's own status lines win over anything the program printed ("... exit code 2" inside the output). */
const OWN_EXIT = /Process completed with exit code (-?\d+)|Execution failed \(exit code (-?\d+)\)/g;

/** A non-zero exit code, or a process that ended right after start with a crash in its output. */
export function failedOutput(text: string): boolean {
    const own = [...text.matchAll(OWN_EXIT)];
    if (own.length) { const m = own[own.length - 1]; return !stopped(m[1] ?? m[2]); }
    if (/Process completed with signal/.test(text)) return false;              // stopped on purpose
    const codes = [...text.matchAll(/exit(?:ed)? (?:with )?code:? (-?\d+)/gi)];
    if (codes.length) return !stopped(codes[codes.length - 1][1]);
    return /has finished execution/.test(text) && CRASH.test(text);
}
/** The process is gone (any exit code): a PID seen later belongs to something else. */
export const exitedOutput = (text: string) => /Process completed with (exit code|signal)|has finished execution|Execution failed \(exit code/.test(text);
