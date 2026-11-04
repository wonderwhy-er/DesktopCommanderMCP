/**
 * Waits until `condition()` (it may be async) is true, checking every 50 ms. If
 * it still isn't after `timeoutMs`, throws "timed out after <timeoutMs>ms
 * waiting until <what>", e.g. waitUntil(() => exited(pid), 10_000, 'the process exits').
 */
export async function waitUntil(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
