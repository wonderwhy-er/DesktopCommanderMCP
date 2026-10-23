/**
 * Small, serializable state for closed File Preview cards.
 * Never persist file contents in a closed widget.
 */
import type { RenderPayload } from './model.js';
import { parseReadRange } from './document-workspace.js';


export interface LazyPreviewState {
    kind: 'desktop-commander-lazy-preview';
    version: 1;
    readArgs: Record<string, unknown>;
    sourceTool?: 'read_file' | 'write_file' | 'edit_block';
}

export function isLazyPreviewState(value: unknown): value is LazyPreviewState {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<LazyPreviewState>;
    return state.kind === 'desktop-commander-lazy-preview'
        && state.version === 1
        && !!state.readArgs
        && typeof state.readArgs.path === 'string'
        && state.readArgs.path.length > 0;
}

export function createLazyPreviewState(
    args: Record<string, unknown>,
    sourceTool?: LazyPreviewState['sourceTool'],
): LazyPreviewState {
    const { path, offset, length, sheet, range, isUrl } = args;
    if (typeof path !== 'string' || !path) {
        throw new Error('Preview requires a nonempty path');
    }
    const readArgs: Record<string, unknown> = { path };
    if (typeof offset === 'number' && Number.isInteger(offset)) readArgs.offset = offset;
    if (typeof length === 'number' && Number.isInteger(length) && length > 0) readArgs.length = length;
    if (typeof sheet === 'string') readArgs.sheet = sheet;
    if (typeof range === 'string') readArgs.range = range;
    if (typeof isUrl === 'boolean') readArgs.isUrl = isUrl;
    return { kind: 'desktop-commander-lazy-preview', version: 1, readArgs, sourceTool };
}

export function createLazyStateFromLegacy(payload: RenderPayload): LazyPreviewState {
    const range = parseReadRange(payload.content);
    const readArgs: Record<string, unknown> = { path: payload.filePath };
    if (range?.isPartial) {
        readArgs.offset = range.readOffset;
        readArgs.length = range.toLine - range.fromLine + 1;
    }
    return createLazyPreviewState(readArgs);
}
