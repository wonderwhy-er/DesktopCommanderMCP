/**
 * Composition root for the File Preview app. It wires host services, file-type handlers, and specialized controllers together without owning feature logic inline.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createCompactRowShellController, type ToolShellController } from '../../shared/tool-shell.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { renderCompactRow } from '../../shared/compact-row.js';
import { connectWithSharedHostContext, type UiChromeState } from '../../shared/host-context.js';
import { createUiEventTracker } from '../../shared/ui-event-tracker.js';
import { attachDirectoryHandlers } from './directory-controller.js';
import { buildDocumentLayout } from './document-layout.js';
import { getDocumentFullscreenAvailability, parseReadRange, stripReadStatusLine } from './document-workspace.js';
import { getFileTypeCapabilities, renderPayloadBody } from './file-type-handlers.js';
import { buildOpenInEditorCommand, buildOpenInFolderCommand, detectDefaultMarkdownEditor, renderMarkdownEditorAppIcon } from './host/external-actions.js';
import { attachSelectionContext } from './host/selection-context.js';
import { createMarkdownController } from './markdown/controller.js';
import {
    createConflictDialogController,
    renderConflictDialogMarkup,
    type ConflictDialogController,
} from './markdown/conflict-dialog.js';
import type { RenderPayload } from './model.js';
import { attachPanelActions } from './panel-actions.js';
import { extractRenderPayload, extractToolText, getFileExtensionForAnalytics, isLikelyUrl, isPreviewStructuredContent } from './payload-utils.js';
import type { HtmlPreviewMode } from './types.js';

let isExpanded = false;
let hideSummaryRow = false;
let previewShownFired = false;
let onRender: (() => void) | undefined;
let trackUiEvent: ((event: string, params?: Record<string, unknown>) => void) | undefined;
let conflictDialogController: ConflictDialogController | undefined;
let rpcCallTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let rpcUpdateContext: ((text: string) => void) | undefined;
let openExternalLink: ((url: string) => Promise<boolean>) | undefined;
let requestDisplayMode: ((mode: 'inline' | 'fullscreen') => Promise<string | null>) | undefined;
let shellController: ToolShellController | undefined;
let currentPayload: RenderPayload | undefined;
let currentHtmlMode: HtmlPreviewMode = 'rendered';
let currentHostContext: Record<string, unknown> | undefined;
let rerenderCurrent: (() => void) | undefined;
let syncPayload: ((payload?: RenderPayload) => void) | undefined;
let persistPayload: ((payload: RenderPayload) => void) | undefined;
let localPayloadOverride: RenderPayload | undefined;
let hostPayload: RenderPayload | undefined;
let inlinePayloadBeforeFullscreen: RenderPayload | undefined;
let directoryBackPayload: RenderPayload | undefined;
let selectionAbortController: AbortController | null = null;
const markdownEditorAppCache = new Map<string, { appName: string; appPath?: string }>();
const markdownEditorAppPending = new Set<string>();

async function callToolIfReady(name: string, args: Record<string, unknown>): Promise<unknown | undefined> {
    return rpcCallTool ? rpcCallTool(name, args) : undefined;
}

function getAvailableDisplayModes(): string[] {
    const rawModes = currentHostContext?.availableDisplayModes;
    if (!Array.isArray(rawModes)) {
        return [];
    }

    return rawModes.filter((mode): mode is string => typeof mode === 'string');
}

function getCurrentDisplayMode(): string | null {
    return typeof currentHostContext?.displayMode === 'string'
        ? currentHostContext.displayMode
        : null;
}

function storePayloadOverride(payload: RenderPayload): void {
    localPayloadOverride = payload;
    currentPayload = payload;
    persistPayload?.(payload);
}

function getEffectiveIncomingPayload(payload: RenderPayload): RenderPayload {
    if (!localPayloadOverride) {
        return payload;
    }

    if (localPayloadOverride.filePath !== payload.filePath) {
        localPayloadOverride = undefined;
        return payload;
    }

    const incomingContent = stripReadStatusLine(payload.content);
    const overriddenContent = stripReadStatusLine(localPayloadOverride.content);
    if (incomingContent === overriddenContent) {
        return payload;
    }

    return localPayloadOverride;
}

function updateSaveStatusDOM(label: string, statusClass: string): void {
    const existing = document.querySelector('.panel-save-status') as HTMLElement | null;
    if (label) {
        if (existing) {
            existing.textContent = label;
            existing.className = `panel-save-status panel-save-status--${statusClass}`;
        } else {
            const actions = document.querySelector('.panel-topbar-actions') as HTMLElement | null;
            if (actions) {
                const span = document.createElement('span');
                span.className = `panel-save-status panel-save-status--${statusClass}`;
                span.textContent = label;
                actions.prepend(span);
            }
        }
    } else if (existing) {
        existing.remove();
    }
}

const markdownController = createMarkdownController({
    callTool: callToolIfReady,
    openExternalLink: async (url) => (openExternalLink ? openExternalLink(url) : undefined),
    requestDisplayMode: async (mode) => (requestDisplayMode ? requestDisplayMode(mode) : undefined),
    getAvailableDisplayModes,
    getCurrentDisplayMode,
    getCurrentPayload: () => currentPayload,
    setExpanded: (expanded) => {
        isExpanded = expanded;
    },
    syncPayload: (payload) => syncPayload?.(payload),
    storePayloadOverride,
    rerender: () => {
        rerenderCurrent?.();
    },
    updateSaveStatus: updateSaveStatusDOM,
    trackUiEvent: (event, params) => trackUiEvent?.(event, params),
    showConflictDialog: (options) => {
        if (conflictDialogController) {
            conflictDialogController.open(options);
            return;
        }
        // Dialog not yet initialized (would only happen if the save failure
        // somehow fires before bootstrapApp). Fall back to the cancel callback
        // so the editor still shows its inline note instead of silently no-op'ing.
        console.warn('[file-preview] conflictDialogController not ready; firing onCancel fallback');
        options.onCancel?.();
    },
});

/**
 * Check if a payload needs its file content to be read.
 * Tool results from edit_block/write_file include structuredContent but
 * their text is a success message, not file content. Detect this by
 * checking for the absence of the read status line that read_file always includes.
 * URL payloads are fetched remotely by read_file(isUrl:true); we can't
 * re-fetch them from here (no isUrl flag on the refresh path), so skip.
 */
function needsContentRead(payload: RenderPayload): boolean {
    if (payload.fileType === 'directory' || payload.fileType === 'image' || payload.fileType === 'unsupported') {
        return false;
    }
    if (/^https?:\/\//i.test(payload.filePath)) {
        return false;
    }
    return !parseReadRange(payload.content);
}

async function readAndResolvePayload(
    payload: RenderPayload,
    onReady: (payload: RenderPayload) => void
): Promise<void> {
    try {
        const freshPayload = await markdownController.readPayload(payload.filePath);
        if (freshPayload) {
            onReady(freshPayload);
            if (freshPayload.fileType === 'markdown') {
                void markdownController.refreshFromDisk(freshPayload);
            }
            return;
        }
    } catch {
        // Fall through to original payload.
    }
    onReady(payload);
}

function renderStatusState(container: HTMLElement, message: string): void {
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: message, variant: 'status', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
}

function renderLoadingState(container: HTMLElement): void {
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: 'Preparing preview…', variant: 'loading', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
}

export function renderApp(
    container: HTMLElement,
    payload?: RenderPayload,
    htmlMode: HtmlPreviewMode = 'rendered',
    expandedState = false
): void {
    isExpanded = expandedState;
    currentHtmlMode = htmlMode;
    shellController?.dispose();
    shellController = undefined;

    if (!payload || payload.fileType !== 'markdown') {
        markdownController.clear();
    } else {
        markdownController.disposeHandles();
    }

    if (!payload) {
        selectionAbortController?.abort();
        selectionAbortController = null;
        currentPayload = undefined;
        renderStatusState(container, 'No preview available for this response.');
        onRender?.();
        return;
    }

    currentPayload = payload;
    const capabilities = getFileTypeCapabilities(payload);
    if (!capabilities.supportsPreview && hideSummaryRow) {
        isExpanded = false;
    }

    const range = parseReadRange(payload.content);
    const body = renderPayloadBody({
        payload,
        htmlMode,
        startLine: range?.fromLine ?? 1,
        markdownController,
    });
    const markdownWorkspace = payload.fileType === 'markdown' ? markdownController.getState(payload) : undefined;
    const fileExtension = getFileExtensionForAnalytics(payload.filePath);
    const isFullscreen = getCurrentDisplayMode() === 'fullscreen';
    const canGoFullscreen = !isFullscreen && getDocumentFullscreenAvailability({
        availableDisplayModes: getAvailableDisplayModes(),
    }).canFullscreen;

    const defaultMarkdownEditor = payload.fileType === 'markdown'
        ? markdownEditorAppCache.get(payload.filePath)
        : undefined;
    if (payload.fileType === 'markdown' && !defaultMarkdownEditor) {
        void detectDefaultMarkdownEditor({
            filePath: payload.filePath,
            editorAppCache: markdownEditorAppCache,
            editorAppPending: markdownEditorAppPending,
            callTool: callToolIfReady,
            extractToolText,
            onDetected: () => {
                rerenderCurrent?.();
            },
        });
    }

    const layout = buildDocumentLayout({
        payload,
        body,
        capabilities,
        fileExtension,
        htmlMode,
        currentDisplayMode: getCurrentDisplayMode(),
        isExpanded,
        hideSummaryRow,
        markdownWorkspace,
        canGoFullscreen,
        isMarkdownUndoAvailable: markdownWorkspace ? markdownController.isUndoAvailable(markdownWorkspace) : false,
        defaultMarkdownEditorName: defaultMarkdownEditor?.appName,
        markdownEditorAppIcon: renderMarkdownEditorAppIcon(),
        hasDirectoryBackButton: Boolean(directoryBackPayload),
    });

    container.innerHTML = layout.html;
    document.body.classList.add('dc-ready');

    attachPanelActions({
        container,
        payload,
        htmlMode,
        getIsExpanded: () => isExpanded,
        callTool: callToolIfReady,
        trackUiEvent,
        getFileExtensionForAnalytics,
        buildOpenInFolderCommand: (filePath) => buildOpenInFolderCommand(filePath, isLikelyUrl),
        buildOpenInEditorCommand: (filePath) => buildOpenInEditorCommand(filePath, isLikelyUrl, markdownEditorAppCache),
        render: (nextPayload, nextHtmlMode = 'rendered', nextExpanded = isExpanded) => {
            renderApp(container, nextPayload, nextHtmlMode, nextExpanded);
        },
        updateSaveStatus: updateSaveStatusDOM,
        markdownController,
    });

    if (payload.fileType === 'markdown') {
        markdownController.attachHandlers(payload);
    }

    selectionAbortController = attachSelectionContext({
        payload,
        isMarkdownEditing: payload.fileType === 'markdown' && !!markdownWorkspace,
        updateContext: rpcUpdateContext,
        trackUiEvent,
        getFileExtensionForAnalytics,
        previousAbortController: selectionAbortController,
    });

    if (payload.fileType === 'directory') {
        attachDirectoryHandlers({
            container,
            callTool: callToolIfReady,
            buildOpenInFolderCommand: (filePath) => buildOpenInFolderCommand(filePath, isLikelyUrl),
            onOpenPayload: (nextPayload) => {
                directoryBackPayload = payload;
                renderApp(container, nextPayload, 'rendered', true);
            },
        });
    }

    const backBtn = document.getElementById('dir-back');
    if (backBtn && directoryBackPayload) {
        const savedPayload = directoryBackPayload;
        backBtn.addEventListener('click', () => {
            directoryBackPayload = undefined;
            renderApp(container, savedPayload, 'rendered', true);
        });
    }
    if (payload.fileType === 'directory') {
        directoryBackPayload = undefined;
    }

    const compactRow = document.getElementById('compact-toggle') as HTMLElement | null;
    shellController = createCompactRowShellController({
        shell: document.getElementById('tool-shell'),
        compactRow,
        initialExpanded: layout.effectiveExpanded,
        onToggle: (expanded) => {
            isExpanded = expanded;
            trackUiEvent?.(expanded ? 'expand' : 'collapse', {
                file_type: payload.fileType,
                file_extension: fileExtension,
            });
        },
        onScrollAfterExpand: () => {
            trackUiEvent?.('scroll_after_expand', {
                file_type: payload.fileType,
                file_extension: fileExtension,
            });
        },
        onRender,
    });
    onRender?.();
    if (!previewShownFired) {
        previewShownFired = true;
        trackUiEvent?.('preview_shown', {
            file_type: payload.fileType,
            file_extension: fileExtension,
        });
    }
}

export function bootstrapApp(): void {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    renderLoadingState(container);

    // Mount the conflict dialog once at body level. It's position: fixed and
    // must live outside the app container so that re-renders of the document
    // body never wipe it while it's open.
    if (!document.getElementById('md-conflict-modal')) {
        const dialogHost = document.createElement('div');
        dialogHost.innerHTML = renderConflictDialogMarkup();
        const dialogRoot = dialogHost.firstElementChild;
        if (dialogRoot) {
            document.body.appendChild(dialogRoot);
        }
    }
    conflictDialogController = createConflictDialogController({ container: document });

    const app = new App(
        { name: 'Desktop Commander File Preview', version: '1.0.0' },
        { updateModelContext: { text: {} } },
        { autoResize: true },
    );

    const chrome: UiChromeState = {
        expanded: isExpanded,
        hideSummaryRow,
    };
    const syncChromeState = (): void => {
        isExpanded = chrome.expanded;
        hideSummaryRow = chrome.hideSummaryRow;
    };

    const widgetState = createWidgetStateStorage<RenderPayload>(
        (value): value is RenderPayload => isPreviewStructuredContent(value) && typeof (value as any).content === 'string'
    );

    const renderAndSync = (payload?: RenderPayload): void => {
        if (payload) {
            widgetState.write(payload);
        }
        renderApp(container, payload, 'rendered', isExpanded);
    };
    const syncFromPersistedWidgetState = (): void => {
        const persistedPayload = widgetState.read();
        if (!persistedPayload) {
            return;
        }

        if (
            currentPayload
            && currentPayload.filePath === persistedPayload.filePath
            && stripReadStatusLine(currentPayload.content) === stripReadStatusLine(persistedPayload.content)
        ) {
            return;
        }

        renderAndSync(persistedPayload);
    };

    syncPayload = renderAndSync;
    persistPayload = (payload: RenderPayload) => {
        widgetState.write(payload);
    };
    rerenderCurrent = () => {
        renderApp(container, currentPayload, currentHtmlMode, isExpanded);
    };

    let pendingCachedPayload: RenderPayload | undefined;
    let initialStateResolved = false;
    const resolveInitialState = (payload?: RenderPayload, message?: string): void => {
        if (initialStateResolved) {
            return;
        }
        initialStateResolved = true;
        if (payload) {
            hostPayload = payload;
            renderAndSync(payload);
            if (payload.fileType === 'markdown' && getCurrentDisplayMode() === 'fullscreen') {
                void markdownController.requestEditMode(payload);
            }
            if (payload.fileType === 'markdown') {
                void markdownController.refreshFromDisk(payload);
            }
            return;
        }
        renderStatusState(container, message ?? 'No preview available for this response.');
        onRender?.();
    };

    onRender = () => {};

    rpcCallTool = (name: string, args: Record<string, unknown>): Promise<unknown> => (
        app.callServerTool({ name, arguments: args })
    );
    rpcUpdateContext = (text: string): void => {
        const params = text
            ? { content: [{ type: 'text' as const, text }] }
            : { content: [] as [] };
        app.updateModelContext(params).catch(() => {
            // Host may not support updateModelContext.
        });
    };
    openExternalLink = async (url: string): Promise<boolean> => {
        const result = await app.openLink({ url });
        return result.isError !== true;
    };
    requestDisplayMode = async (mode: 'inline' | 'fullscreen'): Promise<string | null> => {
        const result = await app.requestDisplayMode({ mode });
        return typeof result.mode === 'string' ? result.mode : null;
    };
    trackUiEvent = createUiEventTracker(
        (name, args) => app.callServerTool({ name, arguments: args }),
        {
            component: 'file_preview',
            baseParams: { tool_name: 'read_file' },
        }
    );

    app.ontoolinput = (params) => {
        const requestedPath = typeof params.arguments?.path === 'string' ? params.arguments.path : undefined;
        if (
            !initialStateResolved
            && pendingCachedPayload
            && requestedPath
            && pendingCachedPayload.filePath === requestedPath
        ) {
            const cached = pendingCachedPayload;
            pendingCachedPayload = undefined;
            resolveInitialState(cached);
            return;
        }

        renderLoadingState(container);
        onRender?.();
    };

    app.ontoolresult = (result) => {
        pendingCachedPayload = undefined;
        const payload = extractRenderPayload(result);
        const message = extractToolText(result as unknown as Record<string, unknown>);
        if (!initialStateResolved) {
            if (payload) {
                if (needsContentRead(payload)) {
                    void readAndResolvePayload(payload, (p) => resolveInitialState(getEffectiveIncomingPayload(p)));
                    return;
                }
                resolveInitialState(getEffectiveIncomingPayload(payload));
                return;
            }
            if (message) {
                resolveInitialState(undefined, message);
            }
            return;
        }

        if (payload) {
            if (needsContentRead(payload)) {
                renderLoadingState(container);
                void readAndResolvePayload(payload, (p) => renderAndSync(getEffectiveIncomingPayload(p)));
            } else {
                renderAndSync(getEffectiveIncomingPayload(payload));
            }
        } else if (message) {
            renderStatusState(container, message);
            onRender?.();
        }
    };

    app.ontoolcancelled = (params) => {
        resolveInitialState(undefined, params.reason ?? 'Tool was cancelled.');
    };

    const handleVisibilitySync = (): void => {
        if (document.visibilityState === 'visible') {
            syncFromPersistedWidgetState();
        }
    };
    const handleFocusSync = (): void => {
        // Only sync cross-tab state if the page was hidden (tab switch).
        // Simple focus changes within the same page should not trigger a re-render
        // as it destroys the active editor.
        if (document.visibilityState !== 'visible') {
            syncFromPersistedWidgetState();
        }
    };

    const teardown = (): void => {
        shellController?.dispose();
        shellController = undefined;
        markdownController.disposeHandles();
        selectionAbortController?.abort();
        selectionAbortController = null;
        document.removeEventListener('visibilitychange', handleVisibilitySync);
        window.removeEventListener('focus', handleFocusSync);
    };

    document.addEventListener('visibilitychange', handleVisibilitySync);
    window.addEventListener('focus', handleFocusSync);

    app.onteardown = async () => {
        teardown();
        return {};
    };

    void connectWithSharedHostContext({
        app,
        chrome,
        onContextApplied: () => {
            const previousDisplayMode = getCurrentDisplayMode();
            syncChromeState();
            currentHostContext = app.getHostContext() as Record<string, unknown> | undefined;
            const nextDisplayMode = getCurrentDisplayMode();
            const displayModeChanged = previousDisplayMode !== nextDisplayMode;
            // Clicking a display-mode button blurs the editor first, and the
            // editor's onBlur handler already persists dirty drafts, so there
            // is nothing additional to save here.
            if (
                previousDisplayMode === 'fullscreen'
                && nextDisplayMode === 'inline'
                && currentPayload?.fileType === 'markdown'
            ) {
                isExpanded = true;
                chrome.expanded = true;
                const restorePayload = inlinePayloadBeforeFullscreen ?? hostPayload;
                const restoreWasPartial = restorePayload ? parseReadRange(restorePayload.content)?.isPartial === true : false;
                if (restoreWasPartial && restorePayload) {
                    localPayloadOverride = restorePayload;
                    currentPayload = restorePayload;
                    widgetState.write(restorePayload);
                    void markdownController.handleInlineExitFromFullscreen(restorePayload).then((freshPayload) => {
                        if (freshPayload) {
                            currentPayload = freshPayload;
                            localPayloadOverride = freshPayload;
                            widgetState.write(freshPayload);
                            rerenderCurrent?.();
                        }
                    });
                } else {
                    void markdownController.handleInlineExitFromFullscreen();
                }
                inlinePayloadBeforeFullscreen = undefined;
            }
            if (
                previousDisplayMode !== 'fullscreen'
                && nextDisplayMode === 'fullscreen'
                && currentPayload?.fileType === 'markdown'
            ) {
                inlinePayloadBeforeFullscreen = currentPayload;
                if (parseReadRange(currentPayload.content)?.isPartial) {
                    void markdownController.requestEditMode(currentPayload);
                }
            }
            if (initialStateResolved && displayModeChanged) {
                rerenderCurrent?.();
            }
        },
        onConnected: () => {
            currentHostContext = app.getHostContext() as Record<string, unknown> | undefined;
            pendingCachedPayload = widgetState.read() ?? undefined;

            window.setTimeout(() => {
                if (!initialStateResolved) {
                    resolveInitialState(
                        undefined,
                        'Preview unavailable after page refresh. Switch threads or re-run the tool.'
                    );
                }
            }, 8000);
        },
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });

    window.addEventListener('beforeunload', () => {
        teardown();
    }, { once: true });
}
