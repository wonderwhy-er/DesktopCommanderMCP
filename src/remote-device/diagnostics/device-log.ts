import fs from 'fs';
import os from 'os';
import path from 'path';
import { format } from 'util';
import { VERSION } from '../../version.js';
import { redact } from './redact.js';

/**
 * The remote device log: ~/.desktop-commander-device/remote-<day>.log, the
 * device's history that `remote --report` packs for support.
 *
 * `remote` passes the device's console output through startDeviceLog(). Every
 * line is written, masked by redact() and timestamped in UTC; only the private
 * kinds below are dropped. Each UTC weekday has its own files: remote-mon.log
 * rotates at 1 MB into remote-mon.1.log and remote-mon.2.log. The first write
 * on a weekday whose file is over a day old (last week's) removes that day's
 * files first, so the log keeps at most 7 days × 3 files, 21 MB.
 */

export const DEVICE_LOG_MAX_BYTES = 1024 * 1024;
/** How many files the log keeps per day: remote-<day>.log and its rotated older copies. */
export const DEVICE_LOG_FILES = 3;
/** The UTC weekdays as the file names spell them; Date.getUTCDay() indexes it. */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 24 * 60 * 60 * 1000;
/** remote-mon.log, then remote-mon.1.log, remote-mon.2.log (older); `day` is the UTC weekday, 0 = Sunday. */
export const deviceLogName = (day: number, i: number) => `remote-${DAYS[day]}${i === 0 ? '' : `.${i}`}.log`;
/** Every name the log can use: 7 days × DEVICE_LOG_FILES. */
export const deviceLogNames = (): string[] =>
    DAYS.flatMap((_, day) => Array.from({ length: DEVICE_LOG_FILES }, (_, i) => deviceLogName(day, i)));
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
    /** The folder for the log files; ~/.desktop-commander-device by default. */
    dir?: string;
    /** The clock (ms), for the timestamps and the day; Date.now by default. Tests set it. */
    now?: () => number;
    /** The size at which a file rotates; DEVICE_LOG_MAX_BYTES by default. Tests set it. */
    maxBytes?: number;
}

export class DeviceLog {
    private readonly dir: string;
    private readonly now: () => number;
    private readonly maxBytes: number;
    /** The UTC weekday being written; -1 before the first write. */
    private day = -1;
    private size = -1;
    private failures = 0;
    /** The next printed line is the sign-in link or code. */
    private skipNextLine = false;

    constructor(options: DeviceLogOptions = {}) {
        this.dir = options.dir ?? getDeviceLogDir();
        this.now = options.now ?? Date.now;
        this.maxBytes = options.maxBytes ?? DEVICE_LOG_MAX_BYTES;
    }

    private file(i: number): string {
        return path.join(this.dir, deviceLogName(this.day, i));
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
        const now = this.now();
        const line = `${new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')}  ${text}\n`;
        const bytes = Buffer.byteLength(line);
        try {
            const day = new Date(now).getUTCDay();
            if (day !== this.day) this.startDay(day, now);
            if (this.size < 0) {
                fs.mkdirSync(this.dir, { recursive: true });
                this.size = fs.existsSync(this.file(0)) ? fs.statSync(this.file(0)).size : 0;
            }
            if (this.size > 0 && this.size + bytes > this.maxBytes) {
                this.rotate();
                this.size = 0;
            }
            fs.appendFileSync(this.file(0), line, { mode: 0o600 });
            this.size += bytes;
            this.failures = 0;
        } catch {
            // The log must never break the device: skip the line, give up after a few in a row
            this.failures++;
            this.size = -1;
        }
    }

    /**
     * The first write of a UTC weekday: if that weekday's file is over a day
     * old, it is last week's, and its files go before today's lines start.
     */
    private startDay(day: number, now: number): void {
        const today = path.join(this.dir, deviceLogName(day, 0));
        if (fs.existsSync(today) && now - fs.statSync(today).mtimeMs > DAY_MS) {
            for (let i = 0; i < DEVICE_LOG_FILES; i++) fs.rmSync(path.join(this.dir, deviceLogName(day, i)), { force: true });
        }
        this.day = day;
        this.size = -1;
    }

    /** Drops the day's oldest file and moves each other one a step older: remote-mon.log becomes remote-mon.1.log. */
    private rotate(): void {
        fs.rmSync(this.file(DEVICE_LOG_FILES - 1), { force: true });
        for (let i = DEVICE_LOG_FILES - 2; i >= 0; i--) {
            if (fs.existsSync(this.file(i))) fs.renameSync(this.file(i), this.file(i + 1));
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
