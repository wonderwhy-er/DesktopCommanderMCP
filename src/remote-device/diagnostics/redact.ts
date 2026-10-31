import fs from 'fs';
import os from 'os';

/**
 * The one masker for the remote diagnostics: every line the device log keeps
 * and everything `remote --report` writes from free text passes through here.
 *
 * Masks JWTs, `access_token` / `refresh_token` / `apikey` / `password` values
 * after `=` or `:`, `Bearer …` values, emails, UUIDs (device and user ids),
 * the home folder (→ `~`), the user name and the host name.
 */

const SECRET_KEYS = 'access_token|refresh_token|provider_token|provider_refresh_token|apikey|api_key|password|passwd|secret|client_secret';

/** `key=value`, `key: value`, `"key":"value"` — the key stays, the value goes. */
const KEY_VALUE = new RegExp(`(["']?)\\b(${SECRET_KEYS})\\1(\\s*[:=]\\s*)(["']?)[^"'\\s&,;}]+`, 'gi');
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The home folder as it may appear: as is and as its real path (on macOS a
 * temp folder sits under the /var -> /private/var symlink, and execPath is the
 * real one), each with forward slashes and JSON-escaped. Only a whole path
 * matches: not "/backup/Users/x" nor "/Users/xy" for "/Users/x".
 */
function homePattern(home: string): RegExp | null {
    if (home.length < 2) return null;
    const roots = [home];
    try {
        roots.push(fs.realpathSync.native(home));
    } catch { /* no such folder: the plain form only */ }
    const forms = new Set(roots.flatMap((root) => [root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')]));
    // Longest first, so the JSON-escaped and real forms are not half-matched by a shorter one
    const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escapeRegExp);
    const pathChar = '[A-Za-z0-9_.-]';
    return new RegExp(`(?<!${pathChar})(?:${alternatives.join('|')})(?!${pathChar})`, process.platform === 'win32' ? 'gi' : 'g');
}

/** A name as a whole word: "alice" in "C:/x/alice/y", not in "aliceb". */
function wordPattern(word: string): RegExp | null {
    if (word.length < 3) return null;
    return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'gi');
}

function safeUserName(): string {
    try {
        return os.userInfo().username;
    } catch {
        return '';
    }
}

export function redact(text: string): string {
    let out = text;
    const home = homePattern(os.homedir());
    if (home) out = out.replace(home, '~');
    out = out.replace(KEY_VALUE, '$1$2$1$3$4<redacted>');
    out = out.replace(BEARER, '$1<redacted>');
    out = out.replace(JWT, '<jwt>');
    out = out.replace(EMAIL, '<email>');
    out = out.replace(UUID, '<id>');
    // "name.local" and the bare "name" a Mac also goes by
    const hostname = os.hostname();
    for (const name of new Set([hostname, hostname.split('.')[0]])) {
        const host = wordPattern(name);
        if (host) out = out.replace(host, '<host>');
    }
    const user = wordPattern(safeUserName());
    if (user) out = out.replace(user, '<user>');
    return out;
}
