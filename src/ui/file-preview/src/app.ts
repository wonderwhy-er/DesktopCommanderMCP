/**
 * Composition root for the File Preview app. It wires host services, file-type handlers, and specialized controllers together without owning feature logic inline.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createCompactRowShellController, type ToolShellController } from '../../shared/tool-shell.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { renderCompactRow } from '../../shared/compact-row.js';
import { escapeHtml } from '../../shared/escape-html.js';
import { createLazyPreviewState, createLazyStateFromLegacy, isLazyPreviewState, type LazyPreviewState } from './lazy-preview-state.js';
import { connectWithSharedHostContext, type UiChromeState } from '../../shared/host-context.js';
import { createUiEventTracker } from '../../shared/ui-event-tracker.js';
import { attachDirectoryHandlers } from './directory-controller.js';
import { buildDocumentLayout } from './document-layout.js';
import { getDocumentFullscreenAvailability, parseReadRange, stripReadStatusLine } from './document-workspace.js';
import { getFileTypeCapabilities, renderPayloadBody } from './file-type-handlers.js';
import { buildOpenInEditorCommand, buildOpenInFolderCommand, renderMarkdownEditorAppIcon } from './host/external-actions.js';
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
let onRender: (() => void) | undefined;
let trackUiEvent: ((event: string, params?: Record<string, unknown>) => void) | undefined;
let conflictDialogController: ConflictDialogController | undefined;
let rpcCallTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let rpcUpdateContext: ((text: string) => void) | undefined;
let openExternalLink: ((url: string) => Promise<boolean>) | undefined;
let requestDisplayMode: ((mode: 'inline' | 'fullscreen') => Promise<string | null>) | undefined;
let shellController: ToolShellController | undefined;
let unloadPreview: (() => void) | undefined;
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

function getTelemetryToolName(payload: RenderPayload | undefined): string {
    return typeof payload?.sourceTool === 'string' ? payload.sourceTool : 'read_file';
}

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

// Only read_file's own parameters may ride along on a re-read. Forwarding a
// different tool's args (e.g. edit_block's old_string) makes the server prepend
// an "unsupported params" warning that would pollute the pulled content.
const READ_ARG_KEYS = ['path', 'offset', 'length', 'sheet', 'range', 'isUrl'] as const;

function pickReadArgs(args: unknown): Record<string, unknown> | undefined {
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    const src = args as Record<string, unknown>;
    // edit_block calls the file "file_path"; read_file/write_file call it "path".
    const path = typeof src.path === 'string'
        ? src.path
        : typeof src.file_path === 'string'
            ? src.file_path
            : undefined;
    if (!path) {
        return undefined;
    }
    const out: Record<string, unknown> = { path };
    for (const key of READ_ARG_KEYS) {
        if (key !== 'path' && src[key] !== undefined) {
            out[key] = src[key];
        }
    }
    return out;
}

// The host doesn't send the tool name with tool-input, so infer mutations from
// their arg shape: write_file carries `content`; edit_block `old_string`/
// `new_string`. Drives two things: timing (a mutation's tool-input arrives
// BEFORE the file changes, so those pull at tool-result time instead of input
// time) and telemetry (the pulled payload's sourceTool is re-stamped with the
// originating tool, since the pull itself is always a read_file).
function inferMutationTool(args: unknown): 'write_file' | 'edit_block' | undefined {
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    const src = args as Record<string, unknown>;
    if (src.old_string !== undefined || src.new_string !== undefined) {
        return 'edit_block';
    }
    if (src.content !== undefined) {
        return 'write_file';
    }
    return undefined;
}

// Bound the RPC read so a stalled host response resolves to onFail instead of
// hanging. Kept under the loading watchdog (PREVIEW_WATCHDOG_MS) so the pull
// gets its chance to fail before the failure row appears.
const PULL_TIMEOUT_MS = 8000;

// One in-flight pull per path — the input-time pull and a tool-result-triggered
// pull for the same call would otherwise read the file twice.
let pullInFlightPath: string | undefined;

/**
 * The widget's render path: pull content + metadata over the RPC channel
 * (`app.callServerTool` with origin:'ui'). The notification channel is not used
 * for rendering — the host may strip structuredContent from it or swallow it
 * entirely (images). `args` reproduces the original read exactly
 * (offset/length/sheet/range/isUrl) so partial reads stay faithful.
 */
async function pullPayloadByArgs(
    args: Record<string, unknown>,
    onReady: (payload: RenderPayload) => void,
    onFail: () => void
): Promise<void> {
    const filePath = typeof args.path === 'string' ? args.path : undefined;
    if (!filePath) {
        onFail();
        return;
    }
    if (pullInFlightPath === filePath) {
        return;
    }
    pullInFlightPath = filePath;
    try {
        // The host can hold the RPC response indefinitely (e.g. it preempts
        // delivery to inline-render an image), so callServerTool would await
        // forever with no throw. Race a timeout so the pull settles either way.
        const raw = await Promise.race([
            callToolIfReady('read_file', { ...args, origin: 'ui' }),
            new Promise<never>((_resolve, reject) => {
                setTimeout(
                    () => reject(new Error(`RPC read_file did not respond within ${PULL_TIMEOUT_MS}ms`)),
                    PULL_TIMEOUT_MS,
                );
            }),
        ]);
        const payload = extractRenderPayload(raw);
        if (payload) {
            onReady(payload);
            return;
        }
    } catch {
        // Timed out or rejected — fall through to the caller's fallback.
    } finally {
        pullInFlightPath = undefined;
    }
    onFail();
}

// If a loading state hasn't resolved into a real render within this window, the
// host most likely never delivered the tool result / RPC response (e.g. it
// preempted delivery to inline-render an image). Rather than sit on "Preparing
// preview…" forever, we surface a failure row.
const PREVIEW_WATCHDOG_MS = 10000;
let previewWatchdogId: ReturnType<typeof setTimeout> | undefined;

function clearPreviewWatchdog(): void {
    if (previewWatchdogId !== undefined) {
        clearTimeout(previewWatchdogId);
        previewWatchdogId = undefined;
    }
}

function renderStatusState(container: HTMLElement, message: string): void {
    clearPreviewWatchdog();
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
    // Fall back to a failure row if nothing renders in time. Any successful
    // render (renderApp) or explicit status clears this first.
    clearPreviewWatchdog();
    previewWatchdogId = setTimeout(() => {
        previewWatchdogId = undefined;
        renderStatusState(container, 'Unable to generate preview in this environment.');
    }, PREVIEW_WATCHDOG_MS);
}

function ensureConflictDialogController(): void {
    if (conflictDialogController) return;
    if (!document.getElementById('md-conflict-modal')) {
        const dialogHost = document.createElement('div');
        dialogHost.innerHTML = renderConflictDialogMarkup();
        const dialogRoot = dialogHost.firstElementChild;
        if (dialogRoot) document.body.appendChild(dialogRoot);
    }
    conflictDialogController = createConflictDialogController({ container: document });
}

export function renderApp(
    container: HTMLElement,
    payload?: RenderPayload,
    htmlMode: HtmlPreviewMode = 'rendered',
    expandedState = false
): void {
    clearPreviewWatchdog();
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
    if (payload.fileType === 'markdown') ensureConflictDialogController();
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

    if (payload.fileType === 'markdown' && payload.defaultEditorName) {
        markdownEditorAppCache.set(payload.filePath, {
            appName: payload.defaultEditorName,
            appPath: payload.defaultEditorPath,
        });
    }

    const defaultMarkdownEditor = payload.fileType === 'markdown'
        ? markdownEditorAppCache.get(payload.filePath)
        : undefined;

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

    const closePreview = (): void => {
        const workspace = payload.fileType === 'markdown' ? markdownController.getState(payload) : undefined;
        if (workspace?.dirty || workspace?.saving) return;
        unloadPreview?.();
    };
    document.getElementById('close-preview')?.addEventListener('click', closePreview);
    document.getElementById('close-preview-outer')?.addEventListener('click', closePreview);

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
                syncPayload?.(nextPayload);
            },
        });
    }

    const backBtn = document.getElementById('dir-back');
    if (backBtn && directoryBackPayload) {
        const savedPayload = directoryBackPayload;
        backBtn.addEventListener('click', () => {
            directoryBackPayload = undefined;
            syncPayload?.(savedPayload);
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
            if (!expanded) {
                const workspace = payload.fileType === 'markdown' ? markdownController.getState(payload) : undefined;
                if (workspace?.dirty || workspace?.saving) {
                    isExpanded = true;
                    shellController?.setExpanded(true);
                    return;
                }
                unloadPreview?.();
            }
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
}

export function bootstrapApp(hostApp?: App, alreadyConnected = false, openOnStart = false): void {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    renderLoadingState(container);

    // Markdown conflict dialogs mount on first user expansion, not on every idle card.

    const app = hostApp ?? new App(
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

    const widgetState = createWidgetStateStorage<LazyPreviewState | RenderPayload>(
        (value) => isLazyPreviewState(value)
            || (isPreviewStructuredContent(value) && typeof (value as RenderPayload).content === 'string'),
    );
    let lazyState: LazyPreviewState | undefined;
    let loadEpoch = 0;
    let awaitingMutation = false;
    let mutationWatchdogId: ReturnType<typeof setTimeout> | undefined;
    const clearMutationWatchdog = (): void => {
        if (mutationWatchdogId !== undefined) clearTimeout(mutationWatchdogId);
        mutationWatchdogId = undefined;
    };

    const renderAndSync = (payload?: RenderPayload): void => {
        if (!payload) {
            renderStatusState(container, 'No preview available for this response.');
            return;
        }
        const readArgs = lazyState?.readArgs.path === payload.filePath
            ? lazyState.readArgs : { path: payload.filePath };
        lazyState = createLazyPreviewState(readArgs, lazyState?.sourceTool);
        // Only small metadata is stored in host widget state, never file contents.
        widgetState.write(lazyState);
        currentPayload = payload;
        isExpanded = true;
        renderApp(container, payload, 'rendered', true);
    };

    const showLazyPreview = (state: LazyPreviewState, retry = false, pending = false): void => {
        ++loadEpoch;
        clearPreviewWatchdog();
        shellController?.dispose();
        shellController = undefined;
        markdownController.clear();
        selectionAbortController?.abort();
        selectionAbortController = null;
        currentPayload = undefined;
        hostPayload = undefined;
        localPayloadOverride = undefined;
        inlinePayloadBeforeFullscreen = undefined;
        directoryBackPayload = undefined;
        isExpanded = false;
        lazyState = state;

        const filePath = state.readArgs.path as string;
        const filename = filePath.split(/[\\/]/).pop() || filePath;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'compact-row compact-row--ready lazy-preview-open';
        button.title = filePath;
        button.setAttribute('aria-expanded', 'false');
        button.textContent = (retry ? 'Retry preview: ' : 'View preview: ') + filename;
        if (pending) {
            button.disabled = true;
            button.textContent = 'Waiting for file update: ' + filename;
        }
        const shell = document.createElement('main');
        shell.className = 'shell lazy-preview-shell';
        shell.append(button);
        container.replaceChildren(shell);
        document.body.classList.add('dc-ready');
        onRender?.();

        button.addEventListener('click', () => {
            if (button.disabled) return;
            button.disabled = true;
            button.textContent = 'Loading preview: ' + filename;
            const token = ++loadEpoch;
            // Only a user click may issue the UI-origin read.
            void pullPayloadByArgs(
                { ...state.readArgs, origin: 'ui' },
                (pulled) => {
                    if (token !== loadEpoch) return;
                    const stamped = state.sourceTool === 'edit_block' || state.sourceTool === 'write_file'
                        ? { ...pulled, sourceTool: state.sourceTool }
                        : pulled;
                    const payload = stamped;
                    hostPayload = payload;
                    renderAndSync(payload);
                    if (payload.fileType === 'markdown' && getCurrentDisplayMode() === 'fullscreen') {
                        void markdownController.requestEditMode(payload);
                    }
                },
                () => {
                    if (token === loadEpoch) showLazyPreview(state, true);
                },
            );
        });
    };

    const syncFromPersistedWidgetState = (): void => {
        const saved = widgetState.read();
        if (!saved) return;
        const state = isLazyPreviewState(saved) ? saved : createLazyStateFromLegacy(saved);
        // Replace old persisted full-payload widgets with metadata-only state.
        if (!isLazyPreviewState(saved)) widgetState.write(state);
        if (!lazyState || JSON.stringify(lazyState) !== JSON.stringify(state)) {
            showLazyPreview(state);
        }
    };

    syncPayload = renderAndSync;
    persistPayload = (payload: RenderPayload) => {
        const args = lazyState?.readArgs.path === payload.filePath
            ? lazyState.readArgs : { path: payload.filePath };
        lazyState = createLazyPreviewState(args, lazyState?.sourceTool);
        widgetState.write(lazyState);
    };
    rerenderCurrent = () => {
        if (currentPayload) renderApp(container, currentPayload, currentHtmlMode, isExpanded);
        else if (lazyState) showLazyPreview(lazyState);
    };
    unloadPreview = () => {
        if (lazyState) {
            widgetState.write(lazyState);
            showLazyPreview(lazyState);
        }
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
    const filePreviewUiEvent = createUiEventTracker(
        (name, args) => app.callServerTool({ name, arguments: args }),
        {
            component: 'file_preview',
        }
    );
    trackUiEvent = (event, params = {}) => filePreviewUiEvent(event, {
        tool_name: getTelemetryToolName(currentPayload ?? hostPayload),
        ...params,
    });

    app.ontoolinput = (params) => {
        clearMutationWatchdog();
        awaitingMutation = false;
        const readArgs = pickReadArgs(params.arguments);
        if (!readArgs) {
            renderStatusState(container, 'No file preview for this tool.');
            return;
        }
        const mutationTool = inferMutationTool(params.arguments);
        const state = createLazyPreviewState(readArgs, mutationTool ?? 'read_file');
        // Wait for write_file/edit_block completion before exposing the on-demand read.
        clearMutationWatchdog();
        awaitingMutation = !!mutationTool;
        lazyState = state;
        widgetState.write(state);
        showLazyPreview(state, false, awaitingMutation);
        if (awaitingMutation) {
            // Some hosts omit tool-result notifications. Offer manual retry after
            // the watchdog rather than leaving the preview disabled indefinitely.
            mutationWatchdogId = setTimeout(() => {
                mutationWatchdogId = undefined;
                if (awaitingMutation && lazyState === state) {
                    awaitingMutation = false;
                    showLazyPreview(state, true);
                }
            }, PREVIEW_WATCHDOG_MS);
        }
    };

    app.ontoolresult = (result) => {
        clearMutationWatchdog();
        // The model-facing tool result remains unchanged. A result notification
        // must never trigger a UI-origin file read or rebuild a large DOM.
        if ((result as { isError?: boolean })?.isError !== true) {
            if (awaitingMutation && lazyState) {
                awaitingMutation = false;
                showLazyPreview(lazyState);
            }
            return;
        }
        awaitingMutation = false;
        const message = extractToolText(result as unknown as Record<string, unknown>);
        ++loadEpoch;
        renderStatusState(container, message || 'Tool failed; no preview available.');
        onRender?.();
    };

    app.ontoolcancelled = (params) => {
        clearMutationWatchdog();
        awaitingMutation = false;
        ++loadEpoch;
        renderStatusState(container, params.reason ?? 'Tool was cancelled.');
        onRender?.();
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
        clearMutationWatchdog();
        clearPreviewWatchdog();
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
        alreadyConnected,
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
            if (currentPayload && displayModeChanged) {
                rerenderCurrent?.();
            }
        },
        onConnected: () => {
            currentHostContext = app.getHostContext() as Record<string, unknown> | undefined;
            syncFromPersistedWidgetState();
            if (openOnStart) {
                container.querySelector<HTMLButtonElement>('.lazy-preview-open')?.click();
            }
        },
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });

    window.addEventListener('beforeunload', () => {
        teardown();
    }, { once: true });
}
