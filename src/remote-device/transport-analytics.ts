import { randomUUID } from 'node:crypto';

export type Transport = 'mqtt' | 'broadcast';
export type ArrivalTime = { timestamp_utc: string; monotonic_ms: number };
export interface TransportObservation extends ArrivalTime {
  schema_version: 1;
  call_id: string;
  notification_id: string;
  attempt_number: number;
  observation_id: string;
  source_process_id: string;
  transport: Transport;
  stage: string;
  outcome?: string;
  reason?: string;
  duration_ms?: number;
  arrival_gap_ms?: number;
  duplicate_count?: number;
  dropped_count?: number;
}
export const OBSERVATION_WINDOW_MS = 60_000;
export const MAX_OBSERVED_CALLS = 1_000;
export const MAX_BUFFERED_OBSERVATIONS = 1_000;
export const MAX_TRACKED_NOTIFICATIONS_PER_CALL = 128;
const BATCH_SIZE = 50;
const MAX_SEND_ATTEMPTS = 3;
const PROCESS_ID = randomUUID();

/** Capture on callback entry, before validation, logging or asynchronous work. */
export function captureArrival(): ArrivalTime {
  return { monotonic_ms: performance.now(), timestamp_utc: new Date().toISOString() };
}

/** Bounded, best-effort observations; delivery never participates in command admission. */
export class TransportAnalytics {
  private queue: TransportObservation[] = [];
  private arrivals = new Map<string, {
    first: number; mqtt?: number; broadcast?: number; duplicate_count: number; notifications: Set<string>;
  }>();
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private stopped = false;
  private attempts = 0;
  private generation = 0;
  private batch: TransportObservation[] | null = null;
  private controller: AbortController | null = null;
  private dropped = 0;
  private malformed = 0;

  constructor(private readonly send?: (events: TransportObservation[], signal: AbortSignal) => Promise<number | void>) {}

  /** Untrusted messages without safe call identity never create per-message state. */
  rejectMalformed(): void { this.malformed = Math.min(this.malformed + 1, Number.MAX_SAFE_INTEGER); }

  receipt(
    callId: string, transport: Transport, time: ArrivalTime,
    notificationId = `${callId}:${transport}:1`, attemptNumber = 1,
  ): TransportObservation {
    this.prune(time.monotonic_ms);
    let seen = this.arrivals.get(callId);
    if (!seen) {
      if (this.arrivals.size >= MAX_OBSERVED_CALLS) {
        this.arrivals.delete(this.arrivals.keys().next().value!);
      }
      seen = { first: time.monotonic_ms, duplicate_count: 0, notifications: new Set() };
      this.arrivals.set(callId, seen);
    }
    if (seen[transport] === undefined) seen[transport] = time.monotonic_ms;
    const notificationKey = `${transport}:${notificationId}`;
    if (seen.notifications.has(notificationKey)) seen.duplicate_count++;
    else {
      if (seen.notifications.size >= MAX_TRACKED_NOTIFICATIONS_PER_CALL) {
        seen.notifications.delete(seen.notifications.values().next().value!);
      }
      seen.notifications.add(notificationKey);
    }
    const observation: TransportObservation = {
      schema_version: 1, call_id: callId, transport, notification_id: notificationId,
      attempt_number: attemptNumber, observation_id: randomUUID(), source_process_id: PROCESS_ID,
      ...time, stage: 'received', outcome: 'receipt_observed', duplicate_count: seen.duplicate_count,
      ...(seen.mqtt !== undefined && seen.broadcast !== undefined
        ? { arrival_gap_ms: seen.mqtt - seen.broadcast } : {}),
    };
    this.enqueue(observation);
    return observation;
  }

  stage(receipt: TransportObservation | undefined, stage: string, reason?: string): void {
    if (!receipt) return; // Direct/legacy row callers have no observed transport to attribute.
    const now = captureArrival();
    this.enqueue({
      schema_version: 1, call_id: receipt.call_id, transport: receipt.transport,
      notification_id: receipt.notification_id, attempt_number: receipt.attempt_number,
      source_process_id: PROCESS_ID, observation_id: randomUUID(), ...now, stage,
      ...(reason ? { reason } : {}), duration_ms: Math.max(0, now.monotonic_ms - receipt.monotonic_ms),
    });
  }

  private enqueue(event: TransportObservation): void {
    if (this.stopped || !this.send) return;
    if (this.queue.length >= MAX_BUFFERED_OBSERVATIONS) { this.dropped++; return; }
    if (this.dropped) {
      event.dropped_count = this.dropped;
      this.dropped = 0;
    }
    this.queue.push(event);
    if (!this.timer) {
      this.timer = setInterval(() => { this.prune(performance.now()); void this.flush(); }, 1_000);
      this.timer.unref();
    }
  }

  private prune(now: number): void {
    for (const [id, arrival] of this.arrivals) {
      if (now - arrival.first < OBSERVATION_WINDOW_MS) break;
      this.arrivals.delete(id);
    }
    if (!this.arrivals.size && !this.queue.length && !this.sending && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One bounded relay request at a time. Retry the same observation IDs, at most three times. */
  async flush(): Promise<void> {
    if (!this.send || this.sending || this.stopped || !this.queue.length) return;
    this.sending = true;
    const generation = this.generation;
    const batch = this.batch ?? (this.batch = this.queue.slice(0, BATCH_SIZE));
    this.controller = new AbortController();
    try {
      const dropped = await this.send(batch, this.controller.signal);
      if (generation !== this.generation) return;
      this.dropped += dropped ?? 0;
      this.queue.splice(0, batch.length);
      this.batch = null;
      this.attempts = 0;
    } catch {
      if (generation !== this.generation) return;
      if (++this.attempts >= MAX_SEND_ATTEMPTS) {
        this.queue.splice(0, batch.length);
        this.dropped += batch.length;
        this.batch = null;
        this.attempts = 0;
      }
    } finally {
      this.controller = null;
      this.sending = false;
      if (!this.queue.length && !this.arrivals.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  /** Clear pending identity-bound observations on auth replacement and process shutdown. */
  reset(): void {
    this.generation++;
    this.controller?.abort();
    this.dropped += this.queue.length;
    this.queue = [];
    this.batch = null;
    this.arrivals.clear();
    this.attempts = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.stopped = true;
    this.reset();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get counters() {
    return { queued: this.queue.length, tracked: this.arrivals.size, dropped: this.dropped,
      malformed: this.malformed };
  }
}
