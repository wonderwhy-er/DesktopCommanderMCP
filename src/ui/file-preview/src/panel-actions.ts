import { parseReadRange, stripReadStatusLine } from './document-workspace.js';
import type { RenderPayload } from './model.js';
import type { MarkdownController } from './markdown/controller.js';
import { extractToolText } from './payload-utils.js';
import type { HtmlPreviewMode } from './types.js';

export function attachPanelActions(options: {
    container: HTMLElement;
    payload: RenderPayload;
    htmlMode: HtmlPreviewMode;
    getIsExpanded: () => boolean;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    trackUiEvent?: (event: string, params?: Record<string, unknown>) => void;
    getFileExtensionForAnalytics: (filePath: string) => string;
    buildOpenInFolderCommand: (filePath: string) => string | undefined;
    buildOpenInEditorCommand: (filePath: string) => string | undefined;
    render: (payload?: RenderPayload, htmlMode?: HtmlPreviewMode, expandedState?: boolean) => void;
    updateSaveStatus: (label: string, statusClass: string) => void;
    markdownController: MarkdownController;
}): void {
    const queryById = <T extends HTMLElement>(id: string): T | null => (
        options.container.querySelector<T>(`#${id}`)
    );

    const fallbackCopy = (text: string): boolean => {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        return success;
    };

    const setButtonState = (button: HTMLElement, label: string, fallbackLabel: string, revertMs?: number): void => {
        button.setAttribute('title', label);
        button.setAttribute('aria-label', label);
        button.textContent = label;
        if (revertMs) {
            setTimeout(() => {
                button.textContent = fallbackLabel;
                button.setAttribute('title', fallbackLabel);
                button.setAttribute('aria-label', fallbackLabel);
            }, revertMs);
        }
    };

    const setIconButtonState = (button: HTMLElement, label: string, fallbackLabel: string, revertMs?: number): void => {
        button.setAttribute('title', label);
        button.setAttribute('aria-label', label);
        button.dataset.status = label;
        if (revertMs) {
            setTimeout(() => {
                button.setAttribute('title', fallbackLabel);
                button.setAttribute('aria-label', fallbackLabel);
                delete button.dataset.status;
            }, revertMs);
        }
    };

    const copyTextData = async (text: string): Promise<boolean> => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
            return fallbackCopy(text);
        } catch {
            return fallbackCopy(text);
        }
    };

    const fileExtension = options.getFileExtensionForAnalytics(options.payload.filePath);
    const copyButton = queryById<HTMLButtonElement>('copy-source');
    copyButton?.addEventListener('click', async () => {
        options.trackUiEvent?.('copy_clicked', {
            file_type: options.payload.fileType,
            file_extension: fileExtension,
        });

        const copied = await copyTextData(stripReadStatusLine(options.payload.content));
        setButtonState(copyButton, copied ? 'Copied!' : 'Copy failed', 'Copy', 1500);
    });

    const activeCopyButton = queryById<HTMLButtonElement>('copy-active-markdown');
    activeCopyButton?.addEventListener('click', async () => {
        const textToCopy = options.markdownController.getCopyText(options.payload);
        if (!textToCopy) {
            return;
        }
        const copied = await copyTextData(textToCopy);
        if (copied) {
            options.updateSaveStatus('Copied', 'saved');
            window.setTimeout(() => options.updateSaveStatus('', ''), 1500);
        }
        setIconButtonState(activeCopyButton, copied ? 'Copied!' : 'Copy failed', 'Copy', 1500);
    });

    const toggleButton = queryById<HTMLButtonElement>('toggle-html-mode');
    toggleButton?.addEventListener('click', () => {
        const nextMode: HtmlPreviewMode = options.htmlMode === 'rendered' ? 'source' : 'rendered';
        options.trackUiEvent?.('html_view_toggled', {
            file_type: options.payload.fileType,
            file_extension: fileExtension,
        });
        options.render(options.payload, nextMode, options.getIsExpanded());
    });

    const openFolderButton = queryById<HTMLButtonElement>('open-in-folder');
    if (openFolderButton) {
        const command = options.buildOpenInFolderCommand(options.payload.filePath);
        if (!command) {
            openFolderButton.disabled = true;
        } else {
            openFolderButton.addEventListener('click', async () => {
                options.trackUiEvent?.('open_in_folder', {
                    file_type: options.payload.fileType,
                    file_extension: fileExtension,
                });
                try {
                    await options.callTool?.('start_process', { command, timeout_ms: 12000 });
                } catch {
                    // Keep UI stable if opening folder fails.
                }
            });
        }
    }

    const openEditorButton = queryById<HTMLButtonElement>('open-in-editor');
    if (openEditorButton) {
        const command = options.buildOpenInEditorCommand(options.payload.filePath);
        if (!command) {
            openEditorButton.disabled = true;
        } else {
            openEditorButton.addEventListener('click', async () => {
                options.trackUiEvent?.('open_in_editor', {
                    file_type: options.payload.fileType,
                    file_extension: fileExtension,
                });
                try {
                    await options.callTool?.('start_process', { command, timeout_ms: 12000 });
                } catch {
                    // Keep UI stable if opening editor fails.
                }
            });
        }
    }

    const beforeBtn = queryById<HTMLButtonElement>('load-before');
    const afterBtn = queryById<HTMLButtonElement>('load-after');
    if (!beforeBtn && !afterBtn) {
        return;
    }

    const range = parseReadRange(options.payload.content);
    if (!range?.isPartial) {
        return;
    }

    const currentContent = stripReadStatusLine(options.payload.content);
    const loadLines = async (button: HTMLButtonElement, direction: 'before' | 'after'): Promise<void> => {
        const originalText = button.textContent;
        button.textContent = 'Loading…';
        button.disabled = true;

        options.trackUiEvent?.(direction === 'before' ? 'load_lines_before' : 'load_lines_after', {
            file_type: options.payload.fileType,
            file_extension: fileExtension,
        });

        try {
            const readArgs = direction === 'before'
                ? { path: options.payload.filePath, offset: 0, length: range.fromLine - 1 }
                : { path: options.payload.filePath, offset: range.toLine };

            const result = await options.callTool?.('read_file', readArgs);
            const newText = extractToolText(result);

            if (newText && typeof newText === 'string') {
                const cleanNew = stripReadStatusLine(newText);
                const merged = direction === 'before'
                    ? `${cleanNew}${cleanNew.endsWith('\n') ? '' : '\n'}${currentContent}`
                    : `${currentContent}${currentContent.endsWith('\n') ? '' : '\n'}${cleanNew}`;

                const newFrom = direction === 'before' ? 1 : range.fromLine;
                const newTo = direction === 'after' ? range.totalLines : range.toLine;
                const lineCount = newTo - newFrom + 1;
                const remaining = range.totalLines - newTo;
                const isStillPartial = newFrom > 1 || newTo < range.totalLines;
                const statusLine = isStillPartial
                    ? `[Reading ${lineCount} lines from ${newFrom === 1 ? 'start' : `line ${newFrom}`} (total: ${range.totalLines} lines, ${remaining} remaining)]\n`
                    : '';

                options.render({
                    ...options.payload,
                    content: statusLine + merged,
                }, options.htmlMode, options.getIsExpanded());
                return;
            }
        } catch {
            // Fall through to button reset.
        }

        button.textContent = 'Failed to load';
        setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
        }, 2000);
    };

    beforeBtn?.addEventListener('click', () => void loadLines(beforeBtn, 'before'));
    afterBtn?.addEventListener('click', () => void loadLines(afterBtn, 'after'));
}
