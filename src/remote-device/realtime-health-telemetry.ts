/**
 * Low-volume Realtime lifecycle counters. No per-retry HTTP requests.
 * Counts are local observations, NOT exact Phoenix phx_join wire frames.
 */
import { createHash, randomUUID } from 'node:crypto';
import { VERSION } from '../version.js';

export type RealtimeCounter =
    | 'explicit_subscribe_calls' | 'join_successes' | 'join_errors'
    | 'join_timeouts' | 'join_closures' | 'watchdog_recreates'
    | 'socket_disconnects' | 'presence_attempts' | 'presence_successes'
    | 'presence_failures' | 'readiness_write_failures';

export type RealtimeWindow = Record<RealtimeCounter, number> & {
    event_version: number;
    device_diag_id: string;
    process_session_id: string;
    channel_generation: number;
    window_start: string;
    window_seconds: number;
    app_version: string;
    platform: string;
};

const COUNTERS: readonly RealtimeCounter[] = [
    'explicit_subscribe_calls', 'join_successes', 'join_errors',
    'join_timeouts', 'join_closures', 'watchdog_recreates',
    'socket_disconnects', 'presence_attempts', 'presence_successes',
    'presence_failures', 'readiness_write_failures',
];
const DEGRADED: readonly RealtimeCounter[] = [
    'join_errors', 'join_timeouts', 'join_closures', 'watchdog_recreates',
    'socket_disconnects', 'presence_failures', 'readiness_write_failures',
];
export class RealtimeHealthTelemetry {
    readonly processSessionId = randomUUID();
    private deviceDiagId = '';
    private generation = 0;
    private counts = this.emptyCounts();
    private windowStart = Date.now();
    private windowStartMonotonic = performance.now();
    private socketState: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly emit: (window: RealtimeWindow) => void,
        private readonly sample: (key: string) => number = (key) =>
            parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0x100000000,
        private readonly random: () => number = Math.random,
    ) {}

    private emptyCounts(): Record<RealtimeCounter, number> {
        return Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Record<RealtimeCounter, number>;
    }

    /** Stable for one registered device, unlinkable to its raw UUID without knowing the UUID. */
    setDevice(deviceId: string): void {
        if (!deviceId) return;
        const id = createHash('sha256').update('dc-realtime-diagnostics-v1:').update(deviceId).digest('hex').slice(0, 32);
        if (this.deviceDiagId === id) return;
        this.deviceDiagId = id;
        this.windowStart = Date.now();
        this.windowStartMonotonic = performance.now();
        this.counts = this.emptyCounts();
    }

    newChannel(): void {
        this.generation++;
        this.record('explicit_subscribe_calls');
    }

    record(key: RealtimeCounter): void {
        this.counts[key]++;
    }

    observeSocketState(state: string): void {
        if (this.socketState === 'open' && state !== 'open') this.record('socket_disconnects');
        this.socketState = state;
    }

    start(): void {
        if (this.timer) return;
        this.schedule();
    }

    private schedule(): void {
        // Each device chooses a different reporting boundary; never a fleet-wide minute mark.
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
            this.schedule();
        }, 60_000 + Math.floor(this.random() * 30_000));
        this.timer.unref?.();
    }

    flush(now = Date.now(), monotonicNow = performance.now()): RealtimeWindow | null {
        // Wall time may jump when observeServerDate() corrects clock skew.
        // Use only monotonic time for durations; wall time still locates the window.
        const elapsed = Math.max(1, Math.round((monotonicNow - this.windowStartMonotonic) / 1000));
        const counts = this.counts;
        const start = this.windowStart;
        this.counts = this.emptyCounts();
        this.windowStart = now;
        this.windowStartMonotonic = monotonicNow;
        if (!this.deviceDiagId) return null;
        const degraded = DEGRADED.some((key) => counts[key] > 0);
        const sampleRate = degraded ? 0.05 : 0.01;
        if (this.sample(this.deviceDiagId) >= sampleRate) return null;
        const window: RealtimeWindow = {
            ...counts,
            event_version: 1,
            device_diag_id: this.deviceDiagId,
            process_session_id: this.processSessionId,
            channel_generation: this.generation,
            window_start: new Date(start).toISOString(),
            window_seconds: elapsed,
            app_version: VERSION,
            platform: process.platform,
        };
        try { this.emit(window); } catch { /* diagnostics must not affect transport */ }
        return window;
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.flush();
    }
}
