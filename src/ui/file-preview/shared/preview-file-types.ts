/**
 * File-type inference rules used by preview flows to choose render strategy. It maps extension/path hints into supported preview modes and explicit unsupported states.
 */
import path from 'path';

export type PreviewFileType = 'markdown' | 'text' | 'html' | 'unsupported';

export const MARKDOWN_PREVIEW_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
export const HTML_PREVIEW_EXTENSIONS = new Set(['.html', '.htm']);

export const TEXT_PREVIEW_EXTENSIONS = new Set([
    '.txt',
    '.text',
    '.log',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.xml',
    '.css',
    '.scss',
    '.less',
    '.js',
    '.cjs',
    '.mjs',
    '.ts',
    '.jsx',
    '.tsx',
    '.sh',
    '.bash',
    '.zsh',
    '.py',
    '.rb',
    '.java',
    '.go',
    '.rs',
    '.sql'
]);

const TEXT_PREVIEW_BASENAMES = new Set([
    '.env',
    '.gitignore',
    '.gitattributes',
    'dockerfile',
    'makefile'
]);

export function resolvePreviewFileType(filePath: string): PreviewFileType {
    const normalizedPath = filePath.toLowerCase();
    const extension = path.extname(normalizedPath);
    const basename = path.basename(normalizedPath);

    if (MARKDOWN_PREVIEW_EXTENSIONS.has(extension)) {
        return 'markdown';
    }
    if (HTML_PREVIEW_EXTENSIONS.has(extension)) {
        return 'html';
    }
    if (TEXT_PREVIEW_EXTENSIONS.has(extension) || TEXT_PREVIEW_BASENAMES.has(basename)) {
        return 'text';
    }
    return 'unsupported';
}
