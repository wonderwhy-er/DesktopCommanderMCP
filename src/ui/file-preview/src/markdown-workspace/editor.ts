import { renderMarkdown } from '../components/markdown-renderer.js';

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

export function renderMarkdownCopyButton(): string {
    return `<button class="markdown-editor-copy-button" type="button" id="copy-active-markdown" title="Copy" aria-label="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
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
    content: string;
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

function wrapSelectionWithInlineStyle(style: { color?: string; fontSize?: string }): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return;
    }

    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    if (style.color) span.style.color = style.color;
    if (style.fontSize) span.style.fontSize = style.fontSize;
    span.appendChild(range.extractContents());
    range.insertNode(span);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(span);
    selection.addRange(nextRange);
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
        case 'link': {
            if (value?.trim()) {
                document.execCommand('createLink', false, value.trim());
            }
            break;
        }
        case 'block-style':
            if (value) {
                document.execCommand('formatBlock', false, value);
            }
            break;
        case 'code':
            document.execCommand('insertHTML', false, `<code>${window.getSelection()?.toString() || 'code'}</code>`);
            break;
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

    if (options.view === 'markdown') {
        const editor = document.createElement('div');
        editor.className = 'markdown-editor-surface markdown-editor-surface--markdown markdown markdown-doc';
        editor.contentEditable = 'true';
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-multiline', 'true');
        editor.innerHTML = renderMarkdown(options.value);
        options.target.replaceChildren(editor);

        const syncFromEditor = (): void => {
            options.onChange(htmlToMarkdown(editor.innerHTML));
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
                linkResults.innerHTML = '<div class="markdown-link-results-empty">Search for a file to link</div>';
                return;
            }

            linkResults.innerHTML = linkSearchResults.map((item) => `
              <button type="button" class="markdown-link-result${selectedLinkItem?.path === item.path ? ' is-active' : ''}" data-link-path="${item.path}">
                <span class="markdown-link-result-title">${item.title}</span>
                <span class="markdown-link-result-path">${item.relativePath}</span>
              </button>
            `).join('');

            const buttons = Array.from(linkResults.querySelectorAll<HTMLButtonElement>('[data-link-path]'));
            for (const button of buttons) {
                button.addEventListener('click', async () => {
                    const nextItem = linkSearchResults.find((item) => item.path === button.dataset.linkPath);
                    if (!nextItem) {
                        return;
                    }

                    selectedLinkItem = nextItem;
                    renderLinkResults();
                    if (!linkHeadingSelect) {
                        return;
                    }

                    linkHeadingSelect.innerHTML = '<option value="">Loading…</option>';
                    const headings = await options.loadHeadings?.(nextItem.path) ?? [];
                    linkHeadingSelect.innerHTML = `<option value="">None</option>${headings.map((heading) => `<option value="${heading.text}">${heading.text}</option>`).join('')}`;
                });
            }
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
                linkSearchResults = [];
                selectedLinkItem = null;
                if (linkHeadingSelect) {
                    linkHeadingSelect.innerHTML = '<option value="">None</option>';
                }
                renderLinkResults();
                return;
            }

            linkSearchResults = await options.searchLinks(query);
            selectedLinkItem = linkSearchResults[0] ?? null;
            renderLinkResults();
            if (selectedLinkItem && linkHeadingSelect) {
                const headings = await options.loadHeadings?.(selectedLinkItem.path) ?? [];
                linkHeadingSelect.innerHTML = `<option value="">None</option>${headings.map((heading) => `<option value="${heading.text}">${heading.text}</option>`).join('')}`;
            }
        };

        const handleInput = (): void => {
            syncFromEditor();
        };

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Tab') {
                event.preventDefault();
                document.execCommand('insertText', false, '    ');
                syncFromEditor();
            }
        };

        const handleSelectionChange = (): void => {
            syncFromEditor();
        };

        const handleFocusOut = (event: FocusEvent): void => {
            const nextTarget = event.relatedTarget as Node | null;
            const widgetShell = shell?.closest('.tool-shell');
            if (nextTarget && (shell?.contains(nextTarget) || widgetShell?.contains(nextTarget))) {
                return;
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
                if (linkHeadingSelect) {
                    linkHeadingSelect.innerHTML = '<option value="">None</option>';
                }
                renderLinkResults();
                return;
            }
            applyMarkdownFormat(format);
            syncFromEditor();
        };

        const handleBlockStyleChange = (): void => {
            if (!blockStyleSelect?.value) {
                return;
            }
            editor.focus();
            restoreSelection();
            applyMarkdownFormat('block-style', blockStyleSelect.value);
            syncFromEditor();
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
            if (linkHeadingSelect) {
                linkHeadingSelect.innerHTML = '<option value="">None</option>';
            }
            linkSearchResults = [];
            selectedLinkItem = null;
            renderLinkResults();
        };

        const handleLinkApply = (): void => {
            editor.focus();
            restoreSelection();
            if (linkMode === 'url') {
                const href = linkInput?.value?.trim();
                const label = linkLabelInput?.value?.trim() || window.getSelection()?.toString().trim() || href || 'link';
                if (href) {
                    document.execCommand('insertHTML', false, `<a href="${href}">${label}</a>`);
                    syncFromEditor();
                }
            } else if (selectedLinkItem) {
                const selectedHeading = linkHeadingSelect?.value?.trim();
                const alias = linkAliasInput?.value?.trim();
                const pathPart = selectedLinkItem.path === options.currentFilePath ? '' : selectedLinkItem.wikiPath;
                const wikiLink = `[[${pathPart}${selectedHeading ? `#${selectedHeading}` : ''}${alias ? `|${alias}` : ''}]]`;
                const href = `${selectedLinkItem.relativePath}${selectedHeading ? `#${selectedHeading}` : ''}`;
                const label = alias || selectedHeading || selectedLinkItem.title;
                document.execCommand('insertHTML', false, `<a href="${href}" data-wiki-link="${wikiLink}">${label}</a>`);
                syncFromEditor();
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
        syncFromEditor();
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
                editor.innerHTML = renderMarkdown(value);
                syncFromEditor();
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
        const nextTarget = event.relatedTarget as Node | null;
        const widgetShell = shell?.closest('.tool-shell');
        if (nextTarget && (shell?.contains(nextTarget) || widgetShell?.contains(nextTarget))) {
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
