import { distance } from 'fastest-levenshtein';
import { capture } from '../utils/capture.js';
import { Worker } from 'worker_threads';

/** Abort fuzzy search in the worker after this many ms to avoid unbounded CPU burn. */
export const FUZZY_SEARCH_TIMEOUT_MS = 30000;

/**
 * Recursively finds the closest match to a query string within text using fuzzy matching
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text (default: 0)
 * @param end End index in the text (default: text.length)
 * @param parentDistance Best distance found so far (default: Infinity)
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
export function recursiveFuzzyIndexOf(text: string, query: string, start: number = 0, end: number | null = null, parentDistance: number = Infinity, depth: number = 0): {
    start: number;
    end: number;
    value: string;
    distance: number;
} {
    // For debugging and performance tracking purposes
    if (depth === 0) {
        const startTime = performance.now();
        const result = recursiveFuzzyIndexOf(text, query, start, end, parentDistance, depth + 1);
        const executionTime = performance.now() - startTime;
        
        // Capture detailed metrics for the recursive search for in-depth analysis
        capture('fuzzy_search_recursive_metrics', {
            execution_time_ms: executionTime,
            text_length: text.length,
            query_length: query.length,
            result_distance: result.distance
        });
        
        return result;
    }
    
    if (end === null) end = text.length;
    
    // For small text segments, use iterative approach
    if (end - start <= 2 * query.length) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }
    
    let midPoint = start + Math.floor((end - start) / 2);
    let leftEnd = Math.min(end, midPoint + query.length); // Include query length to cover overlaps
    let rightStart = Math.max(start, midPoint - query.length); // Include query length to cover overlaps
    
    // Calculate distance for current segments
    let leftDistance = distance(text.substring(start, leftEnd), query);
    let rightDistance = distance(text.substring(rightStart, end), query);
    let bestDistance = Math.min(leftDistance, parentDistance, rightDistance);
    
    // If parent distance is already the best, use iterative approach
    if (parentDistance === bestDistance) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }
    
    // Recursively search the better half
    if (leftDistance < rightDistance) {
        return recursiveFuzzyIndexOf(text, query, start, leftEnd, bestDistance, depth + 1);
    } else {
        return recursiveFuzzyIndexOf(text, query, rightStart, end, bestDistance, depth + 1);
    }
}

/**
 * Iteratively refines the best match by reducing the search area
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text
 * @param end End index in the text
 * @param parentDistance Best distance found so far
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
function iterativeReduction(text: string, query: string, start: number, end: number, parentDistance: number): {
    start: number;
    end: number;
    value: string;
    distance: number;
} {
    const startTime = performance.now();
    let iterations = 0;
    
    let bestDistance = parentDistance;
    let bestStart = start;
    let bestEnd = end;
    
    // Improve start position
    let nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);
    
    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestStart++;
        const smallerString = text.substring(bestStart + 1, bestEnd);
        nextDistance = distance(smallerString, query);
        iterations++;
    }
    
    // Improve end position
    nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);
    
    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestEnd--;
        const smallerString = text.substring(bestStart, bestEnd - 1);
        nextDistance = distance(smallerString, query);
        iterations++;
    }
    
    const executionTime = performance.now() - startTime;
    
    // Capture metrics for the iterative refinement phase
    capture('fuzzy_search_iterative_metrics', {
        execution_time_ms: executionTime,
        iterations: iterations,
        segment_length: end - start,
        query_length: query.length,
        final_distance: bestDistance
    });
    
    return {
        start: bestStart,
        end: bestEnd,
        value: text.substring(bestStart, bestEnd),
        distance: bestDistance
    };
}

/**
 * Calculates the similarity ratio between two strings
 * @param a First string
 * @param b Second string
 * @returns Similarity ratio (0-1)
 */
export function getSimilarityRatio(a: string, b: string): number {
    const maxLength = Math.max(a.length, b.length);
    if (maxLength === 0) return 1; // Both strings are empty

    const levenshteinDistance = distance(a, b);
    return 1 - (levenshteinDistance / maxLength);
}

/**
 * Inline worker entry: imports this very module (passed as moduleUrl) and runs
 * recursiveFuzzyIndexOf off the main thread. Kept as an eval'd snippet so the
 * worker needs no separate file to ship alongside the compiled output.
 */
const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
import(workerData.moduleUrl).then((m) => {
    parentPort.postMessage(m.recursiveFuzzyIndexOf(workerData.text, workerData.query));
});
`;

/**
 * Runs recursiveFuzzyIndexOf in a Worker thread so the main MCP event loop
 * stays responsive to pings and other tool calls during heavy fuzzy scans.
 * Rejects if the scan exceeds timeoutMs, terminating the worker so it
 * doesn't linger in the background.
 */
export function runFuzzySearchInWorker(
    text: string,
    query: string,
    timeoutMs: number = FUZZY_SEARCH_TIMEOUT_MS
): Promise<{ start: number; end: number; value: string; distance: number }> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_CODE, { eval: true, workerData: { moduleUrl: import.meta.url, text, query } });
        // Never let a scan keep the server process alive during shutdown.
        worker.unref();

        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`Fuzzy search timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();

        worker.on('message', (result) => {
            clearTimeout(timer);
            resolve(result);
            // Don't let the worker wind down on its own — in-worker telemetry
            // can hold it (and its copy of the file text) open for seconds.
            // The promise is already resolved, so the exit-code rejection
            // below is a no-op.
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