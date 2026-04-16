import { attachDocumentOutline, renderDocumentOutline, type DocumentOutlineHandle } from '../document-outline.js';
import { getDocumentFullscreenAvailability, parseReadRange, shouldAutoLoadDocumentOnEnterFullscreen, stripReadStatusLine } from '../document-workspace.js';
import type { MarkdownWorkspaceState, RenderBodyResult, RenderPayload } from '../model.js';
import { assertSuccessfulEditBlockResult, extractRenderPayload, extractToolText } from '../payload-utils.js';
import { getAncestorDirectories, getParentDirectory, toPosixRelativePath } from '../path-utils.js';
import { mountMarkdownEditor, renderMarkdownEditorShell, type MarkdownEditorHandle, type MarkdownEditorView, type MarkdownLinkHeading, type MarkdownLinkSearchItem } from './editor.js';
import { resolveMarkdownLink } from './linking.js';
import { extractMarkdownOutline } from './outline.js';
import { getRenderedMarkdownCopyText } from './preview.js';
import { slugifyMarkdownHeading } from './slugify.js';
import { getFileExtensionForAnalytics } from '../payload-utils.js';

export interface MarkdownControllerDependencies {
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    openExternalLink?: (url: string) => Promise<boolean | undefined>;
    requestDisplayMode?: (mode: 'inline' | 'fullscreen') => Promise<string | null | undefined>;
    getAvailableDisplayModes: () => string[];
    getCurrentDisplayMode: () => string | null;
    getCurrentPayload: () => RenderPayload | undefined;
    setExpanded: (expanded: boolean) => void;
    syncPayload?: (payload?: RenderPayload) => void;
    storePayloadOverride: (payload: RenderPayload) => void;
    rerender: () => void;
    updateSaveStatus: (label: string, statusClass: string) => void;
    trackUiEvent?: (event: string, params?: Record<string, unknown>) => void;
}

interface ToolErrorResult {
    isError?: boolean;
}

interface DiffHunk {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function areOutlineItemsEqual(
    left: MarkdownWorkspaceState['outline'],
    right: MarkdownWorkspaceState['outline']
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((item, index) => {
        const other = right[index];
        return item.id === other.id
            && item.text === other.text
            && item.level === other.level
            && item.line === other.line;
    });
}

function splitListingLines(text: string): string[] {
    return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseFileSearchResults(text: string): string[] {
    return text.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('📁 '))
        .map((line) => line.slice(3).trim());
}

function stripMarkdownExtension(filePath: string): string {
    return filePath.replace(/\.md$/i, '');
}

function computeDiffHunks(oldLines: string[], newLines: string[]): DiffHunk[] {
    const oldLength = oldLines.length;
    const newLength = newLines.length;

    if (oldLength * newLength > 1_000_000) {
        return [{ oldStart: 0, oldEnd: oldLength, newStart: 0, newEnd: newLength }];
    }

    const dp: number[][] = Array.from({ length: oldLength + 1 }, () => Array(newLength + 1).fill(0) as number[]);
    for (let i = 1; i <= oldLength; i += 1) {
        for (let j = 1; j <= newLength; j += 1) {
            dp[i][j] = oldLines[i - 1] === newLines[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    const matches: Array<[number, number]> = [];
    let oldIndex = oldLength;
    let newIndex = newLength;
    while (oldIndex > 0 && newIndex > 0) {
        if (oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
            matches.unshift([oldIndex - 1, newIndex - 1]);
            oldIndex -= 1;
            newIndex -= 1;
        } else if (dp[oldIndex - 1][newIndex] >= dp[oldIndex][newIndex - 1]) {
            oldIndex -= 1;
        } else {
            newIndex -= 1;
        }
    }

    const hunks: DiffHunk[] = [];
    let previousOld = 0;
    let previousNew = 0;
    for (const [matchOld, matchNew] of matches) {
        if (matchOld > previousOld || matchNew > previousNew) {
            hunks.push({ oldStart: previousOld, oldEnd: matchOld, newStart: previousNew, newEnd: matchNew });
        }
        previousOld = matchOld + 1;
        previousNew = matchNew + 1;
    }
    if (previousOld < oldLength || previousNew < newLength) {
        hunks.push({ oldStart: previousOld, oldEnd: oldLength, newStart: previousNew, newEnd: newLength });
    }

    return hunks;
}

function mergeCloseHunks(hunks: DiffHunk[], minGap: number): DiffHunk[] {
    if (hunks.length <= 1) {
        return hunks;
    }

    const merged: DiffHunk[] = [{ ...hunks[0] }];
    for (let index = 1; index < hunks.length; index += 1) {
        const previous = merged[merged.length - 1];
        const current = hunks[index];
        if (current.oldStart - previous.oldEnd < minGap) {
            previous.oldEnd = current.oldEnd;
            previous.newEnd = current.newEnd;
            continue;
        }
        merged.push({ ...current });
    }
    return merged;
}

function computeEditBlocks(oldText: string, newText: string): Array<{ old_string: string; new_string: string }> {
    if (oldText === newText) {
        return [];
    }

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const hunks = computeDiffHunks(oldLines, newLines);
    if (hunks.length === 0) {
        return [];
    }

    const context = 3;
    const merged = mergeCloseHunks(hunks, context * 2 + 1);
    const totalChanged = merged.reduce((sum, hunk) => sum + (hunk.oldEnd - hunk.oldStart), 0);
    if (totalChanged > oldLines.length * 0.7) {
        return [{ old_string: oldText, new_string: newText }];
    }

    return merged.map((hunk) => {
        const contextBefore = Math.max(0, hunk.oldStart - context);
        const contextAfter = Math.min(oldLines.length, hunk.oldEnd + context);

        const oldBlock = oldLines.slice(contextBefore, contextAfter).join('\n');
        const newBlock = [
            ...oldLines.slice(contextBefore, hunk.oldStart),
            ...newLines.slice(hunk.newStart, hunk.newEnd),
            ...oldLines.slice(hunk.oldEnd, contextAfter),
        ].join('\n');

        return { old_string: oldBlock, new_string: newBlock };
    }).filter((block) => block.old_string !== block.new_string);
}

function isToolErrorResult(value: unknown): value is ToolErrorResult {
    return typeof value === 'object' && value !== null;
}

function isMissingFileErrorResult(result: unknown): boolean {
    if (!isToolErrorResult(result) || result.isError !== true) {
        return false;
    }

    const message = extractToolText(result)?.toLowerCase() ?? '';
    return message.includes('not found')
        || message.includes('no such file')
        || message.includes('enoent');
}

export function createMarkdownController(dependencies: MarkdownControllerDependencies) {
    let workspaceState: MarkdownWorkspaceState | undefined;
    let markdownEditorHandle: MarkdownEditorHandle | undefined;
    let markdownTocHandle: DocumentOutlineHandle | undefined;

    function disposeHandles(): void {
        markdownEditorHandle?.destroy();
        markdownEditorHandle = undefined;
        markdownTocHandle?.dispose();
        markdownTocHandle = undefined;
    }

    function clear(): void {
        workspaceState = undefined;
        disposeHandles();
    }

    function readPayloadContent(payload: RenderPayload): string {
        return stripReadStatusLine(payload.content);
    }

    function syncStateFromContent(
        state: MarkdownWorkspaceState,
        content: string,
        options: { keepDraft?: boolean } = {}
    ): void {
        const nextDraftContent = options.keepDraft ? state.draftContent : content;
        state.sourceContent = content;
        state.fullDocumentContent = content;
        state.draftContent = nextDraftContent;
        state.outline = extractMarkdownOutline(content);
        state.dirty = nextDraftContent !== content;
        state.fileDeleted = false;
        if (!state.outline.some((item) => item.id === state.activeHeadingId)) {
            state.activeHeadingId = state.outline[0]?.id ?? null;
        }
    }

    async function callReadFile(filePath: string, length?: number, offset?: number): Promise<{ rawResult: unknown; payload: RenderPayload | null }> {
        const rawResult = await dependencies.callTool?.('read_file', {
            path: filePath,
            ...(typeof length === 'number' ? { offset: offset ?? 0, length } : {}),
        });
        return { rawResult, payload: extractRenderPayload(rawResult) ?? null };
    }

    async function readPayload(filePath: string, length?: number, offset?: number): Promise<RenderPayload | null> {
        return (await callReadFile(filePath, length, offset)).payload;
    }

    async function ensureCompletePayload(payload: RenderPayload): Promise<RenderPayload> {
        const range = parseReadRange(payload.content);
        if (!range?.isPartial) {
            return payload;
        }

        return (await readPayload(payload.filePath, range.totalLines)) ?? payload;
    }

    async function readCompletePayload(filePath: string): Promise<RenderPayload | null> {
        const payload = await readPayload(filePath);
        if (!payload) {
            return null;
        }

        return ensureCompletePayload(payload);
    }

    function getState(payload: RenderPayload): MarkdownWorkspaceState {
        const cleanedContent = stripReadStatusLine(payload.content);

        if (!workspaceState || workspaceState.filePath !== payload.filePath || workspaceState.sourceContent !== cleanedContent) {
            const outline = extractMarkdownOutline(cleanedContent);
            workspaceState = {
                filePath: payload.filePath,
                sourceContent: cleanedContent,
                fullDocumentContent: cleanedContent,
                draftContent: cleanedContent,
                outline,
                mode: 'edit',
                dirty: false,
                activeHeadingId: outline[0]?.id ?? null,
                pendingAnchor: null,
                notice: null,
                error: null,
                saving: false,
                loadingDocument: false,
                editorView: 'markdown',
                editorScrollTop: 0,
                saveIndicator: 'idle',
                fileDeleted: false,
            };
        }

        return workspaceState;
    }

    function isUndoAvailable(state: MarkdownWorkspaceState): boolean {
        return state.draftContent !== state.fullDocumentContent;
    }

    function buildBody(payload: RenderPayload): RenderBodyResult {
        const state = getState(payload);
        const outline = state.outline;
        const isFullscreen = dependencies.getCurrentDisplayMode() === 'fullscreen';
        const tocHtml = isFullscreen ? renderDocumentOutline(outline, state.activeHeadingId) : '';
        if (!state.activeHeadingId && outline.length > 0) {
            state.activeHeadingId = outline[0].id;
        }

        const notice = [state.error, state.notice]
            .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

        return {
            notice,
            html: `
              <div class="panel-content markdown-content markdown-content--workspace">
                <div class="markdown-workspace markdown-workspace--edit${tocHtml ? ' markdown-workspace--with-toc' : ''}">
                  ${tocHtml}
                  <section class="markdown-workspace-main markdown-workspace-main--editor">
                    ${renderMarkdownEditorShell({ view: state.editorView })}
                  </section>
                </div>
              </div>
            `,
        };
    }

    async function resolveLinkSearchRoot(filePath: string): Promise<string> {
        const ancestors = getAncestorDirectories(filePath);
        const markers = new Set(['[DIR] .git', '[DIR] .obsidian', '[FILE] package.json', '[FILE] pnpm-workspace.yaml', '[FILE] turbo.json']);

        for (const ancestor of ancestors) {
            try {
                const result = await dependencies.callTool?.('list_directory', { path: ancestor, depth: 1 });
                const text = extractToolText(result) ?? '';
                const entries = splitListingLines(text);
                if (entries.some((entry) => markers.has(entry))) {
                    return ancestor;
                }
            } catch {
                // Ignore and continue up the tree.
            }
        }

        return getParentDirectory(filePath);
    }

    async function searchLinkTargets(filePath: string, query: string): Promise<MarkdownLinkSearchItem[]> {
        const trimmedQuery = query.trim();
        if (trimmedQuery.length === 0) {
            return [];
        }

        const rootPath = await resolveLinkSearchRoot(filePath);
        const result = await dependencies.callTool?.('start_search', {
            path: rootPath,
            pattern: trimmedQuery,
            searchType: 'files',
            filePattern: '*.md',
            maxResults: 20,
            earlyTermination: false,
            literalSearch: true,
        });
        const text = extractToolText(result) ?? '';
        const filePaths = parseFileSearchResults(text);
        const currentDirectory = getParentDirectory(filePath);

        return filePaths.map((targetPath) => {
            const normalized = targetPath.replace(/\\/g, '/');
            const fileName = normalized.split('/').pop() ?? normalized;
            const title = stripMarkdownExtension(fileName);
            const relativePath = toPosixRelativePath(currentDirectory, normalized);
            const wikiPath = stripMarkdownExtension(relativePath.startsWith('./') ? relativePath.slice(2) : relativePath);
            return {
                path: normalized,
                title,
                wikiPath,
                relativePath,
            };
        });
    }

    async function loadLinkHeadings(currentPayloadPath: string, targetPath: string): Promise<MarkdownLinkHeading[]> {
        if (targetPath === currentPayloadPath && workspaceState) {
            return workspaceState.outline.map((item) => ({ id: item.id, text: item.text }));
        }

        const payload = await readCompletePayload(targetPath);
        if (!payload) {
            return [];
        }

        return extractMarkdownOutline(readPayloadContent(payload)).map((item) => ({ id: item.id, text: item.text }));
    }

    function findHeading(anchor: string): HTMLElement | null {
        const trimmedAnchor = anchor.trim();
        if (!trimmedAnchor) {
            return null;
        }

        return document.getElementById(trimmedAnchor) ?? document.getElementById(slugifyMarkdownHeading(trimmedAnchor));
    }

    function scrollHeadingIntoView(anchor: string): boolean {
        const heading = findHeading(anchor);
        if (!heading) {
            return false;
        }

        const scrollParents: HTMLElement[] = [];
        let current: HTMLElement | null = heading.parentElement;
        while (current) {
            const style = window.getComputedStyle(current);
            const overflowY = style.overflowY;
            const isScrollable = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
                && current.scrollHeight > current.clientHeight;
            if (isScrollable) {
                scrollParents.push(current);
            }
            current = current.parentElement;
        }

        heading.scrollIntoView({ block: 'start', inline: 'nearest' });

        for (const parent of scrollParents) {
            const parentRect = parent.getBoundingClientRect();
            const headingRect = heading.getBoundingClientRect();
            const nextTop = Math.max(parent.scrollTop + (headingRect.top - parentRect.top) - 24, 0);
            parent.scrollTop = nextTop;
        }

        const rootScroller = document.scrollingElement as HTMLElement | null;
        if (rootScroller) {
            const rootRectTop = heading.getBoundingClientRect().top;
            const nextRootTop = Math.max(rootScroller.scrollTop + rootRectTop - 24, 0);
            rootScroller.scrollTop = nextRootTop;
        }

        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
        if (workspaceState) {
            workspaceState.activeHeadingId = heading.id || slugifyMarkdownHeading(anchor);
        }
        return true;
    }

    function applyPendingAnchor(): void {
        const pendingAnchor = workspaceState?.pendingAnchor;
        if (!workspaceState || !pendingAnchor) {
            return;
        }

        workspaceState.pendingAnchor = null;
        if (!scrollHeadingIntoView(pendingAnchor)) {
            workspaceState.error = `Heading not found: ${pendingAnchor}`;
            dependencies.rerender();
        }
    }

    function flashSaveStatus(
        label: string,
        statusClass: string,
        timeoutMs: number,
        beforeClear?: () => boolean
    ): void {
        dependencies.updateSaveStatus(label, statusClass);
        window.setTimeout(() => {
            if (beforeClear && !beforeClear()) {
                return;
            }
            dependencies.updateSaveStatus('', '');
        }, timeoutMs);
    }

    async function refreshFromDisk(payload: RenderPayload): Promise<void> {
        try {
            const range = parseReadRange(payload.content);
            const { rawResult, payload: freshPayload } = range?.isPartial
                ? await callReadFile(payload.filePath, range.toLine - range.fromLine + 1, range.readOffset)
                : await callReadFile(payload.filePath);
            if (!freshPayload) {
                if (isMissingFileErrorResult(rawResult)) {
                    if (workspaceState) {
                        workspaceState.fileDeleted = true;
                    }
                    dependencies.updateSaveStatus('File deleted', 'saved');
                }
                return;
            }

            const freshContent = readPayloadContent(freshPayload);
            const currentContent = readPayloadContent(payload);
            if (freshContent === currentContent) {
                return;
            }

            // refreshFromDisk only runs at mount (no file watcher in this app),
            // so disk-vs-payload mismatch means the host sent a stale cached
            // payload — trust the disk read and reload silently.
            dependencies.storePayloadOverride(freshPayload);
            workspaceState = undefined;
            dependencies.rerender();
        } catch {
            // Silently fall back to host payload.
        }
    }

    async function loadFullDocument(payload: RenderPayload, options: { keepEditMode?: boolean } = {}): Promise<void> {
        const state = getState(payload);
        const range = parseReadRange(payload.content);
        if (!range?.isPartial) {
            if (options.keepEditMode) {
                state.mode = 'edit';
                state.editorView = 'markdown';
                state.notice = null;
                state.error = null;
                state.draftContent = state.sourceContent;
                state.dirty = false;
                dependencies.rerender();
            }
            return;
        }

        state.loadingDocument = true;
        state.notice = 'Loading full document…';
        state.error = null;
        dependencies.rerender();

        try {
            const nextPayload = await readPayload(payload.filePath, range.totalLines);
            if (!nextPayload) {
                state.error = 'Failed to load the full document.';
                state.notice = null;
                state.loadingDocument = false;
                dependencies.rerender();
                return;
            }

            dependencies.syncPayload?.(nextPayload);
            const nextState = getState(nextPayload);
            nextState.loadingDocument = false;
            nextState.notice = null;
            nextState.error = null;
            syncStateFromContent(nextState, nextState.sourceContent);
            if (options.keepEditMode) {
                nextState.mode = 'edit';
                nextState.editorView = 'markdown';
                dependencies.rerender();
            }
        } catch {
            state.loadingDocument = false;
            state.notice = null;
            state.error = 'Failed to load the full document.';
            dependencies.rerender();
        }
    }

    async function navigateLink(payload: RenderPayload, href: string): Promise<void> {
        const state = getState(payload);
        if (state.dirty) {
            const shouldDiscard = window.confirm('Discard unsaved changes and follow this link?');
            if (!shouldDiscard) {
                return;
            }
        }

        const resolvedLink = resolveMarkdownLink(payload.filePath, href);
        state.notice = null;
        state.error = null;

        if (resolvedLink.kind === 'external' && resolvedLink.url) {
            const opened = await dependencies.openExternalLink?.(resolvedLink.url);
            if (!opened) {
                try { window.open(resolvedLink.url, '_blank', 'noopener'); } catch { /* sandbox may block */ }
            }
            return;
        }

        if (resolvedLink.kind === 'anchor' && resolvedLink.anchor) {
            if (!scrollHeadingIntoView(resolvedLink.anchor) && workspaceState) {
                workspaceState.error = `Heading not found: ${resolvedLink.anchor}`;
                dependencies.rerender();
            }
            return;
        }

        if (resolvedLink.kind === 'file' && resolvedLink.targetPath) {
            const hostHandled = await dependencies.openExternalLink?.(resolvedLink.targetPath);
            if (hostHandled) {
                return;
            }

            const nextPayload = await readPayload(resolvedLink.targetPath);
            if (!nextPayload) {
                if (workspaceState) {
                    workspaceState.error = `Unable to open ${resolvedLink.targetPath}.`;
                    dependencies.rerender();
                }
                return;
            }

            dependencies.syncPayload?.(nextPayload);
            const nextState = getState(nextPayload);
            nextState.pendingAnchor = resolvedLink.anchor ?? null;
            nextState.error = null;
            nextState.notice = null;
            dependencies.rerender();
        }
    }

    async function requestEditMode(payload: RenderPayload): Promise<void> {
        const state = getState(payload);

        state.error = null;
        state.notice = null;

        if (shouldAutoLoadDocumentOnEnterFullscreen(payload.content)) {
            await loadFullDocument(payload, { keepEditMode: true });
            return;
        }

        state.mode = 'edit';
        state.draftContent = state.fullDocumentContent;
        state.dirty = false;
        state.editorView = 'markdown';
        dependencies.setExpanded(true);
        dependencies.rerender();
    }

    async function requestFullscreen(): Promise<boolean> {
        const fullscreenAvailability = getDocumentFullscreenAvailability({
            availableDisplayModes: dependencies.getAvailableDisplayModes(),
        });
        if (!fullscreenAvailability.canFullscreen) {
            return false;
        }
        const nextMode = await dependencies.requestDisplayMode?.('fullscreen');
        return nextMode === 'fullscreen';
    }

    function revertEditing(): void {
        if (!workspaceState) {
            return;
        }
        const filePath = workspaceState.filePath;
        workspaceState.draftContent = workspaceState.fullDocumentContent;
        workspaceState.dirty = false;
        workspaceState.error = null;
        workspaceState.notice = null;
        dependencies.rerender();
        flashSaveStatus('Reverted', 'saved', 1500);
        dependencies.trackUiEvent?.('markdown_reverted', {
            file_extension: getFileExtensionForAnalytics(filePath),
        });
    }

    async function saveDocument(): Promise<void> {
        if (!workspaceState || workspaceState.saving || !workspaceState.dirty || workspaceState.fileDeleted) {
            return;
        }
        const state = workspaceState;
        state.saving = true;
        state.saveIndicator = 'saving';
        state.error = null;
        state.notice = null;

        try {
            const blocks = computeEditBlocks(state.fullDocumentContent, state.draftContent);
            if (blocks.length === 0) {
                state.saving = false;
                state.saveIndicator = 'idle';
                state.dirty = false;
                return;
            }

            for (const block of blocks) {
                const editResult = await dependencies.callTool?.('edit_block', {
                    file_path: state.filePath,
                    old_string: block.old_string,
                    new_string: block.new_string,
                    expected_replacements: 1,
                });
                assertSuccessfulEditBlockResult(editResult);
            }

            state.fullDocumentContent = state.draftContent;
            state.sourceContent = state.draftContent;
            state.outline = extractMarkdownOutline(state.sourceContent);
            state.dirty = false;
            state.saving = false;
            state.saveIndicator = 'saved';
            if (!state.outline.some((item) => item.id === state.activeHeadingId)) {
                state.activeHeadingId = state.outline[0]?.id ?? null;
            }

            const savedContent = state.draftContent;
            const currentPayload = dependencies.getCurrentPayload();
            if (currentPayload) {
                const statusLineMatch = currentPayload.content.match(/^(\[Reading [^\]]+\]\r?\n(?:\r?\n)?)/);
                const statusLine = statusLineMatch?.[1] ?? '';
                dependencies.storePayloadOverride({ ...currentPayload, content: statusLine + savedContent });
            }

            const revert = document.getElementById('revert-markdown') as HTMLButtonElement | null;
            if (revert) {
                revert.disabled = !isUndoAvailable(state);
            }
            flashSaveStatus('Saved', 'saved', 1800, () => {
                if (!state.dirty && !state.saving) {
                    state.saveIndicator = 'idle';
                    return true;
                }
                return false;
            });
            dependencies.trackUiEvent?.('markdown_saved', {
                file_extension: getFileExtensionForAnalytics(state.filePath),
                blocks: blocks.length,
            });
        } catch (error) {
            state.saving = false;
            state.saveIndicator = 'idle';
            const freshPayload = await readCompletePayload(state.filePath).catch(() => null);
            let reloadedFromDisk = false;
            if (freshPayload) {
                const freshContent = readPayloadContent(freshPayload);
                if (freshContent !== state.fullDocumentContent) {
                    syncStateFromContent(state, freshContent, { keepDraft: true });
                    dependencies.storePayloadOverride(freshPayload);
                    reloadedFromDisk = true;
                }
            }

            state.notice = null;
            state.error = reloadedFromDisk
                ? 'Save failed. Reloaded the file from disk.'
                : error instanceof Error ? error.message : 'Save failed.';
            dependencies.rerender();
            flashSaveStatus('Save failed', 'saving', 3000);
            dependencies.trackUiEvent?.('markdown_save_failed', {
                file_extension: getFileExtensionForAnalytics(state.filePath),
                reloaded_from_disk: reloadedFromDisk,
            });
        }
    }

    function setEditorView(payload: RenderPayload, view: MarkdownEditorView): void {
        const state = getState(payload);
        const wrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
        state.editorScrollTop = wrapper?.scrollTop ?? 0;
        const previousView = state.editorView;
        state.editorView = view;
        state.notice = null;
        state.error = null;
        dependencies.rerender();
        if (previousView !== view) {
            dependencies.trackUiEvent?.('markdown_view_toggled', {
                file_extension: getFileExtensionForAnalytics(payload.filePath),
                view,
            });
        }
        if (typeof state.editorScrollTop === 'number') {
            window.requestAnimationFrame(() => {
                const nextWrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
                if (nextWrapper) {
                    nextWrapper.scrollTop = state.editorScrollTop;
                }
            });
        }
    }

    function attachHandlers(payload: RenderPayload): void {
        const state = getState(payload);
        const wrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
        const outline = state.outline;
        const fileExtension = getFileExtensionForAnalytics(payload.filePath);
        let editStartedFired = false;

        {
            const editorRoot = document.getElementById('markdown-editor-root');
            if (editorRoot) {
                markdownEditorHandle = mountMarkdownEditor({
                    target: editorRoot,
                    value: state.draftContent,
                    view: state.editorView,
                    initialScrollTop: state.editorScrollTop,
                    currentFilePath: payload.filePath,
                    searchLinks: (query) => searchLinkTargets(payload.filePath, query),
                    loadHeadings: (targetPath) => loadLinkHeadings(payload.filePath, targetPath),
                    onChange: (value) => {
                        state.draftContent = value;
                        state.dirty = value !== state.fullDocumentContent;
                        if (state.dirty && !editStartedFired) {
                            editStartedFired = true;
                            dependencies.trackUiEvent?.('markdown_edit_started', {
                                file_extension: fileExtension,
                                view: state.editorView,
                            });
                        }
                        const nextOutline = extractMarkdownOutline(value);
                        if (!areOutlineItemsEqual(state.outline, nextOutline)) {
                            state.outline = nextOutline;
                            if (!state.outline.some((item) => item.id === state.activeHeadingId)) {
                                state.activeHeadingId = state.outline[0]?.id ?? null;
                            }
                            markdownTocHandle?.refresh(state.outline, state.activeHeadingId);
                        }
                        if (state.dirty && state.saveIndicator === 'saved') {
                            state.saveIndicator = 'idle';
                        }
                        const revert = document.getElementById('revert-markdown') as HTMLButtonElement | null;
                        if (revert) {
                            revert.disabled = !isUndoAvailable(state);
                        }
                    },
                    onBlur: () => {
                        void saveDocument();
                    },
                });
                markdownEditorHandle.focus();
            }

            const revertButton = document.getElementById('revert-markdown') as HTMLButtonElement | null;
            revertButton?.addEventListener('click', () => {
                revertEditing();
            });

            const rawModeButton = document.getElementById('markdown-mode-raw') as HTMLButtonElement | null;
            rawModeButton?.addEventListener('click', () => {
                setEditorView(payload, 'raw');
            });

            const previewModeButton = document.getElementById('markdown-mode-markdown') as HTMLButtonElement | null;
            previewModeButton?.addEventListener('click', () => {
                setEditorView(payload, 'markdown');
            });
        }

        const expandButton = document.getElementById('expand-fullscreen') as HTMLButtonElement | null;
        expandButton?.addEventListener('click', () => {
            void requestFullscreen();
        });

        if (wrapper) {
            wrapper.addEventListener('click', (event) => {
                const target = event.target as HTMLElement | null;
                const link = target?.closest<HTMLAnchorElement>('a[href]');
                if (!link || !link.closest('.markdown-doc')) {
                    return;
                }
                const href = link.getAttribute('href');
                if (!href) {
                    return;
                }

                event.preventDefault();
                void navigateLink(payload, href);
            });
        }

        const tocShell = document.querySelector('.document-outline-shell') as HTMLElement | null;
        if (tocShell && wrapper) {
            markdownTocHandle = attachDocumentOutline({
                shell: tocShell,
                outline,
                scrollContainer: wrapper,
                onSelect: (headingId) => {
                    const selectedHeading = state.outline.find((item) => item.id === headingId);
                    if (selectedHeading && typeof selectedHeading.line === 'number') {
                        markdownEditorHandle?.revealLine(selectedHeading.line, selectedHeading.id);
                        state.activeHeadingId = selectedHeading.id;
                    }
                },
            }) ?? undefined;
        }

        window.setTimeout(() => {
            applyPendingAnchor();
        }, 0);
    }

    function getCopyText(payload: RenderPayload): string | null {
        const state = getState(payload);
        const source = state.draftContent;
        return state.editorView === 'raw'
            ? source
            : (getRenderedMarkdownCopyText(source) || source);
    }

    async function handleInlineExitFromFullscreen(originalPayload?: RenderPayload): Promise<RenderPayload | undefined> {
        const wasDirty = workspaceState?.saveIndicator === 'saved' || workspaceState?.dirty;
        if (workspaceState) {
            workspaceState.notice = null;
            workspaceState.editorView = 'markdown';
        }
        if (wasDirty && originalPayload) {
            const range = parseReadRange(originalPayload.content);
            if (range?.isPartial) {
                const freshPayload = await readPayload(originalPayload.filePath, range.toLine - range.fromLine + 1, range.readOffset);
                if (freshPayload) {
                    return freshPayload;
                }
            }
        }
        return undefined;
    }

    return {
        attachHandlers,
        buildBody,
        clear,
        disposeHandles,
        ensureCompletePayload,
        getCopyText,
        getState,
        handleInlineExitFromFullscreen,
        isUndoAvailable,
        readCompletePayload,
        readPayload,
        readPayloadContent,
        refreshFromDisk,
        requestEditMode,
        requestFullscreen,
        saveDocument,
        setEditorView,
    };
}

export type MarkdownController = ReturnType<typeof createMarkdownController>;
