/**
 * Preloaded into a device process (node --import) so its long refreshes run in
 * seconds: a 30-minute interval (the rollouts) runs every 1.5 s, and a
 * 45-minute one (the session) every 4 s. Every other interval keeps its delay.
 */
const FAST = new Map([[30 * 60_000, 1_500], [45 * 60_000, 4_000]]);

const setInterval = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...args) => setInterval(callback, FAST.get(ms) ?? ms, ...args);
