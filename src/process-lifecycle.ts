export const DEFAULT_FINITE_DURATION_MS = 120_000;
export const MAX_FINITE_DURATION_MS = 900_000;
export const DEFAULT_FINITE_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_FINITE_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ProcessLifecycleOptions {
  mode?: 'finite' | 'interactive';
  max_duration_ms?: number;
  max_output_bytes?: number;
}
export interface ProcessLifecycleReceipt {
  mode: 'finite' | 'interactive';
  maxDurationMs?: number;
  maxOutputBytes?: number;
  outputBytes: number;
  reason?: 'exited' | 'duration_limit' | 'output_limit';
  cleanupComplete?: boolean;
}
export function processLifecycle(options: ProcessLifecycleOptions): ProcessLifecycleReceipt {
  const mode = options.mode ?? 'finite';
  if (mode === 'interactive') {
    if (options.max_duration_ms !== undefined || options.max_output_bytes !== undefined) {
      throw new Error('Finite limits require mode finite');
    }
    return { mode, outputBytes: 0 };
  }
  const maxDurationMs = options.max_duration_ms ?? DEFAULT_FINITE_DURATION_MS;
  const maxOutputBytes = options.max_output_bytes ?? DEFAULT_FINITE_OUTPUT_BYTES;
  for (const [name, value, ceiling] of [
    ['max_duration_ms', maxDurationMs, MAX_FINITE_DURATION_MS],
    ['max_output_bytes', maxOutputBytes, MAX_FINITE_OUTPUT_BYTES],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw new Error(name + ' must be a positive integer at most ' + ceiling);
    }
  }
  return { mode, maxDurationMs, maxOutputBytes, outputBytes: 0 };
}
