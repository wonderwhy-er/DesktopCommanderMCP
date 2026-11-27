/**
 * Device context — the note (for clients that cannot see the get_device_context tool).
 *
 * Decides, from a tool call's name, arguments and result only, whether the agent is looking for a project it
 * does not know the path of:
 *   exact   - the call already works inside a project               -> nothing, the agent knows where it is
 *   partial - a search term or a missing path names a known project  -> a targeted line or two
 *   none    - blind exploration (listing home/root, broad find/ls, diagnosing services) -> the card
 *   skip    - anything else
 * and keeps per-episode state so a block is added at most once per episode. Desktop Commander has no chat id:
 * an episode is a chat when the client sends one in _meta, otherwise the calls between two idle gaps.
 */
import path from 'path';
import { parseCommandLine, commandsOf, baseName } from './shell.js';
import { findProject, isAbs, isInside, keyOf, norm, expandHome } from './projects.js';
import type { RankedProject } from './rank.js';
import { resultText } from './observe.js';
import { home } from './settings.js';

export type NudgeCase = 'exact' | 'partial' | 'none' | 'skip';
export interface Classification {
    kind: NudgeCase;
    reason: string;
    terms: string[];
    paths: string[];
    notFound: boolean;
    /** blind exploration or a guessed path that does not exist */
    discovery: boolean;
}

/** Folders whose listing means "I am looking for where things are". */
function broadDirs(): string[] {
    const h = home();
    const list = [h, path.dirname(h), '/', '/srv', '/var/www', '/opt', '/Users', '/home', 'C:\\', 'C:\\Users'];
    for (const d of ['projects', 'project', 'code', 'repos', 'repo', 'dev', 'src', 'workspace', 'work', 'git', 'github', 'Projects', 'Code', 'Developer', 'source']) list.push(path.join(h, d));
    return list;
}
const deepOnly = () => ['Desktop', 'Documents'].map((d) => path.join(home(), d)); // Downloads: tidying, not project hunting

const expand = (p: string) => expandHome(p, home());
const isBroad = (p: string) => broadDirs().some((b) => keyOf(b) === keyOf(p));
const isAtOrAboveHome = (p: string) => isInside(home(), p);

const NOT_FOUND = /ENOENT|no such file|not found|\[NOT_FOUND\]|cannot find (the )?path|does not exist/i;
/** A shell saying a path is missing ("ls: cannot access '/x': No such file or directory", "Cannot find path 'C:\x'"). */
const SHELL_MISSING = /no such file or directory|cannot find path|cannot access|does not exist|the system cannot find the (file|path)/i;
const GENERIC = new Set(['src', 'app', 'apps', 'lib', 'code', 'home', 'users', 'test', 'tests', 'main', 'index', 'config',
    'settings', 'readme', 'package', 'json', 'yml', 'yaml', 'docs', 'file', 'files', 'the', 'and', 'project', 'projects',
    'web', 'www', 'var', 'srv', 'opt', 'tmp', 'node', 'python', 'git', 'env', 'local', 'demo', 'root', 'data']);

export function tokensOf(s: string): string[] {
    return String(s || '').toLowerCase().replace(/\*|\.[a-z0-9]{1,5}$/g, '').split(/[^a-z0-9_-]+/)
        .flatMap((t) => [t, ...t.split(/[-_]/)]).filter((t) => t.length >= 3 && !GENERIC.has(t));
}

const SEARCH_CMD = new Set(['find', 'locate', 'mdfind', 'fd', 'fdfind', 'tree', 'plocate']);
/** "What is running / why is it broken" commands: the start of a diagnosis. */
const DIAG_CMD = new Set(['systemctl', 'service', 'journalctl', 'pm2', 'ss', 'netstat', 'lsof', 'ps', 'curl', 'wget', 'supervisorctl', 'docker', 'docker-compose',
    'nginx', 'apachectl', 'uptime', 'top', 'htop', 'get-service', 'get-process', 'tasklist', 'invoke-webrequest', 'iwr', 'test-netconnection', 'launchctl', 'brew']);
const LIST_CMD = new Set(['ls', 'dir', 'gci', 'get-childitem', 'll', 'la']);
const WEAK_CMD = new Set(['pwd', 'whoami', 'hostname', 'get-location', 'cd']);
/** fd's options that take a value: the first other word is the pattern, the rest are folders. */
const FD_VALUE_OPTS = new Set(['-e', '--extension', '-t', '--type', '-d', '--max-depth', '--min-depth', '--exact-depth', '-E', '--exclude',
    '-x', '--exec', '-X', '--exec-batch', '-S', '--size', '--changed-within', '--changed-before', '-j', '--threads', '-c', '--color',
    '--base-directory', '--search-path', '--max-results', '-o', '--owner', '--ignore-file']);
const SYSTEM_PLACES = ['/var/log', '/etc/nginx', '/etc/systemd', '/etc/apache2', '/etc/supervisor'];
const looksLikePath = (x: string) => isAbs(expand(x)) || x.startsWith('~') || x === '.' || x.startsWith('$HOME');

/** Inspect a shell command line: discovery signals, paths (as typed and expanded) and search terms. */
function inspectCommand(cmd: string): { strong: number; weak: number; paths: string[]; typed: string[]; terms: string[]; diag: boolean } {
    let strong = 0, weak = 0, diag = false;
    const paths: string[] = [], typed: string[] = [], terms: string[] = [];
    for (const c of commandsOf(parseCommandLine(cmd))) {
        const w = c.argv;
        if (!w.length) continue;
        const base = baseName(w[0]).toLowerCase();
        if (base === 'printf' || base === 'echo' || base === 'write-host' || base === 'write-output') continue;
        const rest = w.slice(1);
        const pathArgs = rest.filter((x) => !x.startsWith('-') && looksLikePath(x));
        typed.push(...pathArgs);
        paths.push(...pathArgs.map(expand).filter((p) => isAbs(p)));
        const nameIdx = rest.findIndex((x) => /^-i?(name|path|wholename)$/.test(x));
        if (nameIdx >= 0 && rest[nameIdx + 1]) terms.push(rest[nameIdx + 1]);
        if (SEARCH_CMD.has(base)) {
            const roots = pathArgs.length ? pathArgs.map(expand) : ['.'];
            if (roots.some((r) => r === '.' || isAtOrAboveHome(r) || isBroad(r))) strong++;
            else weak++;
            if (base === 'locate' || base === 'mdfind' || base === 'plocate') terms.push(...rest.filter((x) => !x.startsWith('-')));
            if (base === 'fd' || base === 'fdfind') {
                for (let i = 0; i < rest.length; i++) {
                    if (FD_VALUE_OPTS.has(rest[i])) { i++; continue; }
                    if (rest[i].startsWith('-')) continue;
                    terms.push(rest[i]);                                          // the pattern: fd PATTERN [PATH...]
                    break;
                }
            }
        } else if (LIST_CMD.has(base)) {
            const isRec = rest.some((x) => /^-\w*R/.test(x) || /^\/s$/i.test(x) || /^-Recurse$/i.test(x));
            const targets = pathArgs.map(expand);
            if (targets.some((t) => isBroad(t) || isAtOrAboveHome(t)) || (isRec && !targets.length)) strong++;
            else if (!targets.length) weak++;
        } else if (DIAG_CMD.has(base)) {
            strong++; diag = true;
        } else if (WEAK_CMD.has(base)) {
            weak++;
        } else if (/^(tail|cat|less|head|get-content)$/.test(base) && pathArgs.some((p) => SYSTEM_PLACES.some((s) => expand(p).startsWith(s)))) {
            strong++; diag = true;
        }
        if (/^python3?$/.test(base) && rest[0] === '-m' && rest[1] === 'django') weak++;   // asking the system instead of a project
    }
    return { strong, weak, paths, typed, terms, diag };
}

/** Classify one finished call. Pure apart from looking for project markers on disk. */
export function classify(tool: string, args: any, result: any): Classification {
    const a = args ?? {};
    const out = resultText(result);
    // "Not found" means the agent guessed a location only for looking tools; a failed write into a new folder is not a search
    const looking = !['write_file', 'edit_block', 'create_directory', 'move_file', 'write_pdf'].includes(tool);
    let notFound = looking && ((!!result?.isError && NOT_FOUND.test(out)) || /\[NOT_FOUND\]/.test(out));
    let paths: string[] = [];
    let terms: string[] = [];
    let blind = false, reason = '';

    switch (tool) {
        case 'list_directory': {
            const p = norm(expand(String(a.path ?? '.')));
            paths = [p];
            const depth = Number(a.depth ?? 2);
            if (isBroad(p) || p === norm('/') || SYSTEM_PLACES.some((s) => p === s || p.startsWith(s + '/'))) { blind = true; reason = 'listing a broad or system folder'; }
            // An empty folder (often the client's start folder): the agent has nothing to go on and will ask the user next
            else if (!result?.isError && out.trim() === '' && !findProject(p, home())) { blind = true; reason = 'listed an empty folder'; }
            else if (deepOnly().some((d) => keyOf(d) === keyOf(p)) && depth >= 2) { blind = true; reason = 'deep listing of a personal folder'; }
            break;
        }
        case 'start_search': {
            const p = a.path ? norm(expand(String(a.path))) : home();
            paths = [p];
            terms = [String(a.pattern ?? ''), String(a.filePattern ?? '')];
            if (isAtOrAboveHome(p) || isBroad(p)) { blind = true; reason = 'search from home or above'; }
            break;
        }
        case 'start_process': {
            const c = inspectCommand(String(a.command ?? ''));
            paths = c.paths; terms = c.terms;
            if (c.strong > 0 || c.weak >= 2) { blind = true; reason = c.diag ? 'diagnosing what runs (services, ports, logs)' : c.strong ? 'shell exploration of broad folders' : 'orientation commands (pwd/ls/whoami)'; }
            // A command's output says a path it was given is missing: the agent guessed where something is
            if (!notFound && c.typed.length) {
                const missing = out.split('\n').filter((l) => SHELL_MISSING.test(l));
                const named = [...c.typed, ...c.paths].filter((t) => t.length > 1);
                if (missing.some((l) => named.some((t) => l.includes(t)))) { notFound = true; reason = reason || 'guessed path not found'; }
            }
            break;
        }
        case 'read_file': case 'get_file_info': case 'read_multiple_files': case 'edit_block': case 'write_file':
            paths = [a.path, a.file_path, ...(Array.isArray(a.paths) ? a.paths : [])].filter((x) => typeof x === 'string').map((x: string) => norm(expand(x)));
            if (tool === 'read_file' && paths.some((p) => SYSTEM_PLACES.some((s) => p.startsWith(s)))) { blind = true; reason = 'reading system config or logs'; }
            break;
        default:
            return { kind: 'skip', reason: 'tool not considered', terms: [], paths: [], notFound, discovery: false };
    }

    if (!notFound) {
        const inProject = paths.find((p) => isAbs(p) && !isBroad(p) && findProject(p, home()));
        if (inProject) return { kind: 'exact', reason: 'already inside a project', terms, paths, notFound, discovery: false };
    }
    if (notFound) {
        for (const p of paths) terms.push(...p.split(/[\\/]/));
        reason = reason || 'guessed path not found';
    }
    const t = [...new Set(terms.flatMap(tokensOf))];
    const discovery = blind || notFound;
    if (t.length && (discovery || tool === 'start_search')) return { kind: 'partial', reason: reason || 'search term', terms: t, paths, notFound, discovery };
    if (discovery) return { kind: 'none', reason, terms: t, paths, notFound, discovery };
    return { kind: 'skip', reason: 'not a discovery call', terms: t, paths, notFound, discovery };
}

/** Projects whose folder name matches the terms. Exact names first. */
export function matchProjects(ranking: RankedProject[], terms: string[]): RankedProject[] {
    const strong: RankedProject[] = [], weak: RankedProject[] = [];
    for (const r of ranking) {
        const name = path.basename(r.root).toLowerCase();
        const parts = name.split(/[-_. ]+/);
        for (const t of terms) {
            if (name === t || name.replace(/[-_.]/g, '') === t.replace(/[-_.]/g, '')) { if (!strong.includes(r)) strong.push(r); }
            else if (parts.includes(t) || (t.length >= 4 && name.includes(t))) { if (!weak.includes(r)) weak.push(r); }
        }
    }
    return [...strong, ...weak.filter((w) => !strong.includes(w))].slice(0, 3);
}

/** "~/projects/crm/app/settings.py" -> "<root of crm>/app/settings.py" when that exists. */
export function didYouMean(paths: string[], project: RankedProject, exists: (p: string) => boolean): string | null {
    const name = path.basename(project.root).toLowerCase();
    for (const p of paths) {
        const segs = p.split(/[\\/]/);
        const i = segs.findIndex((s) => s.toLowerCase() === name);
        if (i < 0) continue;
        const cand = path.join(project.root, ...segs.slice(i + 1));
        if (keyOf(cand) !== keyOf(p) && exists(cand)) return cand;
    }
    return null;
}

// ---------- episodes ----------
export interface Episode {
    key: string;
    startedAt: number;
    lastCallAt: number;
    /** the card was shown */
    general: boolean;
    /** get_device_context was called */
    contextTool: boolean;
    /** the agent works inside a project */
    located: boolean;
    /** projects a targeted block already named */
    targeted: Set<string>;
    /** projects the card listed (keys): a targeted block for them would repeat it */
    shown: Set<string>;
    lastShownAt: number;
}

const episodes = new Map<string, Episode>();
export const episodeGapMs = () => Number(process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT_EPISODE_MIN || 10) * 60_000;

/** The episode a call belongs to. With a chat id: that chat. Without: the device, split by idle gaps. */
export function episodeFor(chatId: string | null, now = Date.now()): Episode {
    const key = chatId ? `chat:${chatId}` : 'device';
    let ep = episodes.get(key);
    if (ep && !chatId && now - ep.lastCallAt > episodeGapMs()) ep = undefined;
    if (!ep) {
        ep = { key, startedAt: now, lastCallAt: now, general: false, contextTool: false, located: false, targeted: new Set(), shown: new Set(), lastShownAt: 0 };
        episodes.set(key, ep);
        if (episodes.size > 500) episodes.delete(episodes.keys().next().value as string);
    }
    return ep;
}

export function _resetEpisodesForTests() { episodes.clear(); }

/** A new conversation often starts with exploration after a pause; treat that as a new episode even inside the idle window. */
export const RESTART_IDLE_MS = 3 * 60_000;
export function resetEpisode(ep: Episode, now = Date.now()) {
    ep.startedAt = now; ep.general = false; ep.contextTool = false; ep.located = false; ep.targeted.clear(); ep.shown.clear();
}
