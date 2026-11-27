/**
 * Device context — the one shell parser. Everything in device context that looks at a command line
 * (which project it works in, which verb it runs, whether a failure is that verb's, whether the agent is
 * searching) reads it through here, so they all agree on what the line does.
 *
 * Enough of POSIX sh, PowerShell and cmd.exe to say which commands a line runs, with which words, and how
 * they are joined: quotes, `&&` `||` `;` `&` and newlines, pipes, redirections, leading NAME=value
 * assignments, comments, wrappers (sudo, env, nohup, timeout, …) and shells run with a script
 * (`bash -lc '…'`, `cmd /c …`, `powershell -Command …`, read recursively).
 * What it does not model (subshells, $(…), backticks, heredocs, if/for/while, script blocks) marks the line
 * `complex`: its words are still read for paths and verbs, but no exit code is blamed on one command in it.
 */
import path from 'path';

export type ListOp = '&&' | '||' | ';' | '&';

export interface Command {
    /** the words after assignments and wrappers, redirections removed */
    argv: string[];
    /** names of leading NAME=value assignments (values are never kept) */
    assigns: string[];
    /** `bash -c '…'`, `cmd /c …`, `powershell -Command …`: the line it runs */
    inner?: CommandLine;
}
export interface Pipeline { commands: Command[] }
export interface ListItem { pipeline: Pipeline; after: ListOp | null }
/** Pipelines in order, each with the operator that follows it (null after the last one). */
export interface CommandLine { items: ListItem[]; complex: boolean }

type Token = { kind: 'word' | 'op' | 'redir'; text: string };
type Dialect = 'sh' | 'cmd';

/** `/usr/bin/node`, `C:\…\npm.cmd`, `node.exe` -> `node`, `npm` (case kept). */
export const baseName = (w: string) => path.posix.basename(String(w).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
const lower = (w: string) => baseName(w).toLowerCase();

// ---------- tokens ----------
function tokenize(src: string, dialect: Dialect): { tokens: Token[]; complex: boolean } {
    const tokens: Token[] = [];
    let complex = false;
    let cur = '';
    let inWord = false;
    const flush = () => { if (inWord) tokens.push({ kind: 'word', text: cur }); cur = ''; inWord = false; };
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === "'" && dialect === 'sh') {                                   // cmd.exe has no single quotes
            const end = src.indexOf("'", i + 1);
            inWord = true;
            if (end < 0) { cur += src.slice(i + 1); complex = true; break; }    // unterminated
            cur += src.slice(i + 1, end);
            i = end;
            continue;
        }
        if (c === '"') {
            inWord = true;
            let j = i + 1;
            for (; j < src.length && src[j] !== '"'; j++) {
                if (dialect === 'sh' && src[j] === '\\' && src[j + 1] === '"') { cur += '"'; j++; continue; }
                if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) complex = true;
                cur += src[j];
            }
            if (j >= src.length) complex = true;                               // unterminated
            i = j;
            continue;
        }
        if (c === '\\' && dialect === 'sh') {
            const n = src[i + 1];
            if (n === '\n') { i++; continue; }                                   // line continuation
            if (n === '\r' && src[i + 2] === '\n') { i += 2; continue; }
            // an escaped space or operator character; any other backslash is a Windows path separator (C:\Users\me)
            if (n !== undefined && /[\s;&|<>"'()$`#]/.test(n)) { cur += n; inWord = true; i++; continue; }
            cur += c; inWord = true;
            continue;
        }
        if (c === '`') { complex = true; cur += c; inWord = true; continue; }    // sh command substitution / PowerShell escape
        if (c === '$' && src[i + 1] === '(') {                                 // $(…) and $((…)): one opaque word
            complex = true;
            let depth = 0;
            let j = i + 1;
            for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
            cur += src.slice(i, j + 1); inWord = true; i = j;
            continue;
        }
        if (c === '#' && !inWord && dialect === 'sh') {                        // a comment, to the end of the line
            const nl = src.indexOf('\n', i);
            if (nl < 0) break;
            i = nl - 1;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\r') { flush(); continue; }
        if (c === '\n') { flush(); tokens.push({ kind: 'op', text: ';' }); continue; }
        if (c === '<' || c === '>') {
            // [n]> [n]>> [n]>& < <<: a number (or PowerShell's *) right before it belongs to the redirection
            let op = c;
            if (inWord && /^(\d+|\*)$/.test(cur)) { op = cur + c; cur = ''; inWord = false; } else flush();
            if (src[i + 1] === c) { op += c; i++; }
            if (src[i + 1] === '&') { op += '&'; i++; }
            if (op.endsWith('<<')) complex = true;                                // a heredoc body is not commands we can read
            tokens.push({ kind: 'redir', text: op });
            continue;
        }
        if (c === '&') {
            flush();
            if (src[i + 1] === '&') { tokens.push({ kind: 'op', text: '&&' }); i++; continue; }
            if (src[i + 1] === '>') {                                            // &> file, &>> file
                let op = '&>'; i++;
                if (src[i + 1] === '>') { op += '>'; i++; }
                tokens.push({ kind: 'redir', text: op });
                continue;
            }
            tokens.push({ kind: 'op', text: dialect === 'cmd' ? ';' : '&' });  // cmd.exe: & runs one command after another
            continue;
        }
        if (c === '|') {
            flush();
            if (src[i + 1] === '|') { tokens.push({ kind: 'op', text: '||' }); i++; continue; }
            if (src[i + 1] === '&') i++;                                         // |& pipes stderr too
            tokens.push({ kind: 'op', text: '|' });
            continue;
        }
        if (c === ';') { flush(); tokens.push({ kind: 'op', text: ';' }); continue; }
        if (c === '(' || c === ')') {
            complex = true;                                                      // a subshell or a PowerShell expression
            if (!inWord) { tokens.push({ kind: 'op', text: ';' }); continue; }
        }
        cur += c; inWord = true;
    }
    flush();
    return { tokens, complex };
}

// ---------- commands ----------
/** Wrappers that run the command after them, with their options that take a value. */
const WRAPPERS: Record<string, string[]> = {
    sudo: ['-u', '-g', '-p', '-C', '-D', '-h', '-r', '-t', '-U', '-T', '--user', '--group', '--prompt', '--chdir', '--host', '--role', '--type', '--other-user', '--close-from', '--command-timeout'],
    doas: ['-u', '-C'],
    nohup: [], time: ['-f', '-o', '--format', '--output'], exec: ['-a'], command: [], builtin: [],
    nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p', '-t'], stdbuf: ['-i', '-o', '-e'],
    env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
    timeout: ['-s', '--signal', '-k', '--kill-after'],
};
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that start shell control flow or a script block: the line is more than a list of commands. */
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', '{', '}', 'foreach', 'try', 'catch', 'finally']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const PS_VALUE_OPTS = new Set(['-executionpolicy', '-ep', '-windowstyle', '-outputformat', '-inputformat', '-configurationname', '-psconsolefile', '-version', '-workingdirectory', '-wd', '-settingsfile']);

function peelWrappers(argv: string[]): string[] {
    for (let guard = 0; guard < 8 && argv.length; guard++) {
        const base = lower(argv[0]);
        const opts = WRAPPERS[base];
        if (!opts) break;
        let i = 1;
        while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += opts.includes(argv[i]) ? 2 : 1;
        if (argv[i] === '--') i++;
        if (base === 'env') while (i < argv.length && ASSIGN.test(argv[i])) i++;
        if (base === 'timeout' && i < argv.length) i++;                         // the duration
        argv = argv.slice(i);
    }
    return argv;
}

/** Words handed to another shell as one line: one word as is, several re-quoted where they hold spaces. */
const rejoin = (ws: string[]) => (ws.length === 1 ? ws[0] : ws.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' '));

/** The line a shell is asked to run: `bash -lc '…'`, `cmd /c …`, `powershell -NoProfile -Command …`. */
function innerScript(argv: string[]): { script: string; dialect: Dialect } | 'unreadable' | null {
    if (!argv.length) return null;
    const base = lower(argv[0]);
    if (SHELLS.has(base)) {
        for (let i = 1; i < argv.length; i++) {
            if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(argv[i])) return argv[i + 1] !== undefined ? { script: argv[i + 1], dialect: 'sh' } : null;
            if (argv[i] === '-o' || argv[i] === '+o' || argv[i] === '-O' || argv[i] === '+O') { i++; continue; }
            if (!argv[i].startsWith('-')) return null;                           // `bash script.sh`: a file, not a line
        }
        return null;
    }
    if (base === 'cmd') {
        const i = argv.findIndex((w, k) => k > 0 && /^\/[ck]$/i.test(w));
        return i > 0 && i + 1 < argv.length ? { script: rejoin(argv.slice(i + 1)), dialect: 'cmd' } : null;
    }
    if (base === 'powershell' || base === 'pwsh') {
        for (let i = 1; i < argv.length; i++) {
            const w = argv[i].toLowerCase();
            if (w === '-command' || w === '-c') return i + 1 < argv.length ? { script: rejoin(argv.slice(i + 1)), dialect: 'sh' } : null;
            if (w === '-encodedcommand' || w === '-e' || w === '-ec') return 'unreadable';
            if (w === '-file' || w === '-f') return null;
            if (PS_VALUE_OPTS.has(w)) { i++; continue; }
            if (!w.startsWith('-')) return { script: rejoin(argv.slice(i)), dialect: 'sh' };  // `powershell "…"`: the rest is the command
        }
    }
    return null;
}

function toCommand(words: string[], depth: number, line: { complex: boolean }): Command {
    let i = 0;
    const assigns: string[] = [];
    while (i < words.length && ASSIGN.test(words[i])) { assigns.push(words[i].slice(0, words[i].indexOf('='))); i++; }
    const argv = peelWrappers(words.slice(i));
    if (argv.length && CONTROL.has(argv[0].toLowerCase())) line.complex = true;
    const cmd: Command = { argv, assigns };
    const inner = innerScript(argv);
    if (inner === 'unreadable') line.complex = true;
    else if (inner) {
        if (depth >= 3) line.complex = true;
        else {
            cmd.inner = parseWith(inner.script, inner.dialect, depth + 1);
            if (cmd.inner.complex) line.complex = true;
        }
    }
    return cmd;
}

function parseWith(src: string, dialect: Dialect, depth: number): CommandLine {
    const { tokens, complex } = tokenize(String(src ?? ''), dialect);
    const line: CommandLine = { items: [], complex };
    let commands: Command[] = [];
    let words: string[] = [];
    let skipNext = false;                                                        // the target of a redirection
    const endCommand = () => { if (words.length) commands.push(toCommand(words, depth, line)); words = []; };
    const endPipeline = (after: ListOp | null) => {
        endCommand();
        if (commands.length) line.items.push({ pipeline: { commands }, after });
        commands = [];
    };
    for (const t of tokens) {
        if (skipNext) { skipNext = false; if (t.kind === 'word') continue; }
        if (t.kind === 'redir') { skipNext = true; continue; }
        if (t.kind === 'word') { words.push(t.text); continue; }
        if (t.text === '|') { endCommand(); continue; }
        if (t.text === '&' && !words.length && !commands.length) continue;      // PowerShell's call operator: & "C:\…\node.exe" app.js
        endPipeline(t.text as ListOp);
    }
    endPipeline(null);
    return line;
}

const cache = new Map<string, CommandLine>();
/** Parse a command line (results are shared: treat them as read-only). */
export function parseCommandLine(src: string): CommandLine {
    const key = String(src ?? '');
    const hit = cache.get(key);
    if (hit) return hit;
    const line = parseWith(key, 'sh', 0);
    if (cache.size > 500) cache.clear();
    cache.set(key, line);
    return line;
}

/** Every command the line runs, in order; a shell run with a script is replaced by the script's commands. */
export function commandsOf(line: CommandLine): Command[] {
    return line.items.flatMap((it) => it.pipeline.commands.flatMap((c) => (c.inner ? commandsOf(c.inner) : [c])));
}

/** The line's pipelines with `bash -c '…'`-style wrappers opened, for reasoning about exit codes:
 *  a shell's exit code is its script's, so `bash -lc "cd /p && npm test"` reads as `cd /p && npm test`. */
export function flatItems(line: CommandLine): ListItem[] {
    const out: ListItem[] = [];
    for (const it of line.items) {
        const only = it.pipeline.commands.length === 1 ? it.pipeline.commands[0] : null;
        if (only?.inner?.items.length) {
            const inner = flatItems(only.inner);
            const last = inner[inner.length - 1];
            // `bash -c 'server &'` returns at once: a background job inside stays a background job
            inner[inner.length - 1] = { ...last, after: last.after === '&' ? '&' : it.after };
            out.push(...inner);
        } else out.push(it);
    }
    return out;
}
