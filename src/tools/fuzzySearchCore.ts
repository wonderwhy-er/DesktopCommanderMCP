import { distance } from 'fastest-levenshtein';

/**
 * Pure fuzzy-search core, kept free of app imports on purpose: it runs inside
 * the worker thread spawned by runFuzzySearchInWorker (fuzzySearch.ts), and
 * anything imported here is loaded per worker. Telemetry is returned as data
 * and captured on the main thread, which has the real client identity.
 */

export interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
}

export interface FuzzySearchMetrics {
    recursive: {
        execution_time_ms: number;
        text_length: number;
        query_length: number;
        result_distance: number;
    };
    iterative: {
        execution_time_ms: number;
        iterations: number;
        segment_length: number;
        query_length: number;
        final_distance: number;
    } | null;
}

// Set by iterativeReduction during a search (exactly one terminal call per
// search) and collected by runFuzzySearch. Single-threaded per context, so a
// module-level slot is safe.
let lastIterativeMetrics: FuzzySearchMetrics['iterative'] = null;

/**
 * Runs a full fuzzy search and returns the match together with the timing
 * metrics that used to be captured inline.
 */
export function runFuzzySearch(text: string, query: string): { result: FuzzyMatch; metrics: FuzzySearchMetrics } {
    const startTime = performance.now();
    lastIterativeMetrics = null;
    const result = recursiveFuzzyIndexOf(text, query);
    return {
        result,
        metrics: {
            recursive: {
                execution_time_ms: performance.now() - startTime,
                text_length: text.length,
                query_length: query.length,
                result_distance: result.distance
            },
            iterative: lastIterativeMetrics
        }
    };
}

/**
 * Recursively finds the closest match to a query string within text using fuzzy matching
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text (default: 0)
 * @param end End index in the text (default: text.length)
 * @param parentDistance Best distance found so far (default: Infinity)
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
export function recursiveFuzzyIndexOf(text: string, query: string, start: number = 0, end: number | null = null, parentDistance: number = Infinity): FuzzyMatch {
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
        return recursiveFuzzyIndexOf(text, query, start, leftEnd, bestDistance);
    } else {
        return recursiveFuzzyIndexOf(text, query, rightStart, end, bestDistance);
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
function iterativeReduction(text: string, query: string, start: number, end: number, parentDistance: number): FuzzyMatch {
    const startTime = performance.now();
    let iterations = 0;

    // Seed with the measured distance of this slice. For recursive callers
    // this equals parentDistance (the parent measured exactly this slice), but
    // a top-level call on text <= 2x query length arrives with Infinity, which
    // made the first shrink unconditional and a position-0 match unreachable.
    let bestDistance = distance(text.substring(start, end), query);
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

    lastIterativeMetrics = {
        execution_time_ms: performance.now() - startTime,
        iterations: iterations,
        segment_length: end - start,
        query_length: query.length,
        final_distance: bestDistance
    };

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
