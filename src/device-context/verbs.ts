/**
 * Device context — command verbs and failure attribution.
 *
 * A verb is the only part of a command that is ever recorded ("npm test", "git status", "docker compose up").
 * Every verb comes from a closed vocabulary below: a word the user chose (a script name, a git alias, a
 * container name) never becomes part of one. `npm run migrate-customers` is recorded as `npm run`.
 *
 * Whether a non-zero exit belongs to the verb follows from how the shell computes the exit code:
 *  - `a ; b`: b's; `a | b`: b's (without pipefail), so the verb must be the last command of the last pipeline;
 *  - `a && b`: whichever failed first, so every other step of that chain must be one that cannot fail
 *    (`export`, `echo`, a `cd` into a folder that exists);
 *  - `a || b`, `a &`, and anything the parser calls complex: unknown, never attributed.
 * A `cd` anywhere in the line must have worked: when it did not, the later commands ran somewhere else or not at all.
 */
import { parseCommandLine, commandsOf, flatItems, baseName, type Command } from './shell.js';
import { isAbs } from './projects.js';

const GIT_SUBS = new Set(['status', 'log', 'diff', 'show', 'remote', 'branch', 'blame', 'check-ignore', 'rev-parse', 'ls-files', 'describe',
    'config', 'reflog', 'shortlog', 'grep', 'fetch', 'pull', 'push', 'commit', 'add', 'checkout', 'switch', 'restore', 'merge', 'rebase',
    'reset', 'stash', 'clone', 'init', 'tag', 'rm', 'mv', 'cherry-pick', 'revert', 'bisect', 'worktree', 'submodule', 'clean', 'apply', 'am']);
const GIT_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];
/** Script names common enough to be meaningless; any other script name could say something the user did not mean to share. */
const PKG_SCRIPTS = new Set(['test', 'build', 'start', 'dev', 'lint', 'serve', 'preview', 'typecheck', 'format', 'watch', 'e2e']);
/** Package-manager subcommands (not scripts). */
const PKG_BUILTINS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'ls', 'list', 'outdated',
    'audit', 'view', 'info', 'why', 'exec', 'dlx', 'x', 'init', 'create', 'publish', 'pack', 'link', 'rebuild', 'prune', 'dedupe', 't']);
const PKG_OPTS = ['--prefix', '-C', '--cwd', '--dir', '--filter', '-F', '-w', '--workspace'];
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status']);
const PM2_SUBS = new Set(['start', 'stop', 'restart', 'reload', 'delete', 'logs', 'list', 'ls', 'status']);
const DOCKER_SUBS = new Set(['ps', 'logs', 'images', 'inspect', 'stats', 'run', 'exec', 'build', 'pull', 'push', 'start', 'stop', 'restart', 'rm', 'rmi', 'create', 'kill', 'top']);
const COMPOSE_SUBS = new Set(['up', 'down', 'ps', 'logs', 'build', 'pull', 'push', 'restart', 'start', 'stop', 'exec', 'run', 'config', 'rm', 'kill', 'top', 'ls']);
const DOCKER_OPTS = ['-H', '--host', '-c', '--context', '--config', '-l', '--log-level'];
const COMPOSE_OPTS = ['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory'];
/** Tools recorded by name alone. */
const BARE = new Set(['pytest', 'make', 'cargo', 'go', 'pip', 'pip3', 'poetry', 'tsc', 'jest', 'vitest', 'node', 'python', 'python3', 'uv',
    'dotnet', 'mvn', 'gradle', 'deno', 'php', 'ruby', 'rails', 'bundle', 'composer', 'uvicorn', 'gunicorn', 'flask']);

/** Skip a tool's global options (and the values of those that take one) to reach its subcommand. */
function optionsEnd(w: string[], from: number, withValue: string[]): number {
    let i = from;
    while (i < w.length && w[i].startsWith('-')) i += withValue.includes(w[i]) ? 2 : 1;
    return i;
}
const subAfter = (w: string[], from: number, withValue: string[]) => w[optionsEnd(w, from, withValue)] ?? '';

function pkgVerb(tool: string, w: string[]): string {
    const i = optionsEnd(w, 1, PKG_OPTS);
    const sub = w[i];
    if (!sub) return tool;
    if (sub === 'run' || sub === 'run-script') { const s = subAfter(w, i + 1, PKG_OPTS); return PKG_SCRIPTS.has(s) ? `${tool} ${s}` : `${tool} run`; }
    if (PKG_SCRIPTS.has(sub) || PKG_BUILTINS.has(sub)) return `${tool} ${sub}`;
    return tool === 'npm' ? 'npm' : `${tool} run`;                              // `yarn seed-db` runs a script
}

/** The verb of one command, or null when its tool is not in the vocabulary. */
export function verbOf(c: Command): string | null {
    const w = c.argv;
    if (!w.length) return null;
    const tool = baseName(w[0]).toLowerCase();
    switch (tool) {
        case 'git': { const s = subAfter(w, 1, GIT_OPTS); return GIT_SUBS.has(s) ? `git ${s}` : 'git'; }
        case 'npm': case 'pnpm': case 'yarn': case 'bun': return pkgVerb(tool, w);
        case 'npx': case 'bunx': { const t = subAfter(w, 1, ['-p', '--package']).toLowerCase(); return BARE.has(t) ? t : null; }
        case 'systemctl': { const s = subAfter(w, 1, ['-H', '--host', '-M', '--machine']); return SERVICE_ACTIONS.has(s) ? `systemctl ${s}` : 'systemctl'; }
        case 'service': return SERVICE_ACTIONS.has(w[2]) ? `service ${w[2]}` : 'service';       // service NAME ACTION
        case 'pm2': return PM2_SUBS.has(w[1]) ? `pm2 ${w[1] === 'ls' ? 'list' : w[1]}` : 'pm2';
        case 'nginx': return w.includes('-t') ? 'nginx -t' : w.includes('-s') ? 'nginx -s reload' : 'nginx';
        case 'docker': case 'podman': {
            const i = optionsEnd(w, 1, DOCKER_OPTS);
            if (w[i] === 'compose') { const s = subAfter(w, i + 1, COMPOSE_OPTS); return COMPOSE_SUBS.has(s) ? `docker compose ${s}` : 'docker compose'; }
            return DOCKER_SUBS.has(w[i]) ? `docker ${w[i]}` : 'docker';
        }
        case 'docker-compose': { const s = subAfter(w, 1, COMPOSE_OPTS); return COMPOSE_SUBS.has(s) ? `docker compose ${s}` : 'docker compose'; }
        default: return BARE.has(tool) ? tool : null;
    }
}

/** Commands that only look (status, logs, listings, audits). A day of these is reading, not work. */
export const LOOK_VERB = /^(git (status|log|diff|show|remote|branch|blame|check-ignore|rev-parse|ls-files|describe|config|reflog|shortlog|grep|fetch)|(npm|pnpm) (ls|list|outdated|audit|view)|yarn (list|outdated|audit|info)|pm2 (logs|list|status)|docker (ps|logs|images|inspect|stats|top)|docker compose (ps|logs|config|ls|top)|systemctl status|service status|nginx -t)$/;
export const isLookVerb = (v?: string | null) => !!v && LOOK_VERB.test(v);

/** A command line's verb: the last real step wins over a trailing look ("npm run build && git status" -> "npm build"). */
export function commandVerb(cmd: string): string | null {
    let look: string | null = null;
    for (const c of commandsOf(parseCommandLine(cmd)).reverse()) {
        const v = verbOf(c);
        if (!v) continue;                                                        // curl, cat, …: skipped
        if (!isLookVerb(v)) return v;
        look ??= v;
    }
    return look;
}

const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);
/** Steps that only set the shell up: they cannot be what made a line fail (a cd is checked separately). */
const SETUP = new Set([...CD, 'popd', 'export', 'set', 'unset', 'true', ':', 'echo', 'printf', 'write-host', 'write-output']);
const isSetup = (c: Command) => !c.argv.length || SETUP.has(baseName(c.argv[0]).toLowerCase()) || /^\$[\w:]+=/.test(c.argv[0]);
export const isCd = (c: Command) => !!c.argv.length && CD.has(baseName(c.argv[0]).toLowerCase());
/** The folder a cd goes to (options skipped), or null for a bare `cd` (home). */
export function cdTarget(c: Command): string | null {
    const a = c.argv.slice(1);
    for (let i = 0; i < a.length; i++) {
        if (/^-(path|literalpath)$/i.test(a[i])) return a[i + 1] ?? null;
        if (/^(-[LPe@]+|\/d)$/i.test(a[i]) || a[i] === '--') continue;
        return a[i];
    }
    return null;
}
/** What shells print when a cd fails. */
const CD_FAILED = /\bcd: [^\n]*(no such file|not a directory|permission denied|can't cd)|set-location\s*:\s*cannot find path|the system cannot find the path specified|\bcd\b[^\n]*cannot find path/i;

export interface AttributionContext {
    /** whether an (absolute or ~) path exists right now */
    exists?: (p: string) => boolean;
    /** what the command printed: a failed cd shows up here */
    output?: string;
}

/** Whether a non-zero exit of this command line is its verb's failure (see the header). */
export function failureAttributable(cmd: string, ctx: AttributionContext = {}): boolean {
    const line = parseCommandLine(cmd);
    if (line.complex) return false;
    const items = flatItems(line);
    if (!items.length || items.some((it) => it.after === '||' || it.after === '&')) return false;
    if (ctx.output && CD_FAILED.test(ctx.output)) return false;
    for (const it of items) for (const c of it.pipeline.commands) {
        if (!isCd(c)) continue;
        const t = cdTarget(c);
        if (t && ctx.exists && (isAbs(t) || t.startsWith('~')) && !ctx.exists(t)) return false;
    }
    // the exit code comes from the last &&-chain; in it, exactly one step may be able to fail
    let start = items.length - 1;
    while (start > 0 && items[start - 1].after === '&&') start--;
    const work = items.slice(start).filter((it) => !(it.pipeline.commands.length === 1 && isSetup(it.pipeline.commands[0])));
    if (work.length !== 1) return false;
    const cmds = work[0].pipeline.commands;
    const v = verbOf(cmds[cmds.length - 1]);
    // in `npm test | grep FAIL` the exit code is grep's: the verb must be the whole pipeline
    return cmds.length === 1 && !!v && !isLookVerb(v) && v === commandVerb(cmd);
}
