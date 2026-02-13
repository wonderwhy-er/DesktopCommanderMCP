/**
 * Code/text viewer renderer responsible for escaping, optional formatting, and syntax-highlight output wrappers. It provides a safe default for non-rich preview content.
 */
import { highlightSource } from './highlighting.js';

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
    js: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    xml: 'xml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'css',
    less: 'css',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    go: 'go',
    rs: 'rust',
    sql: 'sql',
    md: 'markdown',
    markdown: 'markdown'
};

function getFileExtension(filePath: string): string {
    const match = filePath.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
}

export function inferLanguageFromPath(filePath: string): string {
    const extension = getFileExtension(filePath);
    return EXTENSION_LANGUAGE_MAP[extension] ?? 'text';
}

export function formatJsonIfPossible(content: string, filePath: string): { content: string; notice?: string } {
    if (inferLanguageFromPath(filePath) !== 'json') {
        return { content };
    }

    try {
        return {
            content: `${JSON.stringify(JSON.parse(content), null, 2)}\n`
        };
    } catch {
        return {
            content,
            notice: 'Invalid JSON. Showing raw source.'
        };
    }
}

export function renderCodeViewer(code: string, language = 'text'): string {
    const normalizedLanguage = language || 'text';
    const highlighted = highlightSource(code, normalizedLanguage);
    return `<pre class="code-viewer"><code class="hljs language-${normalizedLanguage}">${highlighted}</code></pre>`;
}
