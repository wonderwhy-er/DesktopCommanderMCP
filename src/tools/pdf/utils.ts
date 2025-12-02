
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

/**
 * Generate page numbers based on offset and length
 * @param offset Zero-based offset or negative for counting from end
 * @param length Number of pages to generate
 * @param totalPages Total number of pages in the document
 * @returns Array of page numbers
 */
export function generatePageNumbers(
    offset: number,
    length: number,
    totalPages: number
): number[] {

    // Compute 1-based start page
    const startPage = offset < 0
        ? totalPages + offset + 1
        : offset + 1;

    // Clamp start page
    if (startPage > totalPages) return [];
    const safeStart = Math.max(1, startPage);

    // Compute final page (inclusive), truncated by totalPages
    const endPage = Math.min(safeStart + length - 1, totalPages);

    const count = endPage - safeStart + 1;
    if (count <= 0) return [];

    // Preallocate array for speed
    return Array.from({ length: count }, (_, i) => safeStart + i);
}