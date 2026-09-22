export interface RetryOptions {
  /** Total tries, the first one included. */
  attempts: number;
  /** Fixed, or computed from the attempt that just failed (1-based). */
  delayMs: number | ((attempt: number) => number);
  retryOn: (error: unknown) => boolean;
}

export async function retry<T>(
  operation: () => Promise<T>,
  { attempts, delayMs, retryOn }: RetryOptions
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !retryOn(error)) throw error;
      const wait = typeof delayMs === 'function' ? delayMs(attempt) : delayMs;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
