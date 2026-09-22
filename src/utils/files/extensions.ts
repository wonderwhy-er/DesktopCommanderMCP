/**
 * File extensions used to route a path to its handler.
 *
 * These live in their own module so routing can rule a handler out without
 * loading it. Asking ExcelFileHandler.canHandle() whether a path is a
 * spreadsheet means importing exceljs first — which is the cost this module
 * exists to avoid.
 *
 * The factory and the handlers both read these lists, so a handler and the
 * routing that selects it cannot disagree: there is one definition, not two
 * copies kept in step by hand.
 *
 * Keep this module free of heavy imports. It is part of the startup graph.
 */

export const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm'] as const;
export const PDF_EXTENSIONS = ['.pdf'] as const;
export const DOCX_EXTENSIONS = ['.docx'] as const;

/**
 * Case-insensitive extension match.
 * @param filePath File path to test
 * @param extensions Extensions to match against, lowercase and dot-prefixed
 */
export function hasExtension(filePath: string, extensions: readonly string[]): boolean {
    const lower = filePath.toLowerCase();
    return extensions.some(e => lower.endsWith(e));
}
