/**
 * Binary file handler
 * Catch-all handler for unsupported binary files
 * Returns instructions to use start_process with appropriate tools
 */

import fs from "fs/promises";
import path from "path";
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo
} from './base.js';

/**
 * Binary file handler implementation
 * This is a catch-all handler for binary files that aren't supported by other handlers
 */
export class BinaryFileHandler implements FileHandler {
    canHandle(path: string): boolean {
        // Binary handler is the catch-all - handles everything not handled by other handlers
        return true;
    }

    async read(filePath: string, options?: ReadOptions): Promise<FileResult> {
        const instructions = this.getBinaryInstructions(filePath);

        return {
            content: instructions,
            mimeType: 'text/plain',
            metadata: {
                isBinary: true
            }
        };
    }

    async write(path: string, content: any): Promise<void> {
        throw new Error('Cannot write binary files directly. Use start_process with appropriate tools (Python, Node.js libraries, command-line utilities).');
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'binary',
            metadata: {
                isBinary: true
            }
        };
    }

    /**
     * Generate instructions for handling binary files
     */
    private getBinaryInstructions(filePath: string): string {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();

        // Get MIME type suggestion based on extension
        const mimeType = this.guessMimeType(ext);

        let specificGuidance = '';

        // Provide specific guidance based on file type
        switch (ext) {
            case '.pdf':
                specificGuidance = `
PDF FILES:
- Python: PyPDF2, pdfplumber
  start_process("python -i")
  interact_with_process(pid, "import pdfplumber")
  interact_with_process(pid, "pdf = pdfplumber.open('${filePath}')")
  interact_with_process(pid, "print(pdf.pages[0].extract_text())")

- Node.js: pdf-parse
  start_process("node -i")
  interact_with_process(pid, "const pdf = require('pdf-parse')")`;
                break;

            case '.doc':
            case '.docx':
                specificGuidance = `
WORD DOCUMENTS:
- Python: python-docx
  start_process("python -i")
  interact_with_process(pid, "import docx")
  interact_with_process(pid, "doc = docx.Document('${filePath}')")
  interact_with_process(pid, "for para in doc.paragraphs: print(para.text)")

- Node.js: mammoth
  start_process("node -i")
  interact_with_process(pid, "const mammoth = require('mammoth')")`;
                break;

            case '.zip':
            case '.tar':
            case '.gz':
                specificGuidance = `
ARCHIVE FILES:
- Python: zipfile, tarfile
  start_process("python -i")
  interact_with_process(pid, "import zipfile")
  interact_with_process(pid, "with zipfile.ZipFile('${filePath}') as z: print(z.namelist())")

- Command-line:
  start_process("unzip -l ${filePath}")  # For ZIP files
  start_process("tar -tzf ${filePath}")  # For TAR files`;
                break;

            case '.db':
            case '.sqlite':
            case '.sqlite3':
                specificGuidance = `
SQLITE DATABASES:
- Python: sqlite3
  start_process("python -i")
  interact_with_process(pid, "import sqlite3")
  interact_with_process(pid, "conn = sqlite3.connect('${filePath}')")
  interact_with_process(pid, "cursor = conn.cursor()")
  interact_with_process(pid, "cursor.execute('SELECT * FROM sqlite_master')")

- Command-line:
  start_process("sqlite3 ${filePath} '.tables'")`;
                break;

            default:
                specificGuidance = `
GENERIC BINARY FILES:
- Use appropriate libraries based on file type
- Python libraries: Check PyPI for ${ext} support
- Node.js libraries: Check npm for ${ext} support
- Command-line tools: Use file-specific utilities`;
        }

        return `Cannot read binary file as text: ${fileName} (${mimeType})

Use start_process + interact_with_process to analyze binary files with appropriate tools.
${specificGuidance}

The read_file tool only handles text files, images, and Excel files.`;
    }

    /**
     * Guess MIME type based on file extension
     */
    private guessMimeType(ext: string): string {
        const mimeTypes: { [key: string]: string } = {
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.zip': 'application/zip',
            '.tar': 'application/x-tar',
            '.gz': 'application/gzip',
            '.db': 'application/x-sqlite3',
            '.sqlite': 'application/x-sqlite3',
            '.sqlite3': 'application/x-sqlite3',
            '.mp3': 'audio/mpeg',
            '.mp4': 'video/mp4',
            '.avi': 'video/x-msvideo',
            '.mkv': 'video/x-matroska',
        };

        return mimeTypes[ext] || 'application/octet-stream';
    }
}
