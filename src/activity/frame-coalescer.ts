/**
 * Coalesce rendered screen frames. This is a presentation-only optimization:
 * ActivityView still receives every event and retains accurate operation totals.
 */
export class FrameCoalescer {
    private queued: string | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly output: { write(value: string): unknown }, private readonly delayMs = 16) {
        if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Frame interval must be nonnegative');
    }

    write(frame: string): void {
        // A newer full-screen frame supersedes any unsent older frame.
        this.queued = frame;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.delayMs);
        this.timer.unref();
    }

    flush(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const frame = this.queued;
        this.queued = null;
        if (frame !== null) this.output.write(frame);
    }

    close(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.queued = null;
    }
}
