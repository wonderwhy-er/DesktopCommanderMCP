/**
 * Device context — the journal: ~/.claude-server-commander/device-context-events.jsonl, one JSON row per fact.
 *
 * Several Desktop Commander processes (Claude Desktop, Claude Code, …) append to the same file, so the file is
 * the source of truth and each process keeps an in-memory copy that it brings up to date by reading only the
 * bytes appended since its last read (a few hundred bytes per call, never the whole file). A file that was
 * replaced (compaction by any process) or truncated ("forget") is read again from its tail. Rows past the
 * retention window are left out of every read, whether or not the file changed since.
 * Appends are synchronous (one short line): a card built right after a call already knows about it.
 */
import fs from 'fs';
import path from 'path';
import type { JournalRow } from './observe.js';

const KINDS = new Set(['read', 'edit', 'cmd']);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';
/** A row as written by any version of device context, or null when it is not one. */
function validRow(r: any): JournalRow | null {
    if (!r || typeof r !== 'object' || typeof r.root !== 'string' || !r.root || typeof r.t !== 'string' || !KINDS.has(r.kind)) return null;
    if (!Number.isFinite(Date.parse(r.t)) || !optStr(r.file) || !optStr(r.verb) || !optStr(r.sub) || !optStr(r.run)) return null;
    return r as JournalRow;
}

/** Read the last `max` bytes of a file, starting at a whole line (a huge file is never loaded whole). */
export function readTail(file: string, max: number): string {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - max);
        const buf = Buffer.alloc(size - start);
        const n = readFully(fd, buf, start);
        const text = buf.subarray(0, n).toString('utf8');
        if (start === 0) return text;
        const nl = text.indexOf('\n');
        return nl < 0 ? '' : text.slice(nl + 1);
    } finally { fs.closeSync(fd); }
}
function readFully(fd: number, buf: Buffer, position: number): number {
    let off = 0;
    while (off < buf.length) {
        const n = fs.readSync(fd, buf, off, buf.length - off, position + off);
        if (n <= 0) break;
        off += n;
    }
    return off;
}

export interface JournalOptions {
    file: () => string;
    retentionMs: number;
    /** never read more than this from the file at once (compaction keeps it far below) */
    maxReadBytes: number;
    /** compact (rewrite with the retained rows, one per day/project/kind/file/verb) past this size */
    compactAtBytes: number;
}

export class Journal {
    private rows: JournalRow[] = [];
    private times: number[] = [];
    private offset = 0;
    private ident = '';
    private lastCompact = 0;
    constructor(private readonly opts: JournalOptions) {}

    /** Bring the in-memory copy up to date with the file. */
    private sync(): void {
        let st: fs.Stats;
        try { st = fs.statSync(this.opts.file()); } catch { this.clear(''); return; }
        const ident = `${st.dev}:${st.ino}`;
        let dropFirst = false;
        if (ident !== this.ident || st.size < this.offset || st.size - this.offset > this.opts.maxReadBytes) {
            // replaced, truncated, or too much to catch up with: read the tail again
            this.clear(ident);
            this.offset = Math.max(0, st.size - this.opts.maxReadBytes);
            dropFirst = this.offset > 0;
        }
        if (st.size <= this.offset) return;
        let fd: number;
        try { fd = fs.openSync(this.opts.file(), 'r'); } catch { return; }
        try {
            const buf = Buffer.alloc(st.size - this.offset);
            const n = readFully(fd, buf, this.offset);
            // only whole lines; a line still being written is read next time
            const end = buf.subarray(0, n).lastIndexOf(0x0a) + 1;
            if (end <= 0) return;
            const lines = buf.subarray(0, end).toString('utf8').split('\n');
            if (dropFirst) lines.shift();
            for (const line of lines) {
                if (!line) continue;
                let r: JournalRow | null = null;
                try { r = validRow(JSON.parse(line)); } catch { /* a torn line */ }
                if (r) { this.rows.push(r); this.times.push(Date.parse(r.t)); }
            }
            this.offset += end;
        } finally { fs.closeSync(fd); }
        if (st.size > this.opts.compactAtBytes) this.compactSoon();
    }

    private clear(ident: string): void { this.rows = []; this.times = []; this.offset = 0; this.ident = ident; }

    /** The retained rows (inside the retention window at `nowMs`), oldest first in file order. */
    all(nowMs: number): JournalRow[] {
        this.sync();
        const cut = nowMs - this.opts.retentionMs;
        if (!this.times.length || this.times.every((t) => t >= cut)) return this.rows;
        return this.rows.filter((_, i) => this.times[i] >= cut);
    }

    exists(): boolean { return fs.existsSync(this.opts.file()); }

    append(rows: object[]): void {
        if (!rows.length) return;
        try {
            fs.mkdirSync(path.dirname(this.opts.file()), { recursive: true });
            fs.appendFileSync(this.opts.file(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        } catch { /* never break a tool call */ }
    }

    /** First run: write the journal from rows found elsewhere, unless another process already created it. */
    create(rows: JournalRow[]): boolean {
        try {
            fs.mkdirSync(path.dirname(this.opts.file()), { recursive: true });
            fs.writeFileSync(this.opts.file(), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { flag: 'wx' });
            return true;
        } catch { return false; }
    }

    /** Forget everything: an empty file (not a missing one: a missing journal is rebuilt from tool history). */
    truncate(): void {
        try { fs.mkdirSync(path.dirname(this.opts.file()), { recursive: true }); fs.writeFileSync(this.opts.file(), ''); } catch { /* ignore */ }
        this.clear('');
    }

    /** Rewrite the file with the retained rows, deduplicated, in the background (at most every 10 minutes).
     *  If the file grew meanwhile (another process appended), this round is skipped rather than losing that row. */
    private compactSoon(): void {
        if (Date.now() - this.lastCompact < 10 * 60_000) return;
        this.lastCompact = Date.now();
        const file = this.opts.file();
        const sizeAtStart = this.offset;
        const keep = new Map<string, JournalRow>();
        for (const r of this.all(Date.now())) {
            const k = [r.t.slice(0, 10), r.root, r.kind, r.file ?? '', r.verb ?? '', r.failed ? 1 : 0].join('|');
            const prev = keep.get(k);
            if (!prev || prev.t <= r.t) keep.set(k, r);
        }
        const text = [...keep.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)).map((r) => JSON.stringify(r)).join('\n') + '\n';
        const tmp = `${file}.tmp-${process.pid}`;
        void (async () => {
            try {
                await fs.promises.writeFile(tmp, text, 'utf8');
                const st = await fs.promises.stat(file);
                if (st.size !== sizeAtStart) { await fs.promises.rm(tmp, { force: true }); return; }
                await fs.promises.rename(tmp, file);
            } catch { await fs.promises.rm(tmp, { force: true }).catch(() => undefined); }
        })();
    }
}
