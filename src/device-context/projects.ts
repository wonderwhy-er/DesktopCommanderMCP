/**
 * Device context — paths, project roots and project identity.
 *
 * A project is identified by its root folder. The same folder can be spelled several ways (`Code/Shop` and
 * `code/shop` on a case-insensitive macOS or Windows volume), so identity is the spelling the file system
 * itself reports (`realpath.native`), taken only when it differs from the given path by case: symlinks are
 * not followed, so a project keeps the path the user works under (and the allowlist sees that path).
 * On a case-sensitive volume two spellings are two folders and stay two projects.
 */
import fs from 'fs';
import path from 'path';

export const isAbs = (p: unknown): boolean => typeof p === 'string' && (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));

/** "~/x", "$HOME/x", "%USERPROFILE%\\x" -> absolute, so commands like `cd ~/proj` are understood. */
export function expandHome(p: string, home: string): string {
    if (typeof p !== 'string') return p;
    return p.replace(/^~(?=$|[\\/])/, home).replace(/^\$\{?HOME\}?(?=$|[\\/])/, home).replace(/^\$env:USERPROFILE(?=$|[\\/])/i, home).replace(/^%USERPROFILE%/i, home);
}

export const norm = (p: string) => path.resolve(p);
/** Equality key of a spelling: Windows paths compare without case, others exactly. */
export const keyOf = (p: string) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p));
export const isInside = (child: string, parent: string) => {
    const r = path.relative(keyOf(parent), keyOf(child));
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

const canonCache = new Map<string, { at: number; value: string }>();
/** The file system's own spelling of an existing path when it differs from `p` only by case; else `p` resolved. */
export function canonical(p: string): string {
    const r = norm(p);
    if (process.platform === 'linux') return r;                              // case-sensitive: the spelling is the identity
    const hit = canonCache.get(r);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    let value = r;
    try {
        const real = fs.realpathSync.native(r);
        if (real !== r && real.toLowerCase() === r.toLowerCase()) value = real;
    } catch { /* does not exist (yet) */ }
    if (canonCache.size > 4000) canonCache.clear();
    canonCache.set(r, { at: Date.now(), value });
    return value;
}
/** Identity of a project root: two roots are the same project when their keys are equal. */
export const projectKey = (root: string) => keyOf(canonical(root));
export const sameProject = (a: string, b: string) => projectKey(a) === projectKey(b);

// ---------- project detection ----------
export const MANIFESTS = ['package.json', 'pyproject.toml', 'manage.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json',
    'Gemfile', 'pom.xml', 'build.gradle', 'docker-compose.yml', 'compose.yml', 'compose.yaml', 'deno.json'];
const STACK: Record<string, string> = {
    'package.json': 'Node', 'pyproject.toml': 'Python', 'requirements.txt': 'Python', 'Cargo.toml': 'Rust',
    'go.mod': 'Go', 'composer.json': 'PHP', 'Gemfile': 'Ruby', 'pom.xml': 'Java', 'build.gradle': 'Java/Kotlin',
    'docker-compose.yml': 'Docker', 'compose.yml': 'Docker', 'compose.yaml': 'Docker', 'deno.json': 'Deno', 'manage.py': 'Python/Django',
};

/** Folders that hold projects; a plain folder directly inside one of them counts as a project. */
const CONTAINER_NAMES = ['code', 'projects', 'project', 'dev', 'src', 'work', 'repos', 'repo', 'sites', 'www', 'apps', 'git', 'github',
    'Projects', 'Code', 'Developer', 'Sites', 'workspace', 'source'];
const NOT_PROJECTS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'Movies', 'Public', 'Templates', 'snap', 'tmp',
    'node_modules', '.cache', '.config', '.local', '.npm', '.nvm', '.vscode', '.claude-server-commander', 'archive', 'backup', 'backups',
    'AppData', 'Application Data', 'Local Settings', 'Library', 'OneDrive', 'Favorites', 'Links', 'Saved Games', 'Searches', 'Contacts'];
const SITE_MARKERS = ['index.html', 'index.php', 'wp-config.php', 'app.py', 'server.js', 'main.py', 'Dockerfile'];
const containersOf = (home: string) => [home, ...CONTAINER_NAMES.map((n) => path.join(home, n)), '/srv', '/var/www', '/opt', 'C:\\inetpub\\wwwroot'].map(keyOf);

/** System trees are never projects, even when versioned (etckeeper) or full of manifests.
 *  Per platform: on Windows path.resolve('/dev') is C:\dev, a normal place for projects. */
const UNIX_SYSTEM_ROOTS = ['/etc', '/usr', '/var/log', '/var/lib', '/proc', '/sys', '/dev', '/run', '/boot', '/bin', '/sbin', '/lib'];
const WIN_SYSTEM_ROOTS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
const systemRoots = () => (process.platform === 'win32' ? WIN_SYSTEM_ROOTS : UNIX_SYSTEM_ROOTS);
export const isSystemPath = (p: string) => keyOf(p) === keyOf(path.parse(norm(p)).root) || systemRoots().some((s) => isInside(p, s));
/** A versioned config tree (etckeeper-style) is not a project; checked on the found root only. */
const isConfigTree = (root: string) => path.basename(root) === 'etc' || isSystemPath(root);

function startDir(p: string): string {
    try { return fs.statSync(p).isDirectory() ? p : path.dirname(p); }
    catch { return path.extname(p) ? path.dirname(p) : p; }
}

export interface ProjectRef { root: string; sub: string | null }
const projectCache = new Map<string, { at: number; value: ProjectRef | null }>();
/** The project a path belongs to: nearest git root, then nearest manifest, then a plain folder in a known container.
 *  Never climbs to `home` or a filesystem root. The root comes back in the file system's own spelling. */
export function findProject(p: string, home: string): ProjectRef | null {
    const start = canonical(startDir(p));
    const hit = projectCache.get(start);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = findByMarkers(start, home) ?? findPlainFolder(start, home);
    if (projectCache.size > 2000) projectCache.clear();
    projectCache.set(start, { at: Date.now(), value });
    return value;
}

function findByMarkers(start: string, home: string): ProjectRef | null {
    if (isSystemPath(start)) return null;
    let dir = start;
    let manifestDir: string | null = null;
    let gitDir: string | null = null;
    while (keyOf(dir) !== keyOf(home) && path.dirname(dir) !== dir) {
        if (fs.existsSync(path.join(dir, '.git'))) { gitDir = dir; }
        if (!manifestDir && MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)))) manifestDir = dir;
        if (gitDir) break;
        dir = path.dirname(dir);
    }
    const root = gitDir ?? manifestDir;
    if (!root || isConfigTree(root)) return null;
    return { root, sub: manifestDir && gitDir && keyOf(manifestDir) !== keyOf(gitDir) ? manifestDir : null };
}

/** No git and no manifest: a plain folder (a static site) directly inside a known container,
 *  or a folder on Desktop/Documents that is clearly a site or app (the typical non-technical layout). */
function findPlainFolder(start: string, home: string): ProjectRef | null {
    const containers = containersOf(home);
    const personal = ['Desktop', 'Documents'].map((n) => keyOf(path.join(home, n)));
    let dir = start;
    while (path.dirname(dir) !== dir) {
        const parent = path.dirname(dir);
        const name = path.basename(dir);
        if (containers.includes(keyOf(parent))) {
            if (NOT_PROJECTS.includes(name) || name.startsWith('.') || containers.includes(keyOf(dir))) return null;
            return { root: dir, sub: null };
        }
        if (personal.includes(keyOf(parent))) {
            return !name.startsWith('.') && SITE_MARKERS.some((m) => fs.existsSync(path.join(dir, m))) ? { root: dir, sub: null } : null;
        }
        if (keyOf(dir) === keyOf(home)) return null;
        dir = parent;
    }
    return null;
}

// ---------- facts read live from a project folder ----------
export function gitFacts(root: string): { branch: string } | null {
    try {
        let gitDir = path.join(root, '.git');
        if (fs.statSync(gitDir).isFile()) {                                       // worktree / submodule: ".git" points to the real git dir
            const m = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
            if (m) gitDir = path.resolve(root, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const b = head.startsWith('ref: ') ? head.slice(5).replace('refs/heads/', '') : head.slice(0, 7);
        return { branch: /^[\w./-]{1,60}$/.test(b) && !/(assistant|instruction|ignore|curl|wget|sudo|\|)/i.test(b) ? b : '(unusual name)' };
    } catch { return fs.existsSync(path.join(root, '.git')) ? { branch: 'unknown' } : null; }
}

export function stackOf(root: string): string | null {
    const found = MANIFESTS.find((m) => fs.existsSync(path.join(root, m)));
    return found ? `${STACK[found]} (${found})` : null;
}
