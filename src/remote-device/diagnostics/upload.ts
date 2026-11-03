import fs from 'fs';
import path from 'path';

/**
 * Sends the diagnostics zip to Desktop Commander's diagnostics Worker, which
 * stores it for 7 days and answers with a report id the user gives support.
 *
 * The address comes only from the server's /api/mcp-info `diagnosticsUrl`, so
 * the Worker can move without a release. When the server names none, nothing
 * is uploaded and the zip stays saved.
 * The ids only sort the upload into a folder: the user id is the saved access
 * token's `sub`, read locally like blocking-offline-update.js reads `exp`, and
 * the device id is device.json's. Nothing is refreshed, nothing signs in, and
 * device.json is only read.
 */

const UPLOAD_TIMEOUT_MS = 30_000;
const ID_SHAPED = /^[A-Za-z0-9_-]{1,64}$/;
/** The longest piece of the Worker's error message that is shown. */
const MAX_MESSAGE_CHARS = 200;

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
    /** From /api/mcp-info; null when the server names none, and then nothing is uploaded. */
    diagnosticsUrl: string | null;
    userId: string | null;
    deviceId: string | null;
    timeoutMs?: number;
}

/** POSTs the zip and resolves the report id; rejects with a short reason. */
export async function uploadReport(zip: Buffer, options: UploadOptions): Promise<string> {
    const url = options.diagnosticsUrl;
    if (!url) throw new Error('the server named no upload address');
    const headers: Record<string, string> = { 'Content-Type': 'application/zip' };
    if (options.userId) headers['X-DC-User-Id'] = options.userId;
    if (options.deviceId) headers['X-DC-Device-Id'] = options.deviceId;
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: new Uint8Array(zip),
        signal: AbortSignal.timeout(options.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        // The Worker answers errors as {code, message}: show its message, on one short line
        const message = typeof body?.message === 'string' ? body.message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS) : '';
        throw new Error(`the server answered ${response.status}${message ? `: ${message}` : ''}`);
    }
    const id = body?.id;
    if (typeof id !== 'string' || !ID_SHAPED.test(id)) throw new Error('the server gave no report id');
    return id;
}
