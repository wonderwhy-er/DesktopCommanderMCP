/**
 * Device context — its two settings, both from Desktop Commander's own config (config.json via configManager):
 *  - `deviceContext`: off (default) | tool | nudge | both. The env var DESKTOP_COMMANDER_DEVICE_CONTEXT is the
 *    fallback when the config has no value (config wins: some clients, such as Claude Desktop, keep a server's
 *    env from when it was first added and ignore later edits, while config.json is re-read on change);
 *  - `allowedDirectories`: folders outside it are never shown, with the same rule DC enforces for file access
 *    (no list: the home folder; an empty list or '/': everything).
 * server.ts sets the source and calls refreshSettings() before each request; everything else reads the snapshot.
 * If the config cannot be read, nothing is shown (an unreadable allowlist is not permission to show every folder).
 */
import os from 'os';

export type DeviceContextMode = 'off' | 'tool' | 'nudge' | 'both';
export type ConfigSource = () => Promise<Record<string, unknown>> | Record<string, unknown>;

export function parseMode(v: unknown): DeviceContextMode | null {
    if (typeof v !== 'string' && typeof v !== 'boolean') return null;
    const s = String(v).trim().toLowerCase();
    if (s === 'off' || s === 'tool' || s === 'nudge' || s === 'both') return s;
    if (s === '1' || s === 'true' || s === 'on') return 'both';
    if (s === '0' || s === 'false') return 'off';
    return null;
}

/** The home folder; DC_DEVICE_CONTEXT_HOME overrides it in tests. */
export const home = () => process.env.DC_DEVICE_CONTEXT_HOME || os.homedir();

/** DC's rule (tools/filesystem.ts): no list -> the home folder; [] or one containing '/' -> everything (null). */
export function allowlistFrom(v: unknown): string[] | null {
    if (!Array.isArray(v)) return [home()];
    const dirs = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().replace(/^~(?=$|[\\/])/, home()));
    return !dirs.length || dirs.includes('/') ? null : dirs;
}

let source: ConfigSource | null = null;
let snapshot: { mode: DeviceContextMode | null; allowed: string[] | null } = { mode: null, allowed: [] };

export function setConfigSource(fn: ConfigSource | null): void { source = fn; }

/** Read the current config into the snapshot. Never throws. */
export async function refreshSettings(): Promise<void> {
    if (!source) return;
    try {
        const cfg = (await source()) ?? {};
        snapshot = { mode: parseMode(cfg.deviceContext), allowed: allowlistFrom(cfg.allowedDirectories) };
    } catch {
        snapshot = { mode: snapshot.mode, allowed: [] };
    }
}

export const deviceContextMode = (): DeviceContextMode => snapshot.mode ?? parseMode(process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT) ?? 'off';
/** Folders that may be shown (null: everything; []: nothing). */
export const allowedDirs = (): string[] | null => snapshot.allowed;
export const isDeviceContextToolEnabled = () => ['tool', 'both'].includes(deviceContextMode());
export const isNudgeEnabled = () => ['nudge', 'both'].includes(deviceContextMode());
export const isEnabled = () => deviceContextMode() !== 'off';
export function _resetSettingsForTests() { source = null; snapshot = { mode: null, allowed: [] }; }
