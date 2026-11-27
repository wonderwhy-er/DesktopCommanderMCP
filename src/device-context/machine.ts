/**
 * Device context — what the machine has, beyond what Desktop Commander saw:
 *  - a one-line description of a project (manifest name/description, README title, git remote);
 *  - what is running: listening ports -> process -> its folder (Linux), nginx sites, docker compose projects.
 * Read-only, metadata only (no file contents beyond a manifest's name/description and a README's first heading).
 * Everything that runs a program or walks /proc is asynchronous and cached: building a card only reads the last
 * result and never waits for it.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { plainName, plainPhrase, redact } from './privacy.js';

// ---------- project description ----------
const descCache = new Map<string, { at: number; value: string | null }>();

function readSmall(file: string, max = 64 * 1024): string | null {
    try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > max) return null;
        return fs.readFileSync(file, 'utf8');
    } catch { return null; }
}

function fromPackageJson(root: string): string | null {
    const txt = readSmall(path.join(root, 'package.json'));
    if (!txt) return null;
    try { const j = JSON.parse(txt); return [plainName(j.name), plainPhrase(j.description)].filter(Boolean).join(': ') || null; }
    catch { return null; }
}

function fromPyproject(root: string): string | null {
    const txt = readSmall(path.join(root, 'pyproject.toml'));
    if (!txt) return null;
    const name = plainName(txt.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1]);
    const desc = plainPhrase(txt.match(/^\s*description\s*=\s*["']([^"']+)["']/m)?.[1]);
    return [name, desc].filter(Boolean).join(': ') || null;
}

function fromReadme(root: string): string | null {
    for (const f of ['README.md', 'readme.md', 'Readme.md', 'README.rst', 'README.txt', 'README']) {
        const txt = readSmall(path.join(root, f), 256 * 1024);
        if (!txt) continue;
        // only the title heading; prose lines are never shown
        for (const line of txt.split('\n').slice(0, 40)) {
            const m = line.match(/^#{1}\s+(.+?)\s*#*\s*$/);
            if (m && !/^\[?!\[/.test(m[1])) return plainPhrase(m[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), 60);
        }
        return null;
    }
    return null;
}

/** "github.com/owner/repo" from .git/config, credentials stripped. */
export function gitRemote(root: string): string | null {
    const cfg = readSmall(path.join(root, '.git', 'config'));
    if (!cfg) return null;
    const url = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
    if (!url) return null;
    const noScheme = url.replace(/^[a-z+]+:\/\//i, '');
    const host = noScheme.slice(noScheme.lastIndexOf('@', noScheme.indexOf('/') >= 0 ? noScheme.indexOf('/') : noScheme.length) + 1);
    const clean = host.replace(/:(?!\d)/, '/').replace(/\.git$/, '');
    return /^[\w.-]+(\/[\w.-]+){1,3}$/.test(clean) ? clean : null;
}

/** A short "what is this" line, e.g. `shop: Online store for handmade goods`. Secrets are redacted before it is
 *  cached, shown, or written to device-context.md. */
export function describeProject(root: string): string | null {
    const hit = descCache.get(root);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    let value = fromPackageJson(root) ?? fromPyproject(root) ?? fromReadme(root);
    const remote = gitRemote(root);
    if (remote && !(value ?? '').includes(path.basename(remote)) && (value ?? '').length + remote.length < 58) value = value ? `${value} (${remote})` : remote;
    if (value) value = redact(value.replace(/\s+/g, ' ')).slice(0, 120);
    descCache.set(root, { at: Date.now(), value: value ?? null });
    return value ?? null;
}

// ---------- what is running ----------
export interface RunningEntry {
    kind: 'port' | 'nginx' | 'docker';
    label: string;      // ":3000 node", "nginx config shop.example.com -> :3000 (nothing listening)", "docker shop-web-1 (exited)"
    dir?: string;       // folder it belongs to, when known
    down?: boolean;     // configured to run but not running / nothing listening
}

/** How much of what listens could be traced to a process:
 *  complete = every listening port has a visible owner, partial = some do, none = no port could be traced. */
export type Attribution = 'complete' | 'partial' | 'none';

let runCache: { at: number; value: RunningEntry[]; attribution: Attribution } | null = null;
const TIMEOUT = 800;

/** Runs a command without blocking the server (the MCP event loop keeps serving other calls meanwhile). */
export function runAsync(cmd: string, args: string[], timeout = TIMEOUT, env?: NodeJS.ProcessEnv): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            const child = execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, env, windowsHide: true },
                (err, stdout) => resolve(err ? null : String(stdout)));
            child.stdin?.end();
            // never keep DC alive at exit for a background check
            try { child.unref(); (child.stdout as any)?.unref?.(); (child.stderr as any)?.unref?.(); } catch { /* ignore */ }
        } catch { resolve(null); }
    });
}

/** Run `fn` over `items` with at most `limit` running at once. */
async function eachLimited<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]);
    }));
}

interface Listener { port: string; pid?: number; name: string }

async function cwdOf(pid: number): Promise<string | undefined> {
    try { const d = await fs.promises.readlink(`/proc/${pid}/cwd`); return d && d !== '/' ? d : undefined; } catch { return undefined; }
}

/** Linux without `ss`: listening sockets from /proc/net/tcp*, their owners from every process's fds.
 *  All reads are asynchronous, a few processes at a time: a process with thousands of fds never blocks the server. */
async function listenersFromProc(): Promise<Listener[]> {
    const inodes = new Map<string, string>();                                     // socket inode -> port
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let txt = ''; try { txt = await fs.promises.readFile(f, 'utf8'); } catch { continue; }
        for (const line of txt.split('\n').slice(1)) {
            const c = line.trim().split(/\s+/);
            if (c[3] !== '0A') continue;                                           // LISTEN
            inodes.set(c[9], String(parseInt(c[1].split(':')[1], 16)));
        }
    }
    if (!inodes.size) return [];
    const owners = new Map<string, number>();
    let pids: string[] = [];
    try { pids = (await fs.promises.readdir('/proc')).filter((x) => /^\d+$/.test(x)).slice(0, 2000); } catch { /* ignore */ }
    await eachLimited(pids, 8, async (pid) => {
        let fds: string[] = [];
        try { fds = await fs.promises.readdir(`/proc/${pid}/fd`); } catch { return; }
        for (const fd of fds) {
            if (owners.size === inodes.size) return;
            let l = ''; try { l = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`); } catch { continue; }
            const m = l.match(/^socket:\[(\d+)\]$/);
            if (m && inodes.has(m[1]) && !owners.has(m[1])) owners.set(m[1], Number(pid));
        }
    });
    const out: Listener[] = [];
    for (const [inode, port] of inodes) {
        const pid = owners.get(inode);
        let name = '?';
        if (pid) { try { name = (await fs.promises.readFile(`/proc/${pid}/comm`, 'utf8')).trim(); } catch { /* ignore */ } }
        out.push({ port, pid, name });
    }
    return out;
}

/** Linux: listening TCP sockets with their process (only processes this user may see have one). */
async function listeners(): Promise<Listener[]> {
    if (process.platform !== 'linux') return [];
    // DC_DEVICE_CONTEXT_NO_SS=1 (tests): use the /proc fallback even where ss exists
    const out = process.env.DC_DEVICE_CONTEXT_NO_SS === '1' ? null : await runAsync('ss', ['-ltnpH']);
    if (!out) return listenersFromProc();
    const res: Listener[] = [];
    for (const line of out.split('\n')) {
        const addr = line.trim().split(/\s+/)[3];
        if (!addr) continue;
        const port = addr.slice(addr.lastIndexOf(':') + 1);
        if (!/^\d+$/.test(port)) continue;
        const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        res.push({ port, pid: proc ? Number(proc[2]) : undefined, name: proc?.[1] ?? '?' });
    }
    return res;
}

/** Listening ports as entries: one per (port, folder), so two projects on one port (different addresses) stay
 *  two entries, while one server's IPv4 and IPv6 sockets are one. */
async function listeningPorts(): Promise<{ entries: RunningEntry[]; attribution: Attribution }> {
    const ls = await listeners();
    const seen = new Set<string>();
    const entries: RunningEntry[] = [];
    for (const l of ls) {
        const dir = l.pid ? await cwdOf(l.pid) : undefined;
        const key = `${l.port}|${dir ?? `pid:${l.pid ?? '?'}:${l.name}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ kind: 'port', label: `:${l.port} ${l.name}`, dir });
    }
    const owned = ls.filter((l) => l.pid).length;
    return { entries, attribution: !ls.length || !owned ? 'none' : owned === ls.length ? 'complete' : 'partial' };
}

function nginxDirs(): string[] {
    const env = process.env.DC_DEVICE_CONTEXT_NGINX_DIRS;
    return env ? env.split(path.delimiter) : ['/etc/nginx/sites-enabled', '/etc/nginx/conf.d'];
}

/** nginx config without comments (`#` to the end of the line, except inside quotes). */
export function stripNginxComments(txt: string): string {
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (quote) { if (c === '\\') { out += c + (txt[++i] ?? ''); continue; } if (c === quote) quote = null; out += c; continue; }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        if (c === '#') { const nl = txt.indexOf('\n', i); if (nl < 0) break; i = nl - 1; continue; }
        out += c;
    }
    return out;
}

/** nginx server blocks: domains + where they point (root folder or proxied local port). */
export function nginxSites(): Array<{ domains: string[]; root?: string; port?: string }> {
    const sites: Array<{ domains: string[]; root?: string; port?: string }> = [];
    for (const d of nginxDirs()) {
        let files: string[] = [];
        try { files = fs.readdirSync(d); } catch { continue; }
        for (const f of files.slice(0, 50)) {
            const raw = readSmall(path.join(d, f), 128 * 1024);
            if (!raw) continue;
            for (const block of stripNginxComments(raw).split(/\bserver\s*\{/).slice(1)) {
                const domains = (block.match(/server_name\s+([^;]+);/)?.[1] ?? '').split(/\s+/).filter((x) => x && x !== '_' && x !== 'localhost');
                const root = block.match(/(?:^|[\s;{])root\s+([^;]+);/)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
                const port = block.match(/proxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)/)?.[1];
                if (domains.length || root || port) sites.push({ domains, root, port });
            }
        }
    }
    return sites;
}

async function dockerProjects(): Promise<RunningEntry[]> {
    const out = await runAsync('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}\t{{.State}}']);
    if (!out) return [];
    return out.split('\n').filter(Boolean).slice(0, 30).map((l) => {
        const [name, dir, ports, state] = l.split('\t');
        const p = (ports ?? '').match(/:(\d+)->/)?.[1];
        const down = !!state && state !== 'running';
        return { kind: 'docker' as const, label: `docker ${name}${p ? ' :' + p : ''}${down ? ` (${state})` : ''}`, dir: dir || undefined, down };
    });
}

/** Everything running that we can attribute. Collected in the background (ss or /proc, docker ps, nginx configs)
 *  and cached for 30 s. */
let runRefresh: Promise<void> | null = null;
export function refreshRunningMap(): Promise<void> {
    if (process.env.DC_DEVICE_CONTEXT_NO_RUNNING === '1') return Promise.resolve();
    if (runRefresh) return runRefresh;
    runRefresh = (async () => {
        try {
            const [{ entries: ports, attribution }, docker] = await Promise.all([listeningPorts(), dockerProjects()]);
            const entries: RunningEntry[] = [...ports];
            for (const s of nginxSites()) {
                const viaPort = s.port ? ports.find((p) => p.label.startsWith(`:${s.port} `)) : undefined;
                const dir = s.root ?? viaPort?.dir;
                const dead = !!s.port && !viaPort && ports.length > 0;
                entries.push({ kind: 'nginx', label: `nginx config ${s.domains.slice(0, 2).join(' ') || '(default)'}${s.port ? ' → :' + s.port : ''}${dead ? ' (nothing listening)' : ''}`, dir, down: dead });
            }
            entries.push(...docker);
            runCache = { at: Date.now(), value: entries, attribution };
        } catch { /* keep the last value */ } finally { runRefresh = null; }
    })();
    return runRefresh;
}

/** The last collected map; starts a background refresh when it is missing or older than 30 s. Never waits. */
export function runningMap(): RunningEntry[] {
    if (process.env.DC_DEVICE_CONTEXT_NO_RUNNING === '1') return [];
    if (!runCache || Date.now() - runCache.at >= 30_000) void refreshRunningMap();
    return runCache?.value ?? [];
}
/** How complete the last port map was (see Attribution). */
export const portAttribution = (): Attribution => runCache?.attribution ?? 'none';

export function _resetMachineCachesForTests() { runCache = null; runRefresh = null; descCache.clear(); }
