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
    let lastToolInputArgs: Record<string, unknown> | undefined;
    // The mutation tool that produced the current tool call, if any — stamped
    // onto the pulled payload so telemetry attributes to write_file/edit_block
    // rather than the read_file pull that rendered it.
    let lastMutationTool: 'write_file' | 'edit_block' | undefined;
    // True once the current tool call has been rendered (via the input-time pull),
    // so a late tool-result notification doesn't trigger a redundant second pull.
    let renderedForCurrentInput = false;
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
        const requestedPath = typeof params.arguments?.path === 'string' ? params.arguments.path : undefined;
        const readArgs = pickReadArgs(params.arguments);
        lastMutationTool = inferMutationTool(params.arguments);
        if (readArgs) {
            // Retained so mutations (which pull at tool-result time) know what
            // to re-read — faithfully reproducing offset/length/sheet/range.
            lastToolInputArgs = readArgs;
        }
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
        renderedForCurrentInput = false;

        // All previews render from the widget's own origin:'ui' RPC read — the
        // notification channel is unreliable (the host strips structuredContent,
        // and for images swallows the tool-result entirely to inline-render).
        // tool-input always fires and carries the path + read args, so pull here.
        // Exception: mutations (write_file/edit_block) — their tool-input arrives
        // before the file changes, so they pull at tool-result time instead.
        if (readArgs && !lastMutationTool) {
            void pullPayloadByArgs(
                readArgs,
                (p) => {
                    renderedForCurrentInput = true;
                    if (initialStateResolved) {
                        renderAndSync(getEffectiveIncomingPayload(p));
                    } else {
                        resolveInitialState(getEffectiveIncomingPayload(p));
                    }
                },
                // Pull failed/timed out — the loading watchdog shows the failure row.
                () => {},
            );
        }
    };

    app.ontoolresult = (result) => {
        pendingCachedPayload = undefined;

        // Host-facing responses carry no structuredContent, so this notification
        // only signals completion. Reads already rendered from their input-time
        // pull; mutations (write_file/edit_block) pull now that the file changed.
        if (renderedForCurrentInput) {
            return;
        }

        const message = extractToolText(result as unknown as Record<string, unknown>);
        const isError = (result as { isError?: boolean })?.isError === true;
        const pullArgs = lastToolInputArgs
            ?? (currentPayload?.filePath ? { path: currentPayload.filePath } : undefined);

        const deliver = (pulled: RenderPayload): void => {
            renderedForCurrentInput = true;
            // The pull is always a read_file; re-stamp the originating mutation
            // tool so telemetry attributes to write_file/edit_block.
            const p = lastMutationTool ? { ...pulled, sourceTool: lastMutationTool } : pulled;
            if (initialStateResolved) {
                renderAndSync(getEffectiveIncomingPayload(p));
            } else {
                resolveInitialState(getEffectiveIncomingPayload(p));
            }
        };
        const renderMessageFallback = (): void => {
            if (!message) {
                return;
            }
            if (!initialStateResolved) {
                resolveInitialState(undefined, message);
            } else {
                renderStatusState(container, message);
                onRender?.();
            }
        };

        // A failed tool call has nothing worth re-reading — show its message.
        if (!isError && pullArgs) {
            renderLoadingState(container);
            onRender?.();
            void pullPayloadByArgs(pullArgs, deliver, renderMessageFallback);
            return;
        }
        renderMessageFallback();
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
        },
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });

    window.addEventListener('beforeunload', () => {
        teardown();
    }, { once: true });
}
