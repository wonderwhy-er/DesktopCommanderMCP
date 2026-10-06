import { exec, execFile } from 'child_process';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';
import { VERSION } from '../../version.js';
import { deviceLogNames, getDeviceLogDir, cleanLine } from './device-log.js';
import { redact } from './redact.js';
import { savedUserId, uploadReport } from './upload.js';

/**
 * `desktop-commander remote --report`: a diagnostics zip a user sends to
 * support. It doesn't start the device and never opens sign-in, so it works
 * when sign-in is broken. After saving, it uploads the zip (upload.ts) unless
 * --no-upload, and prints the report id to give support.
 *
 * Only listed facts go in: versions (npm included), how Node runs (the Node
 * executable and the entry script, home folder as ~), the clock skew from the
 * server's Date header, network timings (server, Supabase REST, realtime
 * websocket), the device id and yes/no facts about the rest of device.json,
 * telemetryEnabled and clientId from config.json, and the device log
 * re-filtered and re-masked. Paths and error texts pass through redact().
 * Tokens, emails, the user name and tool arguments or results never go in.
 */

const DEFAULT_SERVER_URL = 'https://mcp.desktopcommander.app';
const CONNECT_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 5000;
const MCP_INFO_ROUNDS = 5;
const NPM_TIMEOUT_MS = 5000;
const PROCESS_LIST_TIMEOUT_MS = 10000;
/** The npm package, and the MCPB bundle (named from manifest.json). */
const PACKAGE_NAMES = new Set(['@wonderwhy-er/desktop-commander', 'desktop-commander']);
/** `desktop-commander <these>` is not the MCP server. */
const NOT_THE_SERVER = new Set(['remote', 'setup', 'remove']);
/** A rotated log file is 1 MB at most; read no more than this of a larger one. */
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;

type NodeKind = 'nvm' | 'fnm' | 'Volta' | 'asdf' | 'mise' | 'Homebrew' | "Claude Desktop's bundled Node" | 'global install' | 'unknown';

interface HostTiming {
    host: string;
    dnsMs?: number;
    /** TLS handshake for https, TCP connect for http. */
    connect?: { kind: 'TLS' | 'TCP'; ms: number };
    error?: string;
}

export interface DiagnosticsReport {
    format: 1;
    createdAt: string;
    versions: {
        desktopCommander: string;
        node: string;
        /** null: npm not found */
        npm: string | null;
        os: { name: string; release: string; arch: string };
        /** process.execPath, home folder as ~ */
        nodePath: string;
        nodeKind: NodeKind;
        /** process.argv[1], home folder as ~ */
        entryPath: string;
        runKind: 'MCPB' | 'npx' | 'dev checkout' | 'global npm' | 'unknown';
    };
    clock: { serverAheadSeconds: number | null; error?: string };
    network: {
        server: HostTiming & { mcpInfo: { ms: number[]; statuses: number[]; error?: string } };
        supabase: (HostTiming & {
            rest: { status?: number; ms?: number; error?: string };
            realtime: { openedMs?: number; heartbeat: boolean; heartbeatMs?: number; error?: string };
        }) | { error: string };
        proxy: { httpsProxy: boolean; httpProxy: boolean };
    };
    device: {
        deviceJson: boolean;
        parses: boolean;
        /** In full: support finds the device by it. null if missing or not id-shaped. */
        id: string | null;
        session: boolean;
        accessToken: boolean;
        refreshToken: boolean;
        /** When device.json was last saved (its modification time), ISO in UTC. */
        savedAt: string | null;
    };
    settings: { telemetryEnabled: boolean | null; clientId: string | null };
    deviceLog: { files: number; lines: number; first: string | null; last: string | null; lastText: string | null };
    /** Copies of the MCP server running now, and the earliest start (ISO). null: the process list failed. */
    desktopCommanderMcp: { running: number | null; since: string | null; error?: string };
}

interface LogPart { name: string; text: string }

// --- small helpers ---------------------------------------------------------------

/** Short reasons for the network errors a user's machine typically gives. */
const NETWORK_REASONS: Record<string, string> = {
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    ETIMEDOUT: 'timed out',
    UND_ERR_CONNECT_TIMEOUT: 'timed out',
    ENOTFOUND: 'name not found',
    EAI_AGAIN: 'name lookup failed',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
};

function errorText(error: unknown): string {
    const err = error as any;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
    // fetch() wraps the socket error in `cause`
    const code = String(err?.code ?? err?.cause?.code ?? '');
    if (NETWORK_REASONS[code]) return NETWORK_REASONS[code];
    if (/CERT|SELF_SIGNED/.test(code)) return `certificate problem (${code})`;
    const cause = err?.cause?.message;
    const message = String(err?.message ?? error);
    const firstLine = (cause && !message.includes(cause) ? `${message} (${cause})` : message).split(/\r?\n/)[0];
    return redact(firstLine).slice(0, 200);
}

function elapsed(startedAt: bigint): number {
    return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
    ]).finally(() => clearTimeout(timer));
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

// --- versions -------------------------------------------------------------------------

function runKind(): DiagnosticsReport['versions']['runKind'] {
    if (process.env.MCP_DXT) return 'MCPB';
    const here = fileURLToPath(import.meta.url);
    const parts = here.split(/[\\/]/);
    if (parts.includes('_npx')) return 'npx';
    // dist/remote-device/diagnostics/report.js -> the package root
    const root = path.resolve(path.dirname(here), '..', '..', '..');
    if (fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'src', 'version.ts'))) return 'dev checkout';
    if (parts.includes('node_modules')) return 'global npm';
    return 'unknown';
}

/**
 * Which installer the Node executable comes from, read from its path. A path
 * none of these match is "unknown": the report shows the path itself anyway.
 */
export function nodeKind(execPath: string): NodeKind {
    const p = execPath.replace(/\\/g, '/').toLowerCase();
    if (/\/(\.nvm|nvm|nvm4w)\//.test(p)) return 'nvm';
    if (/\/(\.fnm|fnm|fnm_multishells)\//.test(p)) return 'fnm';
    if (/\/(\.volta|volta)\//.test(p)) return 'Volta';
    if (p.includes('/.asdf/')) return 'asdf';
    if (/\/mise\/installs\//.test(p)) return 'mise';
    if (/\/(claude\.app|anthropicclaude)\//.test(p)) return "Claude Desktop's bundled Node";
    if (/^\/(opt\/homebrew|usr\/local\/cellar|home\/linuxbrew)\//.test(p)) return 'Homebrew';
    if (p.includes('/program files/nodejs/') || /^\/usr\/(local\/)?bin\//.test(p)) return 'global install';
    return 'unknown';
}

function npmVersion(): Promise<string | null> {
    return new Promise((resolve) => {
        // A fixed command line through the shell: npm is npm.cmd on Windows, which needs one
        exec('npm --version', {
            timeout: NPM_TIMEOUT_MS,
            windowsHide: true,
            // --version needs no registry: keep npm's update check off the network
            env: { ...process.env, npm_config_update_notifier: 'false' },
        }, (error, stdout) => {
            const version = String(stdout).trim();
            resolve(!error && /^\d+\.\d+\.\d+\S*$/.test(version) ? version : null);
        });
    });
}

function macosVersion(): Promise<string | null> {
    return new Promise((resolve) => {
        execFile('sw_vers', ['-productVersion'], { timeout: 2000 }, (error, stdout) => {
            resolve(error ? null : String(stdout).trim() || null);
        });
    });
}

async function osName(): Promise<string> {
    if (process.platform === 'win32') return os.version() || 'Windows';
    if (process.platform === 'darwin') {
        const version = await macosVersion();
        return version ? `macOS ${version}` : 'macOS';
    }
    if (process.platform === 'linux') {
        try {
            const release = fs.readFileSync('/etc/os-release', 'utf8');
            const pretty = release.match(/^PRETTY_NAME="?([^"\n]*)"?$/m)?.[1];
            if (pretty) return pretty;
        } catch { /* fall through */ }
        return 'Linux';
    }
    return os.type();
}

// --- network ----------------------------------------------------------------------------

/** DNS, then the TLS handshake (https) or TCP connect (http). `name` is how the report shows the host. */
async function timeHost(url: URL, name: string): Promise<HostTiming> {
    const host = url.hostname;
    const result: HostTiming = { host: name };
    try {
        const startedAt = process.hrtime.bigint();
        await withTimeout(dns.promises.lookup(host), CONNECT_TIMEOUT_MS);
        result.dnsMs = elapsed(startedAt);
    } catch (error) {
        result.error = `DNS failed (${errorText(error)})`;
        return result;
    }
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = Number(url.port) || (secure ? 443 : 80);
    try {
        const startedAt = process.hrtime.bigint();
        await new Promise<void>((resolve, reject) => {
            const socket = secure
                ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }, () => { socket.destroy(); resolve(); })
                : net.connect({ host, port }, () => { socket.destroy(); resolve(); });
            socket.setTimeout(CONNECT_TIMEOUT_MS, () => { socket.destroy(); reject(new Error('timed out')); });
            socket.on('error', reject);
        });
        result.connect = { kind: secure ? 'TLS' : 'TCP', ms: elapsed(startedAt) };
    } catch (error) {
        result.error = `${secure ? 'TLS' : 'TCP'} failed (${errorText(error)})`;
    }
    return result;
}

async function checkMcpInfo(serverUrl: string) {
    const ms: number[] = [];
    const statuses: number[] = [];
    const offsets: number[] = [];
    let info: { supabaseUrl?: string; supabasePublishableKey?: string; diagnosticsUrl?: unknown } | null = null;
    let error: string | undefined;
    for (let round = 0; round < MCP_INFO_ROUNDS; round++) {
        const sentAt = Date.now();
        const startedAt = process.hrtime.bigint();
        try {
            const response = await fetch(`${serverUrl}/api/mcp-info`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            const body = await response.text();
            ms.push(elapsed(startedAt));
            statuses.push(response.status);
            const serverMs = Date.parse(response.headers.get('date') ?? '');
            if (!Number.isNaN(serverMs)) offsets.push(serverMs - (sentAt + Date.now()) / 2);
            if (response.ok && !info) {
                try { info = JSON.parse(body); } catch { error = 'mcp-info is not JSON'; }
            }
        } catch (err) {
            error = errorText(err);
            // Stop at the first failure: four more timeouts would only make the user wait
            break;
        }
    }
    return { ms, statuses, offsets, info, error };
}

async function checkRest(supabaseUrl: string, key: string) {
    const startedAt = process.hrtime.bigint();
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/`, {
            headers: { apikey: key },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        await response.arrayBuffer();
        return { status: response.status, ms: elapsed(startedAt) };
    } catch (error) {
        return { error: errorText(error) };
    }
}

/** Node 22+ has WebSocket built in; older Node uses `ws`, which realtime-js depends on. */
function webSocketClass(): any {
    if (typeof (globalThis as any).WebSocket === 'function') return (globalThis as any).WebSocket;
    try {
        return createRequire(import.meta.url)('ws');
    } catch {
        return null;
    }
}

function checkRealtime(supabaseUrl: string, key: string): Promise<{ openedMs?: number; heartbeat: boolean; heartbeatMs?: number; error?: string }> {
    const WebSocketClass = webSocketClass();
    if (!WebSocketClass) return Promise.resolve({ heartbeat: false, error: 'no WebSocket in this Node version' });
    const url = `${supabaseUrl.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
    return new Promise((resolve) => {
        const result: { openedMs?: number; heartbeat: boolean; heartbeatMs?: number; error?: string } = { heartbeat: false };
        const startedAt = process.hrtime.bigint();
        let heartbeatAt: bigint;
        let socket: any;
        let done = false;
        const finish = (error?: string) => {
            // The close that follows a finished check is not a failure
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error) result.error = error;
            try { socket?.close(); } catch { /* already closed */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish(result.openedMs === undefined ? 'opening timed out' : 'heartbeat not answered in time'), REQUEST_TIMEOUT_MS);
        try {
            socket = new WebSocketClass(url);
        } catch (error) {
            finish(errorText(error));
            return;
        }
        socket.onopen = () => {
            result.openedMs = elapsed(startedAt);
            heartbeatAt = process.hrtime.bigint();
            socket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '1' }));
        };
        socket.onmessage = (event: any) => {
            try {
                const message = JSON.parse(String(event.data));
                if (message.ref === '1' && message.event === 'phx_reply') {
                    result.heartbeat = message.payload?.status === 'ok';
                    result.heartbeatMs = elapsed(heartbeatAt);
                    finish(result.heartbeat ? undefined : 'heartbeat refused');
                }
            } catch { /* not ours */ }
        };
        socket.onerror = (event: any) => finish(event?.message ? errorText(event) : 'connection failed');
        socket.onclose = (event: any) => finish(`closed (${event?.code ?? '?'})`);
    });
}

// --- Desktop Commander MCP running now ----------------------------------------------------

interface ProcessInfo { pid: number; startedAt: number; command: string }

/** "[[dd-]hh:]mm:ss" from ps, in seconds. */
function elapsedSeconds(etime: string): number {
    const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
    const parts = clock.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Every process with its command line and start time. process.ts's list uses
 * tasklist on Windows, which has no command lines, hence Win32_Process here.
 */
function listProcesses(): Promise<ProcessInfo[]> {
    const options = { timeout: PROCESS_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { ' +
                '"$($_.ProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') })`t$($_.CommandLine)" }';
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options, (error, stdout) => {
                if (error) return reject(error);
                resolve(String(stdout).split(/\r?\n/).map((line) => {
                    const [pid, created, ...command] = line.split('\t');
                    return { pid: Number(pid), startedAt: Date.parse(created), command: command.join('\t') };
                }).filter((p) => p.pid > 0 && p.command));
            });
            return;
        }
        execFile('ps', ['-A', '-ww', '-o', 'pid=,etime=,command='], options, (error, stdout) => {
            if (error) return reject(error);
            const now = Date.now();
            resolve(String(stdout).split('\n').flatMap((line) => {
                const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
                return match ? [{ pid: Number(match[1]), startedAt: now - elapsedSeconds(match[2]) * 1000, command: match[3] }] : [];
            }));
        });
    });
}

/** Whether `file` is Desktop Commander's dist/index.js: a bin link is followed, then the package.json beside dist/ named. */
function isDesktopCommanderEntry(file: string, packageNames: Map<string, string | null>): boolean {
    let entry: string;
    try {
        entry = fs.realpathSync(file);
    } catch {
        return false;
    }
    if (path.basename(entry) !== 'index.js' || path.basename(path.dirname(entry)) !== 'dist') return false;
    const root = path.dirname(path.dirname(entry));
    if (!packageNames.has(root)) {
        try {
            packageNames.set(root, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name ?? null);
        } catch {
            packageNames.set(root, null);
        }
    }
    return PACKAGE_NAMES.has(packageNames.get(root) ?? '');
}

/**
 * Processes running Desktop Commander's MCP server: a command line with its
 * dist/index.js (started by an MCP client, npx, or `remote`'s local MCP), not
 * followed by `remote` / `setup` / `remove`, and not this report. A shell
 * wrapping it names only a bin, which doesn't resolve, so it isn't counted
 * twice. Only the count and the earliest start leave this function.
 */
async function desktopCommanderMcp(): Promise<DiagnosticsReport['desktopCommanderMcp']> {
    let processes: ProcessInfo[];
    try {
        processes = await listProcesses();
    } catch (error) {
        return { running: null, since: null, error: `could not list processes (${errorText(error)})` };
    }
    const packageNames = new Map<string, string | null>();
    const servers = processes.filter(({ pid, command }) => {
        if (pid === process.pid) return false;
        const tokens = (command.match(/"[^"]*"|\S+/g) ?? []).map((token) => token.replace(/^"|"$/g, ''));
        // The first token is the executable; the entry is any later one
        const at = tokens.findIndex((token, i) => i > 0 && /(\.js|desktop-commander(\.cmd)?)$/i.test(token) &&
            isDesktopCommanderEntry(token, packageNames));
        return at > 0 && !NOT_THE_SERVER.has(tokens[at + 1] ?? '');
    });
    const starts = servers.map((p) => p.startedAt).filter((t) => !Number.isNaN(t));
    return {
        running: servers.length,
        since: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    };
}

function proxySet(...names: string[]): boolean {
    return names.some((name) => Boolean(process.env[name]));
}

// --- device state, settings, device log --------------------------------------------------

function deviceState(home: string): DiagnosticsReport['device'] {
    const file = path.join(home, '.desktop-commander-device', 'device.json');
    const state: DiagnosticsReport['device'] = {
        deviceJson: false, parses: false, id: null, session: false,
        accessToken: false, refreshToken: false, savedAt: null,
    };
    let text: string;
    try {
        state.savedAt = new Date(fs.statSync(file).mtimeMs).toISOString();
        text = fs.readFileSync(file, 'utf8');
        state.deviceJson = true;
    } catch {
        return state;
    }
    try {
        const config = JSON.parse(text);
        state.parses = true;
        // Only an id-shaped value: whatever else a hand-edited file holds stays out
        const id = config?.deviceId;
        state.id = typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
        const session = config?.session;
        state.session = Boolean(session) && typeof session === 'object';
        state.accessToken = typeof session?.access_token === 'string' && session.access_token.length > 0;
        state.refreshToken = typeof session?.refresh_token === 'string' && session.refresh_token.length > 0;
    } catch { /* parses stays false */ }
    return state;
}

function settings(home: string): DiagnosticsReport['settings'] {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(home, '.claude-server-commander', 'config.json'), 'utf8'));
        const clientId = typeof config?.clientId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(config.clientId) ? config.clientId : null;
        return {
            telemetryEnabled: typeof config?.telemetryEnabled === 'boolean' ? config.telemetryEnabled : null,
            clientId,
        };
    } catch {
        return { telemetryEnabled: null, clientId: null };
    }
}

function readTail(file: string): string {
    const size = fs.statSync(file).size;
    if (size <= MAX_LOG_READ_BYTES) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(MAX_LOG_READ_BYTES);
        fs.readSync(fd, buffer, 0, MAX_LOG_READ_BYTES, size - MAX_LOG_READ_BYTES);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

const LOG_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) {2}(.*)$/;

/** A rotated file's number: remote-mon.2.log is 2, remote-mon.log 0. */
const rotation = (name: string) => Number(name.match(/\.(\d+)\.log$/)?.[1] ?? 0);

/**
 * The device log files (the 21 fixed names that exist), oldest first by
 * modification time, each timestamped line cleaned and masked again.
 */
function deviceLog(dir: string): { parts: LogPart[]; summary: DiagnosticsReport['deviceLog'] } {
    const parts: LogPart[] = [];
    const summary: DiagnosticsReport['deviceLog'] = { files: 0, lines: 0, first: null, last: null, lastText: null };
    const files = deviceLogNames().flatMap((name) => {
        try {
            return [{ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }];
        } catch {
            return [];
        }
    }).sort((a, b) => a.mtime - b.mtime || rotation(b.name) - rotation(a.name));
    for (const { name } of files) {
        let raw: string;
        try {
            raw = readTail(path.join(dir, name));
        } catch {
            continue;
        }
        const kept: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const match = line.match(LOG_LINE);
            const text = match && cleanLine(match[2]);
            if (!match || !text) continue;
            kept.push(`${match[1]}  ${text}`);
            summary.first ??= match[1];
            summary.last = match[1];
            summary.lastText = text;
        }
        summary.files++;
        summary.lines += kept.length;
        parts.push({ name, text: kept.length ? kept.join('\n') + '\n' : '' });
    }
    return { parts, summary };
}

// --- the report ---------------------------------------------------------------------------

/** Hosts on this machine: an http address there never crosses the network (a local stand-in). */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** The diagnostics Worker's address from /api/mcp-info: https, or http on this machine only. */
function uploadUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)) ? value : null;
    } catch {
        return null;
    }
}

export async function collectReport(): Promise<{ report: DiagnosticsReport; logParts: LogPart[]; diagnosticsUrl: string | null }> {
    const home = os.homedir();
    const now = Date.now();
    const serverUrl = (process.env.MCP_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, '');

    const server = new URL(serverUrl);
    const [name, npm, mcp, serverTiming] = await Promise.all([
        osName(), npmVersion(), desktopCommanderMcp(), timeHost(server, server.host),
    ]);
    const mcpInfo = await checkMcpInfo(serverUrl);

    let supabase: DiagnosticsReport['network']['supabase'];
    const supabaseUrl = mcpInfo.info?.supabaseUrl?.replace(/\/+$/, '');
    const key = mcpInfo.info?.supabasePublishableKey;
    if (supabaseUrl && key) {
        // Shown as "Supabase": the project's address isn't needed to read the report
        const timing = await timeHost(new URL(supabaseUrl), 'Supabase');
        const rest = await checkRest(supabaseUrl, key);
        const realtime = await checkRealtime(supabaseUrl, key);
        supabase = { ...timing, rest, realtime };
    } else {
        supabase = { error: mcpInfo.error ? 'skipped: no answer from /api/mcp-info' : 'skipped: /api/mcp-info gave no Supabase address' };
    }

    const log = deviceLog(getDeviceLogDir());
    const report: DiagnosticsReport = {
        format: 1,
        createdAt: new Date(now).toISOString(),
        versions: {
            desktopCommander: VERSION,
            node: process.versions.node,
            npm,
            os: { name, release: os.release(), arch: os.arch() },
            // Paths with the home folder as ~: the user name never appears, the rest of the path does
            nodePath: redact(process.execPath),
            nodeKind: nodeKind(process.execPath),
            entryPath: process.argv[1] ? redact(process.argv[1]) : 'unknown',
            runKind: runKind(),
        },
        clock: mcpInfo.offsets.length
            ? { serverAheadSeconds: Math.round(median(mcpInfo.offsets) / 1000) }
            : { serverAheadSeconds: null, error: 'no Date header from the server' },
        network: {
            server: { ...serverTiming, mcpInfo: { ms: mcpInfo.ms, statuses: mcpInfo.statuses, error: mcpInfo.error } },
            supabase,
            proxy: { httpsProxy: proxySet('HTTPS_PROXY', 'https_proxy'), httpProxy: proxySet('HTTP_PROXY', 'http_proxy') },
        },
        device: deviceState(home),
        settings: settings(home),
        deviceLog: log.summary,
        desktopCommanderMcp: mcp,
    };
    return { report, logParts: log.parts, diagnosticsUrl: uploadUrl(mcpInfo.info?.diagnosticsUrl) };
}

function networkOk(network: DiagnosticsReport['network']): boolean {
    const { server, supabase } = network;
    if (server.error || server.mcpInfo.error || server.mcpInfo.ms.length < MCP_INFO_ROUNDS) return false;
    if (server.mcpInfo.statuses.some((status) => status !== 200)) return false;
    if ('rest' in supabase) {
        const { rest, realtime } = supabase;
        return !supabase.error && !rest.error && (rest.status ?? 0) < 500 && realtime.heartbeat;
    }
    return false;
}

function hostLine(timing: HostTiming): string {
    const parts: string[] = [];
    if (timing.dnsMs !== undefined) parts.push(`DNS ${timing.dnsMs} ms`);
    if (timing.connect) parts.push(`${timing.connect.kind} ${timing.connect.ms} ms`);
    if (timing.error) parts.push(timing.error);
    return parts.join(' · ');
}

/**
 * The REST probe has no sign-in, so any HTTP answer (401 included) means
 * Supabase is reachable; only a 5xx is the server's own failure. report.json
 * keeps the raw status.
 */
function restText(rest: { status?: number; ms?: number; error?: string }): string {
    if (rest.error || rest.status === undefined) return `not reachable (${rest.error ?? 'no answer'})`;
    if (rest.status >= 500) return `answered with a server error (${rest.status}) in ${rest.ms} ms`;
    return `reachable in ${rest.ms} ms`;
}

function localTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const hours = Math.trunc(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    const zone = `UTC${offset < 0 ? '-' : '+'}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${zone})`;
}

/** An ISO time (UTC) to the minute: "2026-10-05 14:21". */
const utcMinute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** "running (2 copies, since 14:02)": the time alone if it's today, else with the date. */
function mcpText(mcp: DiagnosticsReport['desktopCommanderMcp']): string {
    if (mcp.running === null) return `unknown (${mcp.error})`;
    if (mcp.running === 0) return 'not running';
    const copies = mcp.running === 1 ? '1 copy' : `${mcp.running} copies`;
    if (!mcp.since) return `running (${copies})`;
    const pad = (n: number) => String(n).padStart(2, '0');
    const since = new Date(mcp.since);
    const day = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
    const time = `${pad(since.getHours())}:${pad(since.getMinutes())}`;
    const today = new Date();
    const isToday = day === `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    return `running (${copies}, since ${isToday ? time : `${day} ${time}`})`;
}

export function formatReport(report: DiagnosticsReport): string {
    const label = (name: string) => name.padEnd(14);
    const indent = ' '.repeat(14);
    const lines: string[] = [];
    const { versions, clock, network, device, settings: config, deviceLog: log } = report;

    lines.push(`Desktop Commander diagnostics — ${localTimestamp(new Date(report.createdAt))}`);
    lines.push('This file contains: versions, how Node runs (paths, with the home folder as ~), clock, network checks, ' +
        'the device id and whether sign-in data exists (yes/no), device status history.');
    lines.push('It does not contain: tokens, passwords, emails, the user name, tool arguments or results.');
    lines.push('');

    lines.push(`${label('Versions')}Desktop Commander ${versions.desktopCommander} · Node ${versions.node} · ` +
        `npm ${versions.npm ?? 'not found'} · ${versions.os.name} (${versions.os.release}) ${versions.os.arch}`);
    lines.push(`${label('Node')}${versions.nodePath} (${versions.nodeKind})`);
    lines.push(`${label('Running')}${versions.entryPath} (${versions.runKind})`);
    lines.push(`${label('MCP')}${mcpText(report.desktopCommanderMcp)}`);

    const ahead = clock.serverAheadSeconds;
    lines.push(`${label('Clock')}${ahead === null ? `unknown (${clock.error})`
        : Math.abs(ahead) <= 1 ? 'device matches the server (within 1 s, from the server\'s Date header)'
            : `device is ${Math.abs(ahead)} s ${ahead > 0 ? 'behind' : 'ahead of'} the server (from the server's Date header)`}`);

    const { server, supabase, proxy } = network;
    const info = server.mcpInfo;
    const infoText = info.ms.length
        ? `/api/mcp-info ${info.ms.length}× ${Math.min(...info.ms)}/${median(info.ms)}/${Math.max(...info.ms)} ms (min/median/max)` +
        (info.statuses.some((s) => s !== 200) ? `, statuses ${info.statuses.join(', ')}` : '') +
        (info.error ? `, then failed: ${info.error}` : '')
        : `/api/mcp-info failed: ${info.error}`;
    lines.push(`${label('Network')}${server.host}: ${[hostLine(server), infoText].filter(Boolean).join(' · ')}`);
    if ('rest' in supabase) {
        const rt = supabase.realtime;
        const realtime = rt.openedMs === undefined
            ? `realtime websocket not opened (${rt.error})`
            : `realtime websocket opened in ${rt.openedMs} ms, ${rt.heartbeat ? 'heartbeat answered' : `heartbeat ${rt.error}`}`;
        lines.push(`${indent}Supabase: ${[hostLine(supabase), restText(supabase.rest), realtime].filter(Boolean).join(' · ')}`);
    } else {
        lines.push(`${indent}Supabase: ${supabase.error}`);
    }
    lines.push(`${indent}Proxy: HTTPS_PROXY ${proxy.httpsProxy ? 'set' : 'not set'} · HTTP_PROXY ${proxy.httpProxy ? 'set' : 'not set'}`);

    const saved = device.savedAt === null ? '' : `, saved ${utcMinute(device.savedAt)} UTC`;
    lines.push(`${label('Device')}${!device.deviceJson ? 'signed-in data: no (no device.json)'
        : !device.parses ? `signed-in data: device.json does not parse${saved}`
            // Signed in means a token is really there, not just a session object
            : `id ${device.id ?? 'none'} · signed-in data: ${yesNo(device.accessToken || device.refreshToken)} ` +
            `(access token: ${yesNo(device.accessToken)}, refresh token: ${yesNo(device.refreshToken)})${saved}`}`);

    const telemetry = config.telemetryEnabled === null ? 'not set' : config.telemetryEnabled ? 'on' : 'off';
    lines.push(`${label('Settings')}telemetry: ${telemetry} · client id: ${config.clientId ?? 'none'}` +
        (config.clientId ? '  (lets us find this device\'s telemetry)' : ''));

    lines.push(`${label('Device log')}${log.lines === 0
        ? (log.files ? `${log.files} file(s), no lines` : 'none yet (it is written while `remote` runs)')
        : `${log.lines.toLocaleString('en-US')} lines from ${utcMinute(log.first!)} to ${utcMinute(log.last!)} UTC; last: "${log.lastText}"`}`);

    return lines.join('\n') + '\n';
}

function zipName(home: string, date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
    for (let n = 1; ; n++) {
        const file = path.join(home, `desktop-commander-report-${stamp}${n > 1 ? `-${n}` : ''}.zip`);
        if (!fs.existsSync(file)) return file;
    }
}

/** Collects the report and writes the zip to the home folder; returns its bytes for the upload too. */
export async function writeReport(): Promise<{ file: string; bytes: number; zip: Buffer; report: DiagnosticsReport; diagnosticsUrl: string | null }> {
    const { report, logParts, diagnosticsUrl } = await collectReport();
    const zip = new PizZip();
    zip.file('report.txt', formatReport(report));
    zip.file('report.json', JSON.stringify(report, null, 2) + '\n');
    for (const part of logParts) zip.file(`device-log/${part.name}`, part.text);
    const buffer: Buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const file = zipName(os.homedir(), new Date(report.createdAt));
    // Owner-only, like the device log
    fs.writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 });
    return { file, bytes: buffer.length, zip: buffer, report, diagnosticsUrl };
}

/** `remote --report`: the terminal side. */
export async function runReport(): Promise<void> {
    console.log('Collecting diagnostics… (about 10 s)');
    let result: Awaited<ReturnType<typeof writeReport>>;
    try {
        result = await writeReport();
    } catch (error) {
        console.error(`❌ Could not save the diagnostics report: ${errorText(error)}`);
        process.exitCode = 1;
        return;
    }
    const { report, file, bytes, zip, diagnosticsUrl } = result;
    const mark = (ok: boolean) => (ok ? '✓' : '✗');
    const log = report.deviceLog;
    console.log('  ' + [
        `${mark(true)} versions`,
        `${mark(report.clock.serverAheadSeconds !== null)} clock`,
        `${mark(networkOk(report.network))} network`,
        `${mark(true)} device state`,
        // No log yet is a fact, not a failed check
        `${mark(true)} device log (${log.files ? `${log.files} file${log.files === 1 ? '' : 's'}` : 'none yet'})`,
    ].join('   '));
    console.log(`Saved: ${file} (${Math.max(1, Math.round(bytes / 1024))} KB)`);
    console.log('It holds no passwords, tokens, emails or file contents; you can open it and check.');
    if (process.argv.includes('--no-upload')) {
        console.log('Reply to your support conversation with this file attached.');
        return;
    }
    try {
        const id = await uploadReport(zip, { diagnosticsUrl, userId: savedUserId(os.homedir()), deviceId: report.device.id });
        console.log(`Sent to Desktop Commander support. Report id: ${id}`);
        console.log('Give this id to support. We keep it for 7 days, then delete it.');
    } catch (error) {
        // The zip is saved either way
        console.log(`Not sent (${errorText(error)}). Attach the zip to your support conversation instead.`);
    }
}
