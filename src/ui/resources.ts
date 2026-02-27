/**
 * Server-side UI resource loading helpers for MCP responses. It resolves packaged UI assets, reads files safely, and exposes structured resource payloads to clients.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_EDITOR_RESOURCE_URI, FILE_PREVIEW_RESOURCE_URI } from './contracts.js';

const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export const FILE_PREVIEW_RESOURCE = {
    uri: FILE_PREVIEW_RESOURCE_URI,
    name: 'Desktop Commander File Preview',
    description: 'Markdown-first preview surface for read_file structured content.',
    mimeType: UI_RESOURCE_MIME_TYPE
};

export const CONFIG_EDITOR_RESOURCE = {
    uri: CONFIG_EDITOR_RESOURCE_URI,
    name: 'Desktop Commander Config Editor',
    description: 'Interactive editor for Desktop Commander configuration values.',
    mimeType: UI_RESOURCE_MIME_TYPE
};

interface ReadableUiResource {
    mimeType: string;
    getText: () => Promise<string>;
    getMeta?: () => Record<string, unknown>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_FILE_PREVIEW_DIR = path.resolve(__dirname, 'file-preview');
const DIST_CONFIG_EDITOR_DIR = path.resolve(__dirname, 'config-editor');

function replaceOrThrow(
    source: string,
    pattern: RegExp,
    replacement: string,
    context: string
): string {
    if (!pattern.test(source)) {
        throw new Error(`UI template is missing expected ${context}`);
    }
    return source.replace(pattern, () => replacement);
}

function inlineTemplateAssets(templateHtml: string, css: string, runtime: string): string {
    const safeCss = css.replace(/<\/style/gi, '<\\/style');
    const safeRuntime = runtime.replace(/<\/script/gi, '<\\/script');

    const cssInlined = replaceOrThrow(
        templateHtml,
        /<link[^>]*href=["']\.\/styles\.css["'][^>]*>/i,
        `<style>${safeCss}</style>`,
        'styles.css link tag'
    );
    const runtimeInlined = replaceOrThrow(
        cssInlined,
        /<script[^>]*src=["']\.\/[^"']+["'][^>]*>\s*<\/script>/i,
        `<script>${safeRuntime}</script>`,
        'runtime script tag'
    );
    if (
        /href=["']\.\/styles\.css["']/i.test(runtimeInlined) ||
        /<script[^>]*src=["']\.\/[^"']+["']/i.test(runtimeInlined)
    ) {
        throw new Error('UI template still contains external static asset references after inlining');
    }
    return runtimeInlined;
}

async function readInlinedResourceHtml(distDir: string, runtimeFileName: string): Promise<string> {
    const [templateHtml, css, runtime] = await Promise.all([
        fs.readFile(path.join(distDir, 'index.html'), 'utf8'),
        fs.readFile(path.join(distDir, 'styles.css'), 'utf8'),
        fs.readFile(path.join(distDir, runtimeFileName), 'utf8')
    ]);
    return inlineTemplateAssets(templateHtml, css, runtime);
}

export async function getFilePreviewResourceText(): Promise<string> {
    return readInlinedResourceHtml(DIST_FILE_PREVIEW_DIR, 'preview-runtime.js');
}

export async function getConfigEditorResourceText(): Promise<string> {
    return readInlinedResourceHtml(DIST_CONFIG_EDITOR_DIR, 'config-editor-runtime.js');
}

const READABLE_UI_RESOURCES: Record<string, ReadableUiResource> = {
    [FILE_PREVIEW_RESOURCE_URI]: {
        mimeType: FILE_PREVIEW_RESOURCE.mimeType,
        getText: getFilePreviewResourceText
    },
    [CONFIG_EDITOR_RESOURCE_URI]: {
        mimeType: CONFIG_EDITOR_RESOURCE.mimeType,
        getText: getConfigEditorResourceText
    }
};

export function listUiResources() {
    return [FILE_PREVIEW_RESOURCE, CONFIG_EDITOR_RESOURCE];
}

export async function readUiResource(uri: string) {
    const resource = READABLE_UI_RESOURCES[uri];
    if (!resource) {
        return null;
    }

    const resourceText = await resource.getText();
    const resourceMeta = resource.getMeta?.();
    return {
        contents: [
            {
                uri,
                mimeType: resource.mimeType,
                text: resourceText,
                ...(resourceMeta ? { _meta: resourceMeta } : {})
            }
        ]
    };
}
