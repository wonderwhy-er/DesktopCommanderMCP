import fs from 'fs';
import path from 'path';

/**
 * Sends the diagnostics zip to Desktop Commander's diagnostics Worker, which
 * stores it for 7 days and answers with a report id the user gives support.
 *
 * The address: DC_DIAGNOSTICS_URL (tests), else the server's /api/mcp-info
 * `diagnosticsUrl`, so the Worker can move without a release, else the
 * default below.
 * The ids only sort the upload into a folder: the user id is the saved access
 * token's `sub`, read locally like blocking-offline-update.js reads `exp`, and
 * the device id is device.json's. Nothing is refreshed, nothing signs in, and
 * device.json is only read.
 */

/** Used when the server doesn't send an address. */
export const DEFAULT_DIAGNOSTICS_URL = 'https://diagnostics.ds-c09.workers.dev';
const UPLOAD_TIMEOUT_MS = 30_000;
const ID_SHAPED = /^[A-Za-z0-9_-]{1,64}$/;

/** The signed-in user's id from ~/.desktop-commander-device/device.json, or null. */
export function savedUserId(home: string): string | null {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(home, '.desktop-commander-device', 'device.json'), 'utf8'));
        const token = config?.session?.access_token;
        if (typeof token !== 'string') return null;
        const { sub } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
        return typeof sub === 'string' && ID_SHAPED.test(sub) ? sub : null;
    } catch {
        return null;
    }
}

export interface UploadOptions {
    /** From /api/mcp-info; null when the server names none. */
    diagnosticsUrl: string | null;
    userId: string | null;
    deviceId: string | null;
    timeoutMs?: number;
    /** DEFAULT_DIAGNOSTICS_URL unless a test injects its own. */
    defaultUrl?: string;
}

/** POSTs the zip and resolves the report id; rejects with a short reason. */
export async function uploadReport(zip: Buffer, options: UploadOptions): Promise<string> {
    const url = process.env.DC_DIAGNOSTICS_URL || options.diagnosticsUrl || (options.defaultUrl ?? DEFAULT_DIAGNOSTICS_URL);
    const headers: Record<string, string> = { 'Content-Type': 'application/zip' };
    if (options.userId) headers['X-DC-User-Id'] = options.userId;
    if (options.deviceId) headers['X-DC-Device-Id'] = options.deviceId;
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: new Uint8Array(zip),
        signal: AbortSignal.timeout(options.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    const id = (await response.json().catch(() => null))?.id;
    if (typeof id !== 'string' || !ID_SHAPED.test(id)) throw new Error('the server gave no report id');
    return id;
}
