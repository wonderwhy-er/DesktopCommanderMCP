/**
 * Device context — what may be recorded, and how text from disk is made safe to show a model.
 *
 * Two gates, both here so nothing reaches the journal or a chat around them:
 *  - recording: a tool call whose command line or paths hold a secret is dropped whole; credential folders
 *    and key files are never recorded (a `.env` is recorded by name only, like any file: contents never are);
 *  - showing: every name, path, branch, description or README title shown to a model goes through `safe()`,
 *    and repo text first through `plainPhrase()` and `redact()` (repo text is a prompt-injection channel).
 */

/** Folders and files that hold credentials: never recorded, not even by name. */
export const DENY_PATHS: Array<[RegExp, string]> = [
    [/[\\/]\.ssh([\\/]|$)/i, 'ssh folder'],
    [/[\\/]\.aws([\\/]|$)/i, 'aws credentials'],
    [/[\\/]\.kube([\\/]|$)/i, 'kube config'],
    [/[\\/]\.gnupg([\\/]|$)/i, 'gpg keys'],
    [/[\\/]\.docker[\\/]config\.json$/i, 'docker credentials'],
    [/\.(pem|key|p12|pfx|kdbx|keystore|jks)$/i, 'key file'],
    [/[\\/](\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.pgpass)$/i, 'credentials file'],
    [/(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)/i, 'ssh key'],
];
export const sensitivePath = (p: string): string | null => DENY_PATHS.find(([re]) => re.test(p))?.[1] ?? null;

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
    [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
    [/\bgh[pousr]_[A-Za-z0-9_]{30,}/, 'GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'],
    [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, 'OpenAI-style key'],
    [/\b[sr]k_(live|test)_[0-9A-Za-z]{10,}/, 'Stripe key'],
    [/\bxox[abpors]-[0-9A-Za-z-]{10,}/, 'Slack token'],
    [/\bAIza[0-9A-Za-z_-]{35}/, 'Google API key'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, 'JWT'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
    [/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, 'URL with password'],
    [/\b(api[_-]?key|secret|token|passw(or)?d|pwd)\s*[=:]\s*\S{6,}/i, 'key=value secret'],
    [/(--password|--token|--api-key)[= ]\S+/i, 'secret flag'],
    [/\bAuthorization:\s*(Bearer|Basic)\s+\S+/i, 'auth header'],
];
const GLOBAL_SECRETS = SECRET_PATTERNS.map(([re]) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));

/** The kind of secret in a text, or null. */
export const findSecret = (s: string): string | null => SECRET_PATTERNS.find(([re]) => re.test(s))?.[1] ?? null;
export const redact = (s: string): string => GLOBAL_SECRETS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), s);

/** Names are data: strip control and invisible characters, backticks and newlines, cap the length, wrap in a code span. */
export function safe(s: string, max = 80): string {
    const clean = String(s).replace(/[\u0000-\u001f\u007f-\u009f`​-‏‪-‮⁠-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
    return '`' + (clean.length > max ? clean.slice(0, max - 1) + '…' : clean) + '`';
}

/** Repo text (a manifest description, a README title) reaches the model at the top of a chat:
 *  keep only short, plain, non-instructive phrases, with secrets redacted. */
const SUSPICIOUS = /(assistant|instruction|ignore|system prompt|you must|pre-?approved|run |execute|curl|wget|sudo|rm -|\|\s*sh|https?:|\$\(|`|<|>|\{|\})/i;
export function plainPhrase(s: unknown, max = 70): string | null {
    if (typeof s !== 'string') return null;
    const t = s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 140 || SUSPICIOUS.test(t)) return null;
    const r = redact(t);
    return r.length > max ? r.slice(0, max - 1) + '…' : r;
}
export const plainName = (s: unknown) => (typeof s === 'string' && /^[\w@./-]{1,40}$/.test(s) && !findSecret(s) ? s : null);
