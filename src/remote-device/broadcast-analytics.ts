import { randomUUID } from 'node:crypto';

export type ArrivalTime = { timestamp_utc: string; monotonic_ms: number };
export type BroadcastOperation = 'claim_fetch' | 'fallback_read' | 'fallback_claim' |
  'executor_ready' | 'executor' | 'result_write';
export interface BroadcastEvent extends ArrivalTime {
  schema_version: 1;
  call_id: string;
  notification_id: string;
  attempt_number: 1;
  observation_id: string;
  source_process_id: string;
  transport: 'broadcast';
  stage: string;
  outcome?: string;
  reason?: string;
  duration_ms?: number;
  retry_wait_ms?: number;
  duplicate_count?: number;
  dropped_count?: number;
  operation?: BroadcastOperation;
  operation_attempt?: number;
  operation_id?: string;
}
export type OperationEnd = (outcome: 'success' | 'failed' | 'skipped', reason?: string) => void;
export interface BroadcastObservation {
  stage(stage: string, reason?: string): void;
  operation(operation: BroadcastOperation, attempt?: number, retryWaitMs?: number): OperationEnd;
}
export const OBSERVATION_WINDOW_MS = 60_000;
export const MAX_OBSERVED_CALLS = 1_000;
export const MAX_BUFFERED_OBSERVATIONS = 1_000;
const BATCH_SIZE = 50;
const PROCESS_ID = randomUUID();
const ignore: OperationEnd = () => {};

/** Capture before callback filtering or asynchronous work; clocks stay process-local. */
export function captureArrival(): ArrivalTime {
  return { monotonic_ms: performance.now(), timestamp_utc: new Date().toISOString() };
}

/** Observe an existing database request without changing its result or retry policy. */
export async function observeRequest<T extends { error?: unknown }>(
  observation: BroadcastObservation | undefined, operation: BroadcastOperation,
  attempt: number | undefined, request: () => PromiseLike<T>, retryWaitMs?: number,
): Promise<T> {
  const end = observation?.operation(operation, attempt, retryWaitMs);
  try {
    const result = await request();
    end?.(result.error ? 'failed' : 'success', result.error ? 'request_failed' : undefined);
    return result;
  } catch (error) {
    end?.('failed', 'request_failed');
    throw error;
  }
}

/** Bounded reporting only: none of these observations participates in execution decisions. */
export class BroadcastAnalytics {
  private queue: BroadcastEvent[] = [];
  private arrivals = new Map<string, { first: number; duplicates: number }>();
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private stopped = false;
  private attempts = 0;
  private generation = 0;
  private batch: BroadcastEvent[] | null = null;
  private controller: AbortController | null = null;
  private dropped = 0;
  private malformed = 0;

  constructor(private readonly send?: (events: BroadcastEvent[], signal: AbortSignal) => Promise<number | void>) {}

  rejectMalformed(): void { this.malformed = Math.min(this.malformed + 1, Number.MAX_SAFE_INTEGER); }

  /** Called only for a validated target/call identity on the authenticated channel. */
  receipt(callId: string, time: ArrivalTime): BroadcastObservation {
    const generation = this.generation;
    const operationAttempts = new Map<BroadcastOperation, number>();
    const active = () => generation === this.generation && !this.stopped;
    const emit = (fields: Partial<BroadcastEvent>, captured = captureArrival()) => {
      if (!active()) return;
      try {
        this.enqueue({ schema_version: 1, call_id: callId, transport: 'broadcast',
          notification_id: `${callId}:broadcast:1`, attempt_number: 1,
          source_process_id: PROCESS_ID, observation_id: randomUUID(), stage: 'received',
          ...fields, ...captured });
      } catch { /* Analytics cannot reject a command. */ }
    };
    this.prune(time.monotonic_ms);
    let seen = this.arrivals.get(callId);
    if (!seen) {
      if (this.arrivals.size >= MAX_OBSERVED_CALLS) this.arrivals.delete(this.arrivals.keys().next().value!);
      seen = { first: time.monotonic_ms, duplicates: 0 };
      this.arrivals.set(callId, seen);
    } else seen.duplicates++;
    emit({ stage: 'received', outcome: 'receipt_observed', duplicate_count: seen.duplicates }, time);
    return {
      stage: (stage, reason) => {
        const now = captureArrival();
        emit({ stage, ...(reason ? { reason } : {}),
          duration_ms: Math.max(0, now.monotonic_ms - time.monotonic_ms) }, now);
      },
      operation: (operation, attempt, retryWaitMs) => {
        if (!active()) return ignore;
        attempt ??= (operationAttempts.get(operation) ?? 0) + 1;
        operationAttempts.set(operation, attempt);
        const started = captureArrival();
        const fields = { operation, operation_attempt: attempt, operation_id: randomUUID(),
          ...(retryWaitMs === undefined ? {} : { retry_wait_ms: retryWaitMs }) };
        emit({ ...fields, stage: 'operation_start' }, started);
        let finished = false;
        return (outcome, reason) => {
          if (finished) return;
          finished = true;
          const ended = captureArrival();
          emit({ ...fields, stage: 'operation_end', outcome, ...(reason ? { reason } : {}),
            duration_ms: Math.max(0, ended.monotonic_ms - started.monotonic_ms) }, ended);
        };
      },
    };
  }

  private enqueue(event: BroadcastEvent): void {
    if (this.stopped || !this.send) return;
    if (this.queue.length >= MAX_BUFFERED_OBSERVATIONS) { this.dropped++; return; }
    if (this.dropped) { event.dropped_count = this.dropped; this.dropped = 0; }
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
      clearInterval(this.timer); this.timer = null;
    }
  }

  /** One request at a time, fifty observations, three attempts with stable observation IDs. */
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
      this.queue.splice(0, batch.length); this.batch = null; this.attempts = 0;
    } catch {
      if (generation !== this.generation) return;
      if (++this.attempts >= 3) {
        this.queue.splice(0, batch.length); this.dropped += batch.length;
        this.batch = null; this.attempts = 0;
      }
    } finally {
      this.controller = null; this.sending = false;
      this.prune(performance.now());
    }
  }

  /** Auth changes discard old identity-bound observations, including late operation completions. */
  reset(): void {
    this.generation++; this.controller?.abort();
    this.queue = []; this.batch = null; this.arrivals.clear();
    this.attempts = 0; this.dropped = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void { this.stopped = true; this.reset(); }

  get counters() {
    return { queued: this.queue.length, tracked: this.arrivals.size,
      dropped: this.dropped, malformed: this.malformed };
  }
}
