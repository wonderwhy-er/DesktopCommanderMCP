import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Markdown } from 'tiptap-markdown';
import { rewriteWikiLinks } from './linking.js';
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

function applyRawTab(textarea: HTMLTextAreaElement): void {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextValue = `${textarea.value.slice(0, start)}\t${textarea.value.slice(end)}`;
    textarea.value = nextValue;
    textarea.selectionStart = start + 1;
    textarea.selectionEnd = start + 1;
}

/**
 * Preprocess raw markdown before feeding Tiptap: rewrite [[wiki]] links to
 * standard `[alias](href "mcp-wiki:ENCODED")` form. The title-prefixed
 * representation survives round-trips through the prose-model and lets us
 * restore the original wiki syntax on serialize.
 */
function preprocessForTiptap(source: string): string {
    return rewriteWikiLinks(source);
}

/**
 * Postprocess Tiptap's markdown output: convert `[alias](href "mcp-wiki:enc")`
 * links back to their original `[[...]]` wiki syntax.
 */
function postprocessFromTiptap(markdown: string): string {
    return markdown.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"mcp-wiki:([^"]+)")\)/g, (_, _alias, _href, encoded) => {
        try {
            return decodeURIComponent(encoded);
        } catch {
            return `[[${encoded}]]`;
        }
    });
}

/**
 * Walk the prose-mirror DOM and assign slug-based id attributes to headings
 * so the outline's revealLine can scroll to them. Re-run after every update.
 */
function syncHeadingIds(root: HTMLElement): void {
    const nextSlug = createSlugTracker();
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
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
    let linkMode: 'file' | 'url' = 'file';
    let linkSearchResults: MarkdownLinkSearchItem[] = [];
    let selectedLinkItem: MarkdownLinkSearchItem | null = null;
    let linkResultsMessage = 'Search for a file to link';
    let linkSearchRequestId = 0;
    let linkHeadingRequestId = 0;

    if (options.view === 'markdown') {
        options.target.replaceChildren();

        const getTiptapMarkdown = (): string => {
            const storage = tiptap.storage as { markdown?: { getMarkdown: () => string } };
            return postprocessFromTiptap(storage.markdown?.getMarkdown() ?? '');
        };

        const tiptap = new Editor({
            element: options.target,
            extensions: [
                StarterKit.configure({
                    heading: { levels: [1, 2, 3, 4, 5, 6] },
                    codeBlock: { HTMLAttributes: { class: 'code-viewer' } },
                    link: {
                        openOnClick: false,
                        autolink: true,
                        HTMLAttributes: { 'data-markdown-link': 'true' },
                    },
                }),
                Image.configure({ allowBase64: true, inline: true }),
                Markdown.configure({
                    html: true,
                    tightLists: true,
                    bulletListMarker: '-',
                    linkify: true,
                    breaks: false,
                    transformPastedText: true,
                    transformCopiedText: false,
                }),
            ],
            content: preprocessForTiptap(options.value),
            editorProps: {
                attributes: {
                    class: 'markdown-editor-surface markdown-editor-surface--markdown markdown markdown-doc',
                    role: 'textbox',
                    'aria-multiline': 'true',
                },
            },
            onUpdate: ({ editor }) => {
                syncHeadingIds(editor.view.dom as HTMLElement);
                options.onChange(getTiptapMarkdown());
            },
            onSelectionUpdate: () => {
                updateContextMenu();
            },
            onBlur: ({ event }) => {
                if (shouldIgnoreBlur(shell, event as FocusEvent)) {
                    return;
                }
                if (contextMenu) {
                    contextMenu.hidden = true;
                }
                options.onBlur?.();
            },
        });

        const editorDom = tiptap.view.dom as HTMLElement;
        syncHeadingIds(editorDom);

        const updateContextMenu = (): void => {
            if (!contextMenu) {
                return;
            }
            const { from, to, empty } = tiptap.state.selection;
            if (empty || !tiptap.isFocused) {
                contextMenu.hidden = true;
                return;
            }
            const start = tiptap.view.coordsAtPos(from);
            const end = tiptap.view.coordsAtPos(to);
            const shellEl = shell as HTMLElement | null;
            if (!shellEl) {
                return;
            }
            const shellRect = shellEl.getBoundingClientRect();
            const midX = (start.left + end.right) / 2;
            contextMenu.hidden = false;
            const left = Math.max(12, midX - shellRect.left - contextMenu.offsetWidth / 2);
            const top = Math.max(12, start.top - shellRect.top - contextMenu.offsetHeight - 10);
            contextMenu.style.left = `${left}px`;
            contextMenu.style.top = `${top}px`;
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

        const closeLinkModal = (): void => {
            linkModal?.setAttribute('hidden', '');
            if (linkInput) { linkInput.value = ''; }
            if (linkLabelInput) { linkLabelInput.value = ''; }
            if (linkAliasInput) { linkAliasInput.value = ''; }
            if (linkSearchInput) { linkSearchInput.value = ''; }
            setLinkHeadingOptions();
            linkSearchResults = [];
            selectedLinkItem = null;
            linkResultsMessage = 'Search for a file to link';
            renderLinkResults();
        };

        const openLinkModalForSelection = (): void => {
            if (!linkModal) {
                return;
            }
            const selectedText = tiptap.state.doc.textBetween(tiptap.state.selection.from, tiptap.state.selection.to, ' ').trim();
            linkModal.removeAttribute('hidden');
            updateLinkMode('url');
            if (linkLabelInput) {
                linkLabelInput.value = selectedText;
            }
            if (linkInput) {
                linkInput.value = '';
                linkInput.focus();
            }
            linkSearchResults = [];
            selectedLinkItem = null;
            linkResultsMessage = 'Search for a file to link';
            setLinkHeadingOptions();
            renderLinkResults();
        };

        const handleLinkApply = (): void => {
            if (linkMode === 'url') {
                const href = linkInput?.value?.trim();
                if (!href) {
                    closeLinkModal();
                    return;
                }
                const label = linkLabelInput?.value?.trim() || href;
                const { from, to, empty } = tiptap.state.selection;
                if (empty) {
                    tiptap.chain().focus().insertContent({
                        type: 'text',
                        text: label,
                        marks: [{ type: 'link', attrs: { href } }],
                    }).run();
                } else {
                    // Replace selection with new text that carries the link mark.
                    tiptap.chain()
                        .focus()
                        .deleteRange({ from, to })
                        .insertContent({
                            type: 'text',
                            text: label,
                            marks: [{ type: 'link', attrs: { href } }],
                        })
                        .run();
                }
            } else if (selectedLinkItem) {
                const selectedHeadingId = linkHeadingSelect?.value?.trim();
                const selectedHeadingText = linkHeadingSelect?.selectedOptions[0]?.dataset.headingText?.trim();
                const alias = linkAliasInput?.value?.trim();
                const pathPart = selectedLinkItem.path === options.currentFilePath ? '' : selectedLinkItem.wikiPath;
                const wikiLink = `[[${pathPart}${selectedHeadingId ? `#${selectedHeadingId}` : ''}${alias ? `|${alias}` : ''}]]`;
                const href = `${selectedLinkItem.relativePath}${selectedHeadingId ? `#${selectedHeadingId}` : ''}`;
                const label = alias || selectedHeadingText || selectedLinkItem.title;
                const { from, to, empty } = tiptap.state.selection;
                const insertChain = tiptap.chain().focus();
                if (!empty) {
                    insertChain.deleteRange({ from, to });
                }
                insertChain.insertContent({
                    type: 'text',
                    text: label,
                    marks: [{
                        type: 'link',
                        attrs: {
                            href,
                            title: `mcp-wiki:${encodeURIComponent(wikiLink)}`,
                        },
                    }],
                }).run();
            }
            closeLinkModal();
        };

        const handleFormatClick = (event: Event): void => {
            const target = event.currentTarget as HTMLButtonElement;
            const format = target.dataset.format;
            if (!format) {
                return;
            }
            tiptap.commands.focus();
            switch (format) {
                case 'bold':
                    tiptap.chain().focus().toggleBold().run();
                    break;
                case 'italic':
                    tiptap.chain().focus().toggleItalic().run();
                    break;
                case 'strike':
                    tiptap.chain().focus().toggleStrike().run();
                    break;
                case 'quote':
                    tiptap.chain().focus().toggleBlockquote().run();
                    break;
                case 'list':
                    tiptap.chain().focus().toggleBulletList().run();
                    break;
                case 'code':
                    tiptap.chain().focus().toggleCode().run();
                    break;
                case 'link':
                    openLinkModalForSelection();
                    break;
                default:
                    break;
            }
        };

        const handleBlockStyleChange = (): void => {
            const value = blockStyleSelect?.value;
            if (!value) {
                return;
            }
            tiptap.commands.focus();
            if (value === 'p') {
                tiptap.chain().focus().setParagraph().run();
                return;
            }
            const match = /^h([1-6])$/.exec(value);
            if (match) {
                const level = Number.parseInt(match[1], 10) as 1 | 2 | 3 | 4 | 5 | 6;
                tiptap.chain().focus().toggleHeading({ level }).run();
            }
        };

        // Link hover popover (edit / open)
        const linkPopover = document.createElement('div');
        linkPopover.className = 'markdown-link-popover';
        linkPopover.hidden = true;
        editorDom.parentElement?.appendChild(linkPopover);
        let popoverHideTimer: ReturnType<typeof setTimeout> | null = null;

        const showLinkPopover = (anchor: HTMLAnchorElement): void => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
            const href = anchor.getAttribute('href') ?? '';
            linkPopover.innerHTML = `<button class="markdown-link-popover-btn" id="link-popover-edit" type="button" title="Edit link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="markdown-link-popover-btn" id="link-popover-open" type="button" title="Open link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`;
            linkPopover.hidden = false;

            linkPopover.querySelector('#link-popover-open')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                linkPopover.hidden = true;
                anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }, { once: true });

            linkPopover.querySelector('#link-popover-edit')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                linkPopover.hidden = true;
                if (!linkModal) {
                    return;
                }
                // Select the link text in the editor, then open the modal in URL mode.
                const pos = tiptap.view.posAtDOM(anchor, 0);
                if (pos >= 0) {
                    const endPos = pos + (anchor.textContent?.length ?? 0);
                    tiptap.chain().focus().setTextSelection({ from: pos, to: endPos }).run();
                }
                const label = anchor.textContent?.trim() ?? '';
                linkModal.removeAttribute('hidden');
                updateLinkMode('url');
                if (linkInput) { linkInput.value = href; }
                if (linkLabelInput) { linkLabelInput.value = label; }
            }, { once: true });

            const rect = anchor.getBoundingClientRect();
            const parent = editorDom.parentElement;
            if (!parent) {
                return;
            }
            const parentRect = parent.getBoundingClientRect();
            linkPopover.style.left = `${Math.max(4, rect.left - parentRect.left)}px`;
            linkPopover.style.top = `${rect.bottom - parentRect.top + 4}px`;
        };

        const hideLinkPopover = (): void => {
            popoverHideTimer = setTimeout(() => {
                linkPopover.hidden = true;
            }, 200);
        };

        const handleMouseOver = (e: MouseEvent): void => {
            const target = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
            if (target && editorDom.contains(target)) {
                showLinkPopover(target);
            }
        };
        const handleMouseOut = (e: MouseEvent): void => {
            const target = (e.target as HTMLElement)?.closest?.('a[href]');
            if (target) {
                hideLinkPopover();
            }
        };
        editorDom.addEventListener('mouseover', handleMouseOver);
        editorDom.addEventListener('mouseout', handleMouseOut);
        linkPopover.addEventListener('mouseenter', () => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
        });
        linkPopover.addEventListener('mouseleave', () => {
            hideLinkPopover();
        });

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
        const handleModalBackdropClick = (e: MouseEvent): void => {
            if (e.target === linkModal) {
                closeLinkModal();
            }
        };
        linkModal?.addEventListener('click', handleModalBackdropClick);

        if (typeof options.initialScrollTop === 'number') {
            editorDom.scrollTop = options.initialScrollTop;
        }
        renderLinkResults();

        return {
            destroy: () => {
                editorDom.removeEventListener('mouseover', handleMouseOver);
                editorDom.removeEventListener('mouseout', handleMouseOut);
                formatButtons.forEach((button) => button.removeEventListener('click', handleFormatClick));
                blockStyleSelect?.removeEventListener('change', handleBlockStyleChange);
                linkSearchInput?.removeEventListener('input', handleSearchInput);
                linkApply?.removeEventListener('click', handleLinkApply);
                linkCancel?.removeEventListener('click', closeLinkModal);
                linkModal?.removeEventListener('click', handleModalBackdropClick);
                linkPopover.remove();
                if (popoverHideTimer) { clearTimeout(popoverHideTimer); }
                tiptap.destroy();
                options.target.replaceChildren();
            },
            focus: () => {
                tiptap.commands.focus();
            },
            getValue: () => getTiptapMarkdown(),
            setValue: (value: string) => {
                tiptap.commands.setContent(preprocessForTiptap(value), { emitUpdate: false });
                syncHeadingIds(editorDom);
            },
            revealLine: (_lineNumber: number, headingId?: string) => {
                if (headingId) {
                    const heading = editorDom.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`);
                    if (heading) {
                        heading.scrollIntoView({ block: 'start', inline: 'nearest' });
                        editorDom.scrollTop = Math.max(editorDom.scrollTop - 24, 0);
                        heading.setAttribute('tabindex', '-1');
                        heading.focus({ preventScroll: true });
                        return;
                    }
                }
                tiptap.commands.focus();
            },
            setScrollTop: (scrollTop: number) => {
                editorDom.scrollTop = Math.max(0, scrollTop);
            },
        };
    }

    // Raw textarea view — unchanged behavior.
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
