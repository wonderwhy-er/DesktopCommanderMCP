import type { FilePreviewStructuredContent } from '../../../types.js';
import { escapeHtml } from './components/highlighting.js';
import { stripReadStatusLine } from './document-workspace.js';
import type { RenderPayload } from './model.js';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function getFileExtensionForAnalytics(filePath: string): string {
    const normalizedPath = filePath.trim().replace(/\\/g, '/');
    const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
        return 'none';
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
}

export function isPreviewStructuredContent(value: unknown): value is FilePreviewStructuredContent {
    if (!isObjectRecord(value)) {
        return false;
    }

    return (
        typeof value.fileName === 'string' &&
        typeof value.filePath === 'string' &&
        typeof value.fileType === 'string'
    );
}

export function buildRenderPayload(
    meta: FilePreviewStructuredContent,
    text: string
): RenderPayload {
    return { ...meta, content: text };
}

export function extractToolText(value: unknown): string | undefined {
    if (!isObjectRecord(value)) {
        return undefined;
    }
    const content = value.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    for (const item of content) {
        if (!isObjectRecord(item)) {
            continue;
        }
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
            return item.text;
        }
    }
    return undefined;
}

export function extractRenderPayload(value: unknown): RenderPayload | undefined {
    if (!isObjectRecord(value)) {
        return undefined;
    }
    const meta = isPreviewStructuredContent(value.structuredContent)
        ? value.structuredContent
        : isPreviewStructuredContent(value)
            ? value
            : null;
    if (!meta) return undefined;
    const text = extractToolText(value) ?? extractToolText(value.structuredContent) ?? '';
    return buildRenderPayload(meta, text);
}

export function assertSuccessfulEditBlockResult(result: unknown): void {
    if (!isObjectRecord(result)) {
        throw new Error('edit_block did not return a valid result.');
    }

    if (result.isError === true) {
        const message = extractToolText(result) ?? '';
        throw new Error(message || 'edit_block failed.');
    }

    // edit_block uses soft-failure returns (no isError flag) for cases the LLM
    // is meant to recover from — "Search content not found", "Expected N
    // occurrences but found M", fuzzy-match-too-close-to-ignore, etc. These
    // look like success to a naive client. A real success always carries
    // structuredContent (see src/tools/edit.ts — the write path attaches
    // fileName/filePath/fileType); absence means the edit did not land.
    // Throwing here routes soft failures through saveDocument's catch, which
    // reloads disk, preserves the user's draft, and surfaces the server's
    // message to the user.
    if (!isObjectRecord(result.structuredContent)) {
        const message = extractToolText(result) ?? '';
        throw new Error(message || 'edit_block did not confirm success.');
    }
}

export function isLikelyUrl(filePath: string): boolean {
    return /^https?:\/\//i.test(filePath);
}

export function buildBreadcrumb(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts.map((part) => escapeHtml(part)).join(' <span class="breadcrumb-sep">›</span> ');
}

export function countContentLines(content: string): number {
    const cleaned = stripReadStatusLine(content);
    if (cleaned === '') return 0;
    const lines = cleaned.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}
