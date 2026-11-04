
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
 * @param offset Zero-based offset or negative for the last pages (length is then ignored, as for lines)
 * @param length Number of pages to generate
 * @param totalPages Total number of pages in the document
 * @returns Array of page numbers (empty when the offset is past the last page or length is 0)
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

    // Compute final page (inclusive), truncated by totalPages; a negative offset reads to the last page
    const endPage = offset < 0 ? totalPages : Math.min(safeStart + length - 1, totalPages);

    const count = endPage - safeStart + 1;
    if (count <= 0) return [];

    // Preallocate array for speed
    return Array.from({ length: count }, (_, i) => safeStart + i);
}

/**
 * Close a PDF document opened with unpdf, so pdf.js frees what it holds for it
 * @param pdfDocument The document, closed through its loading task: unpdf 1.8's
 * document has no destroy() of its own (1.4's only calls loadingTask.destroy())
 */
export async function closePdfDocument(pdfDocument: { loadingTask: { destroy(): Promise<void> } }): Promise<void> {
    try {
        await pdfDocument.loadingTask.destroy();
    } catch (e) { /* Ignore cleanup errors */ }
}