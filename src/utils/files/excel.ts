/**
 * Excel file handler using ExcelJS
 * Handles reading, writing, and editing Excel files (.xlsx, .xls, .xlsm)
 */

import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import {
    FileHandler,
    ReadOptions,
    FileResult,
    EditResult,
    FileInfo,
    ExcelSheet
} from './base.js';

// File size limit: 10MB
const FILE_SIZE_LIMIT = 10 * 1024 * 1024;

/**
 * Excel file metadata (internal use only)
 */
interface ExcelMetadata {
    sheets: ExcelSheet[];
    fileSize: number;
    isLargeFile: boolean;
}

/**
 * Excel file handler implementation using ExcelJS
 * Supports: .xlsx, .xls, .xlsm files
 */
export class ExcelFileHandler implements FileHandler {

    canHandle(path: string): boolean {
        const ext = path.toLowerCase();
        return ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.xlsm');
    }

    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        await this.checkFileSize(path);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path);

        const metadata = await this.extractMetadata(workbook, path);
        const { sheetName, data, totalRows, returnedRows } = this.worksheetToArray(
            workbook,
            options?.sheet,
            options?.range,
            options?.offset,
            options?.length
        );

        // Format output with sheet info header, usage hint, and JSON data
        const paginationInfo = totalRows > returnedRows
            ? `\n[Showing rows ${(options?.offset || 0) + 1}-${(options?.offset || 0) + returnedRows} of ${totalRows} total. Use offset/length to paginate.]`
            : '';

        const content = `[Sheet: '${sheetName}' from ${path}]${paginationInfo}
[To MODIFY cells: use edit_block with range param, e.g., edit_block(path, {range: "Sheet1!E5", content: [[newValue]]})]

${JSON.stringify(data)}`;

        return {
            content,
            mimeType: 'application/json',
            metadata: {
                isExcelFile: true,
                sheets: metadata.sheets,
                fileSize: metadata.fileSize,
                isLargeFile: metadata.isLargeFile
            }
        };
    }

    async write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void> {
        // Check existing file size if it exists
        try {
            await this.checkFileSize(path);
        } catch (error) {
            // File doesn't exist - that's fine for write
            if ((error as any).code !== 'ENOENT' &&
                !(error instanceof Error && error.message.includes('ENOENT'))) {
                throw error;
            }
        }

        // Parse content
        let parsedContent = content;
        if (typeof content === 'string') {
            try {
                parsedContent = JSON.parse(content);
            } catch {
                throw new Error('Invalid content format. Expected JSON string with 2D array or object with sheet names.');
            }
        }

        // Handle append mode by finding last row and writing after it
        if (mode === 'append') {
            try {
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.readFile(path);

                if (Array.isArray(parsedContent)) {
                    // Append to Sheet1
                    let worksheet = workbook.getWorksheet('Sheet1');
                    if (!worksheet) {
                        worksheet = workbook.addWorksheet('Sheet1');
                    }
                    const startRow = (worksheet.actualRowCount || 0) + 1;
                    this.writeRowsStartingAt(worksheet, startRow, parsedContent);
                } else if (typeof parsedContent === 'object' && parsedContent !== null) {
                    // Append to each named sheet
                    for (const [sheetName, data] of Object.entries(parsedContent)) {
                        if (Array.isArray(data)) {
                            let worksheet = workbook.getWorksheet(sheetName);
                            if (!worksheet) {
                                worksheet = workbook.addWorksheet(sheetName);
                            }
                            const startRow = (worksheet.actualRowCount || 0) + 1;
                            this.writeRowsStartingAt(worksheet, startRow, data as any[][]);
                        }
                    }
                }

                await workbook.xlsx.writeFile(path);
                return;
            } catch (error) {
                // File doesn't exist - fall through to create new file
                if ((error as any).code !== 'ENOENT' &&
                    !(error instanceof Error && error.message.includes('ENOENT'))) {
                    throw error;
                }
            }
        }

        // Rewrite mode (or append to non-existent file): create new workbook
        const workbook = new ExcelJS.Workbook();

        if (Array.isArray(parsedContent)) {
            // Single sheet from 2D array
            this.writeDataToSheet(workbook, 'Sheet1', parsedContent);
        } else if (typeof parsedContent === 'object' && parsedContent !== null) {
            // Object with sheet names as keys
            for (const [sheetName, data] of Object.entries(parsedContent)) {
                if (Array.isArray(data)) {
                    this.writeDataToSheet(workbook, sheetName, data as any[][]);
                }
            }
        } else {
            throw new Error('Invalid content format. Expected 2D array or object with sheet names.');
        }

        await workbook.xlsx.writeFile(path);
    }

    async editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult> {
        // Verify file exists and check size
        try {
            await this.checkFileSize(path);
        } catch (error) {
            if ((error as any).code === 'ENOENT' ||
                (error instanceof Error && error.message.includes('ENOENT'))) {
                throw new Error(`File not found: ${path}`);
            }
            throw error;
        }

        // Validate content
        if (!Array.isArray(content)) {
            throw new Error('Content must be a 2D array for range editing');
        }

        // Parse range: "Sheet1!A1:C10" or "Sheet1"
        const [sheetName, cellRange] = this.parseRange(range);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path);

        // Get or create sheet
        let worksheet = workbook.getWorksheet(sheetName);
        if (!worksheet) {
            worksheet = workbook.addWorksheet(sheetName);
        }

        if (cellRange) {
            // Write to specific range
            const { startRow, startCol } = this.parseCellRange(cellRange);

            for (let r = 0; r < content.length; r++) {
                const rowData = content[r];
                if (!Array.isArray(rowData)) continue;

                for (let c = 0; c < rowData.length; c++) {
                    const cell = worksheet.getCell(startRow + r, startCol + c);
                    const value = rowData[c];

                    if (typeof value === 'string' && value.startsWith('=')) {
                        cell.value = { formula: value.substring(1) };
                    } else {
                        cell.value = value;
                    }
                }
            }
        } else {
            // Replace entire sheet content
            // Clear existing data
            worksheet.eachRow((row, rowNumber) => {
                row.eachCell((cell) => {
                    cell.value = null;
                });
            });

            // Write new data
            for (let r = 0; r < content.length; r++) {
                const rowData = content[r];
                if (!Array.isArray(rowData)) continue;

                const row = worksheet.getRow(r + 1);
                for (let c = 0; c < rowData.length; c++) {
                    const value = rowData[c];
                    if (typeof value === 'string' && value.startsWith('=')) {
                        row.getCell(c + 1).value = { formula: value.substring(1) };
                    } else {
                        row.getCell(c + 1).value = value;
                    }
                }
                row.commit();
            }
        }

        await workbook.xlsx.writeFile(path);

        return { success: true, editsApplied: 1 };
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        try {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(path);
            const metadata = await this.extractMetadata(workbook, path);

            return {
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                accessed: stats.atime,
                isDirectory: stats.isDirectory(),
                isFile: stats.isFile(),
                permissions: stats.mode.toString(8).slice(-3),
                fileType: 'excel',
                metadata: {
                    isExcelFile: true,
                    sheets: metadata.sheets,
                    fileSize: metadata.fileSize,
                    isLargeFile: metadata.isLargeFile
                }
            };
        } catch (error) {
            return {
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                accessed: stats.atime,
                isDirectory: stats.isDirectory(),
                isFile: stats.isFile(),
                permissions: stats.mode.toString(8).slice(-3),
                fileType: 'excel',
                metadata: {
                    isExcelFile: true,
                    fileSize: stats.size,
                    error: true,
                    errorMessage: error instanceof Error ? error.message : String(error)
                }
            };
        }
    }

    // ========== Private Helpers ==========

    private async checkFileSize(path: string): Promise<void> {
        const stats = await fs.stat(path);
        if (stats.size > FILE_SIZE_LIMIT) {
            const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
            throw new Error(
                `Excel file size (${sizeMB}MB) exceeds 10MB limit. ` +
                `Consider using specialized tools for large file processing.`
            );
        }
    }

    private async extractMetadata(workbook: ExcelJS.Workbook, path: string): Promise<ExcelMetadata> {
        const stats = await fs.stat(path);

        const sheets: ExcelSheet[] = workbook.worksheets.map(ws => ({
            name: ws.name,
            rowCount: ws.actualRowCount || 0,
            colCount: ws.actualColumnCount || 0
        }));

        return {
            sheets,
            fileSize: stats.size,
            isLargeFile: stats.size > FILE_SIZE_LIMIT
        };
    }

    private worksheetToArray(
        workbook: ExcelJS.Workbook,
        sheetRef?: string | number,
        range?: string,
        offset?: number,
        length?: number
    ): { sheetName: string; data: any[][]; totalRows: number; returnedRows: number } {
        if (workbook.worksheets.length === 0) {
            return { sheetName: '', data: [], totalRows: 0, returnedRows: 0 };
        }

        // Find target worksheet
        let worksheet: ExcelJS.Worksheet | undefined;
        let sheetName: string;

        if (sheetRef === undefined) {
            worksheet = workbook.worksheets[0];
            sheetName = worksheet.name;
        } else if (typeof sheetRef === 'number') {
            if (sheetRef < 0 || sheetRef >= workbook.worksheets.length) {
                throw new Error(`Sheet index ${sheetRef} out of range (0-${workbook.worksheets.length - 1})`);
            }
            worksheet = workbook.worksheets[sheetRef];
            sheetName = worksheet.name;
        } else {
            worksheet = workbook.getWorksheet(sheetRef);
            if (!worksheet) {
                const available = workbook.worksheets.map(ws => ws.name).join(', ');
                throw new Error(`Sheet "${sheetRef}" not found. Available sheets: ${available}`);
            }
            sheetName = sheetRef;
        }

        // Determine range to read
        let startRow = 1;
        let endRow = worksheet.actualRowCount || 1;
        let startCol = 1;
        let endCol = worksheet.actualColumnCount || 1;

        if (range) {
            const parsed = this.parseCellRange(range);
            startRow = parsed.startRow;
            startCol = parsed.startCol;
            if (parsed.endRow) endRow = parsed.endRow;
            if (parsed.endCol) endCol = parsed.endCol;
        }

        // Calculate total rows before pagination
        const totalRows = endRow - startRow + 1;

        // Apply offset/length pagination (row-based, matching text file behavior)
        if (offset !== undefined) {
            if (offset < 0) {
                // Negative offset: last N rows (like text files)
                // offset: -10 means "last 10 rows"
                const lastNRows = Math.abs(offset);
                startRow = Math.max(startRow, endRow - lastNRows + 1);
            } else if (offset > 0) {
                // Positive offset: skip first N rows
                startRow = startRow + offset;
            }
        }

        // Apply length limit (only for positive offset or no offset)
        if (length !== undefined && length > 0 && (offset === undefined || offset >= 0)) {
            endRow = Math.min(endRow, startRow + length - 1);
        }

        // Ensure valid range
        if (startRow > endRow) {
            return { sheetName, data: [], totalRows, returnedRows: 0 };
        }

        // Build 2D array (preserving types)
        const data: any[][] = [];
        for (let r = startRow; r <= endRow; r++) {
            const row = worksheet.getRow(r);
            const rowData: any[] = [];

            for (let c = startCol; c <= endCol; c++) {
                const cell = row.getCell(c);
                let value: any = null;

                if (cell.value !== null && cell.value !== undefined) {
                    if (typeof cell.value === 'object') {
                        // Handle formula results, rich text, etc.
                        if ('result' in cell.value) {
                            value = cell.value.result ?? null;
                        } else if ('richText' in cell.value) {
                            value = (cell.value as any).richText.map((rt: any) => rt.text).join('');
                        } else if ('text' in cell.value) {
                            value = (cell.value as any).text;
                        } else if (cell.value instanceof Date) {
                            value = cell.value.toISOString();
                        } else {
                            value = String(cell.value);
                        }
                    } else {
                        // Preserve native types (string, number, boolean)
                        value = cell.value;
                    }
                }

                rowData.push(value);
            }
            data.push(rowData);
        }

        return { sheetName, data, totalRows, returnedRows: data.length };
    }

    private writeDataToSheet(workbook: ExcelJS.Workbook, sheetName: string, data: any[][]): void {
        // Remove existing sheet if it exists
        const existing = workbook.getWorksheet(sheetName);
        if (existing) {
            workbook.removeWorksheet(existing.id);
        }

        const worksheet = workbook.addWorksheet(sheetName);
        this.writeRowsStartingAt(worksheet, 1, data);
    }

    private writeRowsStartingAt(worksheet: ExcelJS.Worksheet, startRow: number, data: any[][]): void {
        for (let r = 0; r < data.length; r++) {
            const rowData = data[r];
            if (!Array.isArray(rowData)) continue;

            const row = worksheet.getRow(startRow + r);
            for (let c = 0; c < rowData.length; c++) {
                const value = rowData[c];
                if (typeof value === 'string' && value.startsWith('=')) {
                    row.getCell(c + 1).value = { formula: value.substring(1) };
                } else {
                    row.getCell(c + 1).value = value;
                }
            }
            row.commit();
        }
    }

    private parseRange(range: string): [string, string | null] {
        if (range.includes('!')) {
            const [sheetName, cellRange] = range.split('!');
            return [sheetName, cellRange];
        }
        return [range, null];
    }

    private parseCellRange(range: string): { startRow: number; startCol: number; endRow?: number; endCol?: number } {
        // Parse A1 or A1:C10 format
        const match = range.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
        if (!match) {
            throw new Error(`Invalid cell range: ${range}`);
        }

        const startCol = this.columnToNumber(match[1]);
        const startRow = parseInt(match[2], 10);

        if (match[3] && match[4]) {
            const endCol = this.columnToNumber(match[3]);
            const endRow = parseInt(match[4], 10);
            return { startRow, startCol, endRow, endCol };
        }

        return { startRow, startCol };
    }

    private columnToNumber(col: string): number {
        let result = 0;
        for (let i = 0; i < col.length; i++) {
            result = result * 26 + col.charCodeAt(i) - 64;
        }
        return result;
    }
}

