import { renderMarkdown } from '../components/markdown-renderer.js';
import { createSlugTracker } from './slugify.js';

export type MarkdownEditorView = 'raw' | 'markdown';

export interface MarkdownLinkSearchItem {
    path: string;
    title: string;
    wikiPath: string;
    relativePath: string;
}

export interface MarkdownLinkHeading {
    id: string;
    text: string;
}

export interface MarkdownEditorHandle {
    destroy: () => void;
    focus: () => void;
    getValue: () => string;
    setValue: (value: string) => void;
    revealLine: (lineNumber: number, headingId?: string) => void;
    setScrollTop: (scrollTop: number) => void;
}

function shouldIgnoreBlur(shell: Element | null | undefined, event: FocusEvent): boolean {
    const nextTarget = event.relatedTarget as Node | null;
    const widgetShell = shell?.closest('.tool-shell');
    return Boolean(nextTarget && (shell?.contains(nextTarget) || widgetShell?.contains(nextTarget)));
}

function renderFormattingButtons(): string {
    return `
      <button class="markdown-format-button" type="button" data-format="bold"><strong>B</strong></button>
      <button class="markdown-format-button" type="button" data-format="italic"><em>I</em></button>
      <button class="markdown-format-button" type="button" data-format="strike"><span style="text-decoration:line-through">S</span></button>
      <span class="markdown-format-sep" aria-hidden="true"></span>
      <label class="markdown-format-size" title="Block style" aria-label="Block style">
        <select id="markdown-block-style">
          <option value="p" selected>Normal</option>
          <option value="h1">H1</option>
          <option value="h2">H2</option>
          <option value="h3">H3</option>
        </select>
      </label>
      <span class="markdown-format-sep" aria-hidden="true"></span>
      <button class="markdown-format-button" type="button" data-format="quote" title="Quote" aria-label="Quote">&#10077;</button>
      <button class="markdown-format-button" type="button" data-format="list" title="List" aria-label="List">&#8226;</button>
      <button class="markdown-format-button" type="button" data-format="link" title="Link" aria-label="Link">&#128279;</button>
      <button class="markdown-format-button" type="button" data-format="code" title="Code" aria-label="Code">&lsaquo;&rsaquo;</button>
    `;
}

function renderModeToggleIcon(view: MarkdownEditorView): string {
    if (view === 'raw') {
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
    }

    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M4 12h10"></path><path d="M4 17h7"></path></svg>';
}

function renderHeadingOptionLabel(headings: MarkdownLinkHeading[], heading: MarkdownLinkHeading): string {
    const duplicateCount = headings.filter((candidate) => candidate.text === heading.text).length;
    if (duplicateCount <= 1) {
        return heading.text;
    }

    return `${heading.text} (#${heading.id})`;
}

export function renderMarkdownCopyButton(): string {
    return `<button class="markdown-editor-copy-button" type="button" id="copy-active-markdown" title="Copy" aria-label="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button>`;
}

export function renderMarkdownModeToggle(view: MarkdownEditorView): string {
    return `
      <div class="markdown-editor-mode-toggle" role="tablist" aria-label="Editor mode">
        <div class="markdown-editor-mode-toggle-indicator markdown-editor-mode-toggle-indicator--${view}" aria-hidden="true"></div>
        <button class="markdown-editor-mode-option${view === 'raw' ? ' is-active' : ''}" type="button" id="markdown-mode-raw" role="tab" aria-selected="${view === 'raw' ? 'true' : 'false'}" title="Raw" aria-label="Raw">${renderModeToggleIcon('raw')}<span>Raw</span></button>
        <button class="markdown-editor-mode-option${view === 'markdown' ? ' is-active' : ''}" type="button" id="markdown-mode-markdown" role="tab" aria-selected="${view === 'markdown' ? 'true' : 'false'}" title="Preview" aria-label="Preview">${renderModeToggleIcon('markdown')}<span>Preview</span></button>
      </div>
    `;
}

export function renderMarkdownEditorShell(options: {
    view: MarkdownEditorView;
}): string {
    const isMarkdownView = options.view === 'markdown';

    return `
      <div class="markdown-editor-shell markdown-editor-shell--${options.view}">
        <section class="markdown-editor-pane markdown-editor-pane--${options.view}" aria-label="Markdown editor">
          ${isMarkdownView ? `<div id="markdown-editor-context-menu" class="markdown-editor-context-menu" hidden>${renderFormattingButtons()}</div><div id="markdown-link-modal" class="markdown-link-modal" hidden><div class="markdown-link-modal-card"><div class="markdown-link-mode-tabs"><button type="button" id="markdown-link-mode-file" class="markdown-link-mode-tab is-active">File</button><button type="button" id="markdown-link-mode-url" class="markdown-link-mode-tab">URL</button></div><div id="markdown-link-file-fields"><label class="markdown-link-modal-label" for="markdown-link-search">Find note</label><input id="markdown-link-search" class="markdown-link-modal-input" type="text" placeholder="Search files..." /><div id="markdown-link-results" class="markdown-link-results"></div><label class="markdown-link-modal-label" for="markdown-link-heading">Heading</label><select id="markdown-link-heading" class="markdown-link-modal-input markdown-link-modal-select"><option value="">None</option></select><label class="markdown-link-modal-label" for="markdown-link-alias">Alias</label><input id="markdown-link-alias" class="markdown-link-modal-input" type="text" placeholder="Optional label" /></div><div id="markdown-link-url-fields" hidden><label class="markdown-link-modal-label" for="markdown-link-input">URL</label><input id="markdown-link-input" class="markdown-link-modal-input" type="url" placeholder="https://example.com" /><label class="markdown-link-modal-label" for="markdown-link-label">Label</label><input id="markdown-link-label" class="markdown-link-modal-input" type="text" placeholder="Optional label" /></div><div class="markdown-link-modal-actions"><button type="button" id="markdown-link-cancel" class="markdown-link-modal-button">Cancel</button><button type="button" id="markdown-link-apply" class="markdown-link-modal-button markdown-link-modal-button--primary">Insert</button></div></div></div>` : ''}
          <div id="markdown-editor-root" class="markdown-editor-root"></div>
        </section>
      </div>
    `;
}

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const children = Array.from(element.childNodes).map(serializeNode).join('');

    switch (tag) {
        case 'strong':
        case 'b':
            return `**${children}**`;
        case 'em':
        case 'i':
            return `*${children}*`;
        case 'u':
            return `<u>${children}</u>`;
        case 's':
        case 'strike':
            return `~~${children}~~`;
        case 'code':
            return `\`${children}\``;
        case 'a': {
            const wikiLink = element.getAttribute('data-wiki-link');
            if (wikiLink) {
                return wikiLink;
            }
            const href = element.getAttribute('href') ?? 'https://example.com';
            return `[${children || href}](${href})`;
        }
        case 'span': {
            const color = element.style.color;
            const fontSize = element.style.fontSize;
            if (color || fontSize) {
                const styleParts = [color ? `color:${color}` : '', fontSize ? `font-size:${fontSize}` : ''].filter(Boolean).join(';');
                return `<span style="${styleParts}">${children}</span>`;
            }
            return children;
        }
        case 'font': {
            const color = element.getAttribute('color');
            const size = element.getAttribute('size');
            const styleParts = [color ? `color:${color}` : '', size ? `font-size:${size}` : ''].filter(Boolean).join(';');
            return styleParts ? `<span style="${styleParts}">${children}</span>` : children;
        }
        case 'br':
            return '\n';
        case 'p':
            return `${children.trim()}\n\n`;
        case 'h1':
            return `# ${collapseWhitespace(children)}\n\n`;
        case 'h2':
            return `## ${collapseWhitespace(children)}\n\n`;
        case 'h3':
            return `### ${collapseWhitespace(children)}\n\n`;
        case 'h4':
            return `#### ${collapseWhitespace(children)}\n\n`;
        case 'h5':
            return `##### ${collapseWhitespace(children)}\n\n`;
        case 'h6':
            return `###### ${collapseWhitespace(children)}\n\n`;
        case 'blockquote':
            return `${children.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
        case 'ul':
            return `${Array.from(element.children).map((child) => `- ${collapseWhitespace(serializeNode(child))}`).join('\n')}\n\n`;
        case 'ol':
            return `${Array.from(element.children).map((child, index) => `${index + 1}. ${collapseWhitespace(serializeNode(child))}`).join('\n')}\n\n`;
        case 'li':
            return collapseWhitespace(children);
        case 'div':
            return `${children}${children.endsWith('\n') ? '' : '\n'}`;
        default:
            return children;
    }
}

function htmlToMarkdown(html: string): string {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = documentNode.body.firstElementChild;
    if (!root) {
        return '';
    }

    return Array.from(root.childNodes)
        .map(serializeNode)
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function applyRawTab(textarea: HTMLTextAreaElement): void {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextValue = `${textarea.value.slice(0, start)}\t${textarea.value.slice(end)}`;
    textarea.value = nextValue;
    textarea.selectionStart = start + 1;
    textarea.selectionEnd = start + 1;
}

function replaceSelectionWithNode(node: Node): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function applyMarkdownFormat(format: string, value?: string): void {
    switch (format) {
        case 'bold':
            document.execCommand('bold');
            break;
        case 'italic':
            document.execCommand('italic');
            break;
        case 'strike':
            document.execCommand('strikeThrough');
            break;
        case 'quote':
            document.execCommand('formatBlock', false, 'blockquote');
            break;
        case 'list':
            document.execCommand('insertUnorderedList');
            break;
        case 'block-style':
            if (value) {
                document.execCommand('formatBlock', false, value);
            }
            break;
        case 'code':
        {
            const code = document.createElement('code');
            code.textContent = window.getSelection()?.toString() || 'code';
            replaceSelectionWithNode(code);
            break;
        }
        default:
            break;
    }
}

export function mountMarkdownEditor(options: {
    target: HTMLElement;
    value: string;
    view: MarkdownEditorView;
    initialScrollTop?: number;
    currentFilePath: string;
    searchLinks?: (query: string) => Promise<MarkdownLinkSearchItem[]>;
    loadHeadings?: (filePath: string) => Promise<MarkdownLinkHeading[]>;
    onChange: (value: string) => void;
    onBlur?: () => void;
}): MarkdownEditorHandle {
    const shell = options.target.closest('.markdown-editor-shell');
    const contextMenu = shell?.querySelector('#markdown-editor-context-menu') as HTMLElement | null;
    const formatButtons = shell ? Array.from(shell.querySelectorAll<HTMLButtonElement>('[data-format]')) : [];
    const blockStyleSelect = shell?.querySelector('#markdown-block-style') as HTMLSelectElement | null;
    const linkModal = shell?.querySelector('#markdown-link-modal') as HTMLElement | null;
    const linkModeFile = shell?.querySelector('#markdown-link-mode-file') as HTMLButtonElement | null;
    const linkModeUrl = shell?.querySelector('#markdown-link-mode-url') as HTMLButtonElement | null;
    const linkFileFields = shell?.querySelector('#markdown-link-file-fields') as HTMLElement | null;
    const linkUrlFields = shell?.querySelector('#markdown-link-url-fields') as HTMLElement | null;
    const linkSearchInput = shell?.querySelector('#markdown-link-search') as HTMLInputElement | null;
    const linkResults = shell?.querySelector('#markdown-link-results') as HTMLElement | null;
    const linkHeadingSelect = shell?.querySelector('#markdown-link-heading') as HTMLSelectElement | null;
    const linkAliasInput = shell?.querySelector('#markdown-link-alias') as HTMLInputElement | null;
    const linkInput = shell?.querySelector('#markdown-link-input') as HTMLInputElement | null;
    const linkLabelInput = shell?.querySelector('#markdown-link-label') as HTMLInputElement | null;
    const linkApply = shell?.querySelector('#markdown-link-apply') as HTMLButtonElement | null;
    const linkCancel = shell?.querySelector('#markdown-link-cancel') as HTMLButtonElement | null;
    let savedRange: Range | null = null;
    let linkMode: 'file' | 'url' = 'file';
    let linkSearchResults: MarkdownLinkSearchItem[] = [];
    let selectedLinkItem: MarkdownLinkSearchItem | null = null;
    let linkResultsMessage = 'Search for a file to link';
    let linkSearchRequestId = 0;
    let linkHeadingRequestId = 0;
    let lastMarkdownValue = options.value;

    if (options.view === 'markdown') {
        const editor = document.createElement('div');
        editor.className = 'markdown-editor-surface markdown-editor-surface--markdown markdown markdown-doc';
        editor.contentEditable = 'true';
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-multiline', 'true');
        editor.innerHTML = renderMarkdown(options.value);
        options.target.replaceChildren(editor);

        const syncHeadingAttributes = (): void => {
            const nextSlug = createSlugTracker();
            const headings = Array.from(editor.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));

            for (const heading of headings) {
                const text = heading.textContent?.trim() ?? '';
                if (!text) {
                    heading.removeAttribute('id');
                    heading.removeAttribute('data-heading-id');
                    continue;
                }

                const headingId = nextSlug(text);
                heading.id = headingId;
                heading.setAttribute('data-heading-id', headingId);
            }
        };

        const setLinkHeadingOptions = (headings: MarkdownLinkHeading[] = [], placeholder: string = 'None'): void => {
            if (!linkHeadingSelect) {
                return;
            }

            linkHeadingSelect.replaceChildren();
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = placeholder;
            linkHeadingSelect.appendChild(noneOption);

            for (const heading of headings) {
                const option = document.createElement('option');
                option.value = heading.id;
                option.textContent = renderHeadingOptionLabel(headings, heading);
                option.dataset.headingText = heading.text;
                linkHeadingSelect.appendChild(option);
            }
        };

        const loadHeadingsForItem = async (item: MarkdownLinkSearchItem): Promise<void> => {
            if (!linkHeadingSelect) {
                return;
            }

            const requestId = ++linkHeadingRequestId;
            setLinkHeadingOptions([], 'Loading…');
            try {
                const headings = await options.loadHeadings?.(item.path) ?? [];
                if (requestId !== linkHeadingRequestId || selectedLinkItem?.path !== item.path) {
                    return;
                }
                setLinkHeadingOptions(headings);
            } catch {
                if (requestId !== linkHeadingRequestId || selectedLinkItem?.path !== item.path) {
                    return;
                }
                setLinkHeadingOptions([], 'Failed to load headings');
            }
        };

        const syncFromEditor = (syncContent: boolean): void => {
            if (syncContent) {
                syncHeadingAttributes();
                const nextMarkdownValue = htmlToMarkdown(editor.innerHTML);
                if (nextMarkdownValue !== lastMarkdownValue) {
                    lastMarkdownValue = nextMarkdownValue;
                    options.onChange(nextMarkdownValue);
                }
            }
            if (contextMenu) {
                const selection = window.getSelection();
                const hasSelection = !!selection && !selection.isCollapsed && editor.contains(selection.anchorNode);
                contextMenu.hidden = !hasSelection;
                if (hasSelection && selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    savedRange = range.cloneRange();
                    const rect = range.getBoundingClientRect();
                    const shellRect = (shell as HTMLElement).getBoundingClientRect();
                    const left = Math.max(12, rect.left - shellRect.left + rect.width / 2 - contextMenu.offsetWidth / 2);
                    const top = Math.max(12, rect.top - shellRect.top - contextMenu.offsetHeight - 10);
                    contextMenu.style.left = `${left}px`;
                    contextMenu.style.top = `${top}px`;
                }
            }
        };

        const restoreSelection = (): void => {
            if (!savedRange) {
                return;
            }
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(savedRange);
        };

        const renderLinkResults = (): void => {
            if (!linkResults) {
                return;
            }

            if (linkSearchResults.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'markdown-link-results-empty';
                empty.textContent = linkResultsMessage;
                linkResults.replaceChildren(empty);
                return;
            }

            const fragment = document.createDocumentFragment();
            for (const item of linkSearchResults) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `markdown-link-result${selectedLinkItem?.path === item.path ? ' is-active' : ''}`;
                button.dataset.linkPath = item.path;

                const title = document.createElement('span');
                title.className = 'markdown-link-result-title';
                title.textContent = item.title;

                const path = document.createElement('span');
                path.className = 'markdown-link-result-path';
                path.textContent = item.relativePath;

                button.append(title, path);
                button.addEventListener('click', () => {
                    selectedLinkItem = item;
                    renderLinkResults();
                    void loadHeadingsForItem(item);
                });
                fragment.appendChild(button);
            }
            linkResults.replaceChildren(fragment);
        };

        const updateLinkMode = (mode: 'file' | 'url'): void => {
            linkMode = mode;
            linkModeFile?.classList.toggle('is-active', mode === 'file');
            linkModeUrl?.classList.toggle('is-active', mode === 'url');
            if (linkFileFields) {
                linkFileFields.hidden = mode !== 'file';
            }
            if (linkUrlFields) {
                linkUrlFields.hidden = mode !== 'url';
            }
        };

        const runLinkSearch = async (): Promise<void> => {
            if (!linkSearchInput || !options.searchLinks) {
                return;
            }

            const query = linkSearchInput.value.trim();
            if (query.length === 0) {
                linkSearchRequestId += 1;
                linkSearchResults = [];
                selectedLinkItem = null;
                linkResultsMessage = 'Search for a file to link';
                setLinkHeadingOptions();
                renderLinkResults();
                return;
            }

            const requestId = ++linkSearchRequestId;
            try {
                const results = await options.searchLinks(query);
                if (requestId !== linkSearchRequestId || query !== linkSearchInput.value.trim()) {
                    return;
                }

                linkSearchResults = results;
                selectedLinkItem = results[0] ?? null;
                linkResultsMessage = results.length === 0 ? 'No matching files found' : 'Search for a file to link';
                renderLinkResults();
                if (selectedLinkItem) {
                    void loadHeadingsForItem(selectedLinkItem);
                } else {
                    setLinkHeadingOptions();
                }
            } catch {
                if (requestId !== linkSearchRequestId) {
                    return;
                }
                linkSearchResults = [];
                selectedLinkItem = null;
                linkResultsMessage = 'Search failed. Try again.';
                setLinkHeadingOptions();
                renderLinkResults();
            }
        };

        const handleInput = (): void => {
            syncFromEditor(true);
        };

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Tab') {
                event.preventDefault();
                document.execCommand('insertText', false, '    ');
                syncFromEditor(true);
            }
        };

        const handleSelectionChange = (): void => {
            syncFromEditor(false);
        };

        const handleFocusOut = (event: FocusEvent): void => {
            if (shouldIgnoreBlur(shell, event)) {
                return;
            }
            if (contextMenu) {
                contextMenu.hidden = true;
            }
            options.onBlur?.();
        };

        const handleFormatClick = (event: Event): void => {
            const target = event.currentTarget as HTMLButtonElement;
            const format = target.dataset.format;
            if (!format) {
                return;
            }

            editor.focus();
            restoreSelection();
            if (format === 'link') {
                const selectedText = window.getSelection()?.toString().trim() ?? '';
                linkModal?.removeAttribute('hidden');
                updateLinkMode('file');
                if (linkAliasInput) {
                    linkAliasInput.value = selectedText;
                }
                if (linkLabelInput) {
                    linkLabelInput.value = selectedText;
                }
                if (linkSearchInput) {
                    linkSearchInput.value = '';
                    linkSearchInput.focus();
                }
                linkSearchResults = [];
                selectedLinkItem = null;
                linkResultsMessage = 'Search for a file to link';
                setLinkHeadingOptions();
                renderLinkResults();
                return;
            }
            applyMarkdownFormat(format);
            syncFromEditor(true);
        };

        const handleBlockStyleChange = (): void => {
            if (!blockStyleSelect?.value) {
                return;
            }
            editor.focus();
            restoreSelection();
            applyMarkdownFormat('block-style', blockStyleSelect.value);
            syncFromEditor(true);
        };

        const closeLinkModal = (): void => {
            linkModal?.setAttribute('hidden', '');
            if (linkInput) {
                linkInput.value = '';
            }
            if (linkLabelInput) {
                linkLabelInput.value = '';
            }
            if (linkAliasInput) {
                linkAliasInput.value = '';
            }
            if (linkSearchInput) {
                linkSearchInput.value = '';
            }
            setLinkHeadingOptions();
            linkSearchResults = [];
            selectedLinkItem = null;
            linkResultsMessage = 'Search for a file to link';
            renderLinkResults();
        };

        const handleLinkApply = (): void => {
            editor.focus();
            restoreSelection();
            if (linkMode === 'url') {
                const href = linkInput?.value?.trim();
                const label = linkLabelInput?.value?.trim() || window.getSelection()?.toString().trim() || href || 'link';
                if (href) {
                    const anchor = document.createElement('a');
                    anchor.setAttribute('href', href);
                    anchor.textContent = label;
                    if (replaceSelectionWithNode(anchor)) {
                        syncFromEditor(true);
                    }
                }
            } else if (selectedLinkItem) {
                const selectedHeadingId = linkHeadingSelect?.value?.trim();
                const selectedHeadingText = linkHeadingSelect?.selectedOptions[0]?.dataset.headingText?.trim();
                const alias = linkAliasInput?.value?.trim();
                const pathPart = selectedLinkItem.path === options.currentFilePath ? '' : selectedLinkItem.wikiPath;
                const wikiLink = `[[${pathPart}${selectedHeadingId ? `#${selectedHeadingId}` : ''}${alias ? `|${alias}` : ''}]]`;
                const href = `${selectedLinkItem.relativePath}${selectedHeadingId ? `#${selectedHeadingId}` : ''}`;
                const label = alias || selectedHeadingText || selectedLinkItem.title;
                const anchor = document.createElement('a');
                anchor.setAttribute('href', href);
                anchor.dataset.wikiLink = wikiLink;
                anchor.textContent = label;
                if (replaceSelectionWithNode(anchor)) {
                    syncFromEditor(true);
                }
            }
            closeLinkModal();
        };

        editor.addEventListener('input', handleInput);
        editor.addEventListener('keydown', handleKeyDown);
        editor.addEventListener('focusout', handleFocusOut);
        document.addEventListener('selectionchange', handleSelectionChange);
        formatButtons.forEach((button) => button.addEventListener('click', handleFormatClick));
        blockStyleSelect?.addEventListener('change', handleBlockStyleChange);
        linkModeFile?.addEventListener('click', () => updateLinkMode('file'));
        linkModeUrl?.addEventListener('click', () => {
            updateLinkMode('url');
            linkInput?.focus();
        });
        const handleSearchInput = (): void => { void runLinkSearch(); };
        linkSearchInput?.addEventListener('input', handleSearchInput);
        linkApply?.addEventListener('click', handleLinkApply);
        linkCancel?.addEventListener('click', closeLinkModal);
        syncHeadingAttributes();
        syncFromEditor(false);
        renderLinkResults();
        if (typeof options.initialScrollTop === 'number') {
            editor.scrollTop = options.initialScrollTop;
        }

        return {
            destroy: () => {
                editor.removeEventListener('input', handleInput);
                editor.removeEventListener('keydown', handleKeyDown);
                editor.removeEventListener('focusout', handleFocusOut);
                document.removeEventListener('selectionchange', handleSelectionChange);
                formatButtons.forEach((button) => button.removeEventListener('click', handleFormatClick));
                blockStyleSelect?.removeEventListener('change', handleBlockStyleChange);
                linkSearchInput?.removeEventListener('input', handleSearchInput);
                linkApply?.removeEventListener('click', handleLinkApply);
                linkCancel?.removeEventListener('click', closeLinkModal);
                options.target.replaceChildren();
            },
            focus: () => {
                editor.focus();
            },
            getValue: () => htmlToMarkdown(editor.innerHTML),
            setValue: (value: string) => {
                lastMarkdownValue = value;
                editor.innerHTML = renderMarkdown(value);
                syncHeadingAttributes();
                syncFromEditor(false);
            },
            revealLine: (_lineNumber: number, headingId?: string) => {
                if (headingId) {
                    const heading = editor.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`);
                    if (heading) {
                        heading.scrollIntoView({ block: 'start', inline: 'nearest' });
                        editor.scrollTop = Math.max(editor.scrollTop - 24, 0);
                        heading.setAttribute('tabindex', '-1');
                        heading.focus({ preventScroll: true });
                        return;
                    }
                }

                editor.focus();
            },
            setScrollTop: (scrollTop: number) => {
                editor.scrollTop = Math.max(0, scrollTop);
            },
        };
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'markdown-editor-textarea markdown-editor-textarea--raw';
    textarea.spellcheck = false;
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.placeholder = 'Edit raw markdown...';
    textarea.value = options.value;
    options.target.replaceChildren(textarea);

    const autosize = (): void => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(textarea.scrollHeight, 640)}px`;
    };

    const handleInput = (): void => {
        autosize();
        options.onChange(textarea.value);
    };

    const handleFocusOut = (event: FocusEvent): void => {
        if (shouldIgnoreBlur(shell, event)) {
            return;
        }
        options.onBlur?.();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Tab') {
            return;
        }

        event.preventDefault();
        applyRawTab(textarea);
        autosize();
        options.onChange(textarea.value);
    };

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('keydown', handleKeyDown);
    textarea.addEventListener('focusout', handleFocusOut);
    autosize();
    if (typeof options.initialScrollTop === 'number') {
        textarea.scrollTop = options.initialScrollTop;
    }

    return {
        destroy: () => {
            textarea.removeEventListener('input', handleInput);
            textarea.removeEventListener('keydown', handleKeyDown);
            textarea.removeEventListener('focusout', handleFocusOut);
            options.target.replaceChildren();
        },
        focus: () => {
            textarea.focus();
        },
        getValue: () => textarea.value,
        setValue: (value: string) => {
            textarea.value = value;
            autosize();
        },
        revealLine: (lineNumber: number) => {
            const targetLine = Math.max(1, Math.floor(lineNumber));
            const lines = textarea.value.split('\n');
            let index = 0;
            for (let currentLine = 1; currentLine < targetLine && currentLine <= lines.length; currentLine += 1) {
                index += lines[currentLine - 1].length + 1;
            }

            textarea.focus();
            textarea.setSelectionRange(index, index);

            const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || '20') || 20;
            textarea.scrollTop = Math.max(0, (targetLine - 1) * lineHeight - lineHeight * 2);
        },
        setScrollTop: (scrollTop: number) => {
            textarea.scrollTop = Math.max(0, scrollTop);
        },
    };
}
