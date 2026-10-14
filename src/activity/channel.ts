import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ActivityView, safeActivityText, type ActivityAnnouncement } from './activity.js';

export type ActivityEvent =
    | { kind: 'announce'; value: ActivityAnnouncement }
    | { kind: 'started'; id: string; tool: string; text?: string }
    | { kind: 'finished'; id: string; failed: boolean };

export function activitySocketPath(): string {
    if (process.env.DC_ACTIVITY_SOCKET) return process.env.DC_ACTIVITY_SOCKET;
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\desktop-commander-activity-' + os.userInfo().username;
    }
    return path.join(os.homedir(), '.cache', 'desktop-commander-activity', 'monitor.sock');
}

export function parseActivityEvent(data: unknown): ActivityEvent | null {
    if (!data || typeof data !== 'object') return null;
    const event = data as Record<string, unknown>;
    if (event.kind === 'announce') {
        const value = event.value;
        if (!value || typeof value !== 'object') return null;
        const detail = value as Record<string, unknown>;
        if (!['plan', 'progress', 'done', 'warning', 'error'].includes(String(detail.phase))) return null;
        const message = safeActivityText(detail.message);
        if (!message) return null;
        return { kind: 'announce', value: { phase: detail.phase as ActivityAnnouncement['phase'], message } };
    }
    if (event.kind === 'started') {
        if (typeof event.id !== 'string' || event.id.length > 128 ||
            typeof event.tool !== 'string' || !/^[\w.-]{1,128}$/.test(event.tool)) return null;
        const text = safeActivityText(event.text);
        return { kind: 'started', id: event.id, tool: event.tool, ...(text ? { text } : {}) };
    }
    if (event.kind === 'finished') {
        if (typeof event.id !== 'string' || event.id.length > 128 || typeof event.failed !== 'boolean') return null;
        return { kind: 'finished', id: event.id, failed: event.failed };
    }
    return null;
}

/** Best-effort local-only side channel; never blocks tool execution if the monitor is absent. */
export async function publishActivityEvent(event: ActivityEvent): Promise<void> {
    try {
        const socketPath = activitySocketPath();
        const checked = parseActivityEvent(event);
        if (!checked) return;
        await new Promise<void>((resolve) => {
        const socket = net.createConnection(socketPath);
        let ended = false;
        const done = () => { if (ended) return; ended = true; socket.destroy(); resolve(); };
        socket.setTimeout(400, done);
        socket.on('error', done);
        socket.on('close', done);
        socket.on('connect', () => socket.end(JSON.stringify(checked) + '\n'));
        });
    } catch {
        // A status-only side channel must never interrupt a real MCP operation.
    }
}

function deliver(view: ActivityView, event: ActivityEvent): void {
    if (event.kind === 'announce') view.announce(event.value);
    else if (event.kind === 'started') view.started(event.id, event.tool, event.text);
    else view.finished(event.id, event.failed);
}

/** Local-only listener: no network port, owner-only Unix socket directory. */
export async function createActivityMonitor(view: ActivityView, socketPath = activitySocketPath()) {
    if (process.platform !== 'win32') {
        const directory = path.dirname(socketPath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        // Never chmod an existing user-supplied directory (especially /tmp).
        // A private directory is required so nobody else can bind a spoofed socket.
        const stats = await fs.lstat(directory);
        if (!stats.isDirectory() || (stats.mode & 0o077) !== 0 ||
            (process.getuid && stats.uid !== process.getuid())) {
            throw new Error('Activity socket must be inside an owner-only directory');
        }
    }
    const monitor = net.createServer(socket => {
        let buffer = '';
        socket.setEncoding('utf8');
        socket.setTimeout(1200, () => socket.destroy());
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > 4096) { socket.destroy(); return; }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            let value: unknown;
            try { value = JSON.parse(buffer.slice(0, newline)); } catch { socket.destroy(); return; }
            const event = parseActivityEvent(value);
            if (event) deliver(view, event);
            socket.end();
        });
        socket.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
        monitor.once('error', reject);
        monitor.listen(socketPath, () => { monitor.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') await fs.chmod(socketPath, 0o600);
    return {
        close: async () => {
            await new Promise<void>((resolve, reject) => monitor.close(err => err ? reject(err) : resolve()));
            if (process.platform !== 'win32') await fs.unlink(socketPath).catch(() => {});
        }
    };
}
