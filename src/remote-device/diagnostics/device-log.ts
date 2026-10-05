import fs from 'fs';
import os from 'os';
import path from 'path';
import { format } from 'util';
import { VERSION } from '../../version.js';
import { redact } from './redact.js';

/**
 * The remote device log: ~/.desktop-commander-device/remote.log, the device's
 * history that `remote --report` packs for support.
 *
 * `remote` passes the device's console output through startDeviceLog(). Every
 * line is written, masked by redact() and timestamped in UTC; only the private
 * kinds below are dropped. The files rotate at 1 MB into remote.1.log and
 * remote.2.log.
 */

export const DEVICE_LOG_MAX_BYTES = 1024 * 1024;
/** How many files the log keeps: remote.log and its rotated older copies. */
export const DEVICE_LOG_FILES = 3;
/** remote.log, then remote.1.log, remote.2.log, … (older) */
export const deviceLogName = (i: number) => (i === 0 ? 'remote.log' : `remote.${i}.log`);
const MAX_LINE_CHARS = 1000;
/** A multi-line print (a stack, a config dump) is cut after this many lines. */
const MAX_LINES_PER_CALL = 40;
/** Consecutive write failures after which the log gives up for this run. */
const MAX_WRITE_FAILURES = 5;

export function getDeviceLogDir(): string {
    return path.join(os.homedir(), '.desktop-commander-device');
}

// --- the private kinds: the only lines that don't reach the log as printed -------------------

/** " name" when there is one: an empty name, or one that isn't a name, is left out. */
function toolName(name: string | undefined): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? ` ${trimmed}` : '';
}

/**
 * Tool calls keep the tool's name and the outcome; their arguments, metadata,
 * results and error details go. Matched on a print's first line by its fixed
 * words only, so an empty name, or one with a space, can't make a print slip
 * past (device.ts prints whatever name it gets). The whole print becomes this
 * one line, so a result's own lines never reach the log. null: the print goes
 * entirely.
 */
const TOOL_CALLS: Array<[RegExp, ((match: RegExpMatchArray) => string) | null]> = [
    // "Received tool call <id>: <name> <args JSON> metadata: <JSON>": the name is
    // kept only if it looks like one, never the JSON that follows an empty name
    [/^Received tool call (\S*):(?: ([\w.-]+)(?=\s|$))?/, (m) => `Received tool call ${m[1]}:${toolName(m[2])}`],
    // Anchored on the words after the name, so any name (with a colon, too) is taken whole
    [/^Tool call (.*?) ?completed:?$/, (m) => `Tool call${toolName(m[1])} completed`],
    [/^Tool call (.*?) ?failed:/, (m) => `Tool call${toolName(m[1])} failed`],
    [/^Calling MCP tool: ?(.*?) ?args:/, (m) => `Calling MCP tool${m[1] ? `:${toolName(m[1])}` : ''}`],
    [/^Calling MCP tool:/, () => 'Calling MCP tool'],
    [/^Error executing tool ?([^:]*?):/, (m) => `Error executing tool${toolName(m[1])}`],
    [/^Tool call error details/, null],
];

/** The ready block's "User: <email>", and the sign-in link in "Please visit: <link>". */
const PRIVATE_LINES = [/^User:\s/, /^Please visit:/];

/** The sign-in link and the code are each printed alone, on the line after these. */
const BEFORE_PRIVATE_LINE = [/Verify this device in your browser:$/, /Make sure the code matches:$/];

/**
 * Error objects are written as their name and message only. Printed whole they
 * carry their properties: a spawn error's `spawnargs` hold the session tokens
 * of the offline update script.
 */
function plain(arg: unknown): unknown {
    return arg instanceof Error ? `${arg.name}: ${arg.message}` : arg;
}

/** Whitespace, bullets, arrows, check marks, emoji and "[DEBUG]" before the text. */
const LEADING = /^(?:\s|\[DEBUG\]|[-–•→✓✗]|\p{Extended_Pictographic}|️|‍)+/u;

function toolCall(text: string): { line: string | null } | null {
    for (const [pattern, keep] of TOOL_CALLS) {
        const match = text.match(pattern);
        if (match) return { line: keep ? redact(keep(match)).slice(0, MAX_LINE_CHARS) : null };
    }
    return null;
}

/**
 * One line as the log keeps it: masked, or null for a private one. The report
 * runs every stored line through this again.
 */
export function cleanLine(line: string): string | null {
    const text = line.replace(LEADING, '').trimEnd();
    if (!text) return null;
    const tool = toolCall(text);
    if (tool) return tool.line;
    if (PRIVATE_LINES.some((pattern) => pattern.test(text))) return null;
    return redact(text).slice(0, MAX_LINE_CHARS);
}

export interface DeviceLogOptions {
    /** The folder for remote.log; ~/.desktop-commander-device by default. */
    dir?: string;
}

export class DeviceLog {
    private readonly dir: string;
    private readonly file: string;
    private size = -1;
    private failures = 0;
    /** The next printed line is the sign-in link or code. */
    private skipNextLine = false;

    constructor(options: DeviceLogOptions = {}) {
        this.dir = options.dir ?? getDeviceLogDir();
        this.file = path.join(this.dir, deviceLogName(0));
    }

    /** One console call's arguments: each of its lines, cleaned. */
    record(args: unknown[]): void {
        if (this.failures >= MAX_WRITE_FAILURES) return;
        let lines: string[];
        try {
            const [first, ...rest] = args.map(plain);
            lines = format(first, ...rest).split(/\r?\n/).filter((line) => line.trim() !== '');
        } catch {
            return;
        }
        if (lines.length === 0) return;
        const tool = toolCall(lines[0].replace(LEADING, '').trimEnd());
        if (tool) {
            if (tool.line) this.write(tool.line);
            return;
        }
        for (const line of lines.slice(0, MAX_LINES_PER_CALL)) {
            if (this.skipNextLine) {
                this.skipNextLine = false;
                continue;
            }
            const text = cleanLine(line);
            if (text === null) continue;
            if (BEFORE_PRIVATE_LINE.some((pattern) => pattern.test(text))) this.skipNextLine = true;
            this.write(text);
        }
    }

    /** Appends one line as is: callers pass text that is already masked. */
    write(text: string): void {
        if (this.failures >= MAX_WRITE_FAILURES) return;
        const line = `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}  ${text}\n`;
        const bytes = Buffer.byteLength(line);
        try {
            if (this.size < 0) {
                fs.mkdirSync(this.dir, { recursive: true });
                this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
            }
            if (this.size > 0 && this.size + bytes > DEVICE_LOG_MAX_BYTES) {
                this.rotate();
                this.size = 0;
            }
            fs.appendFileSync(this.file, line, { mode: 0o600 });
            this.size += bytes;
            this.failures = 0;
        } catch {
            // The log must never break the device: skip the line, give up after a few in a row
            this.failures++;
            this.size = -1;
        }
    }

    /** Drops the oldest file and moves each other one a step older: remote.log becomes remote.1.log. */
    private rotate(): void {
        const file = (i: number) => path.join(this.dir, deviceLogName(i));
        fs.rmSync(file(DEVICE_LOG_FILES - 1), { force: true });
        for (let i = DEVICE_LOG_FILES - 2; i >= 0; i--) {
            if (fs.existsSync(file(i))) fs.renameSync(file(i), file(i + 1));
        }
    }
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Passes console output through the device log for this `remote` run. Each
 * method still does what it did (so a console.debug that `remote` silenced
 * stays silent), then the log records the call. Returns a function that puts
 * the console back.
 */
export function startDeviceLog(options: DeviceLogOptions = {}): () => void {
    const log = new DeviceLog(options);
    const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
    for (const [method, original] of originals) {
        console[method] = (...args: unknown[]) => {
            original.apply(console, args);
            log.record(args);
        };
    }
    log.write(`Remote started (Desktop Commander ${VERSION}, Node ${process.versions.node}, ${process.platform})`);
    return () => {
        for (const [method, original] of originals) console[method] = original;
    };
}
