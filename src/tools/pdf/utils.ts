
/**
 * Normalize page indexes, handling negative indices and removing duplicates
 */
export const normalizePageIndexes = (pageIndexes: number[], pageCount: number): number[] => {
    const normalizedIndexes = pageIndexes
        .map(idx => idx < 0 ? pageCount + idx : idx)
        .filter(idx => idx >= 0 && idx < pageCount);

    // Use Set to remove duplicates
    return [...new Set(normalizedIndexes)];
};
