/**
 * File extensions used to route a path to its handler.
 *
 * Read by the factory and by the handlers themselves, so routing can rule a
 * handler out without loading it: asking ExcelFileHandler.canHandle() would
 * import exceljs first. Keep free of heavy imports — this is in the startup
 * graph.
 */

export const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm'] as const;
export const PDF_EXTENSIONS = ['.pdf'] as const;
export const DOCX_EXTENSIONS = ['.docx'] as const;

/** Extensions must be lowercase and dot-prefixed. */
export function hasExtension(filePath: string, extensions: readonly string[]): boolean {
    const lower = filePath.toLowerCase();
    return extensions.some(e => lower.endsWith(e));
}
