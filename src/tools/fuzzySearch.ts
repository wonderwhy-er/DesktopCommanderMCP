import { capture } from '../utils/capture.js';
import { Worker } from 'worker_threads';
import type { FuzzyMatch, FuzzySearchMetrics } from './fuzzySearchCore.js';

// Re-export so existing callers keep importing from this module.
export { recursiveFuzzyIndexOf, getSimilarityRatio } from './fuzzySearchCore.js';

/** Abort fuzzy search in the worker after this many ms to avoid unbounded CPU burn. */
export const FUZZY_SEARCH_TIMEOUT_MS = 30000;

/**
 * Inline worker entry: imports the dependency-free core module (passed as
 * moduleUrl) and runs the search off the main thread. The core module is
 * deliberately a leaf — importing this module (or anything app-level) from the
 * worker would boot the whole server per search. Kept as an eval'd snippet so
 * the worker needs no separate file to ship alongside the compiled output.
 */
const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
import(workerData.moduleUrl)
    .then((m) => {
        parentPort.postMessage({ ok: true, ...m.runFuzzySearch(workerData.text, workerData.query) });
    })
    .catch((err) => {
        parentPort.postMessage({ ok: false, error: String(err && err.stack || err) });
    });
`;

const CORE_MODULE_URL = new URL('./fuzzySearchCore.js', import.meta.url).href;

/**
 * Runs the fuzzy search in a Worker thread so the main MCP event loop stays
 * responsive to pings and other tool calls during heavy scans. Rejects if the
 * scan exceeds timeoutMs, terminating the worker so it doesn't linger in the
 * background. Search metrics come back with the result and are captured here,
 * on the main thread, where the client identity is initialized.
 */
export function runFuzzySearchInWorker(
    text: string,
    query: string,
    timeoutMs: number = FUZZY_SEARCH_TIMEOUT_MS
): Promise<FuzzyMatch> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_CODE, { eval: true, workerData: { moduleUrl: CORE_MODULE_URL, text, query } });
        // Never let a scan keep the server process alive during shutdown.
        worker.unref();

        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`Fuzzy search timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();

        worker.on('message', (msg: { ok: true; result: FuzzyMatch; metrics: FuzzySearchMetrics } | { ok: false; error: string }) => {
            clearTimeout(timer);
            if (msg.ok) {
                captureFuzzySearchMetrics(msg.metrics);
                resolve(msg.result);
            } else {
                reject(new Error(`Fuzzy search worker failed: ${msg.error}`));
            }
            // Don't let the worker wind down on its own; the answer is already
            // here, and a lingering worker holds its copy of the file text.
            // The promise is settled, so the exit-code rejection below is a no-op.
            worker.terminate();
        });

        worker.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        worker.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Fuzzy search worker exited with code ${code}`));
            }
        });
    });
}

/** Same telemetry events the search used to emit inline, now sent from the main thread. */
function captureFuzzySearchMetrics(metrics: FuzzySearchMetrics): void {
    capture('fuzzy_search_recursive_metrics', metrics.recursive);
    if (metrics.iterative) {
        capture('fuzzy_search_iterative_metrics', metrics.iterative);
    }
}
