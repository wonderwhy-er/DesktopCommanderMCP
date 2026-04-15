import { renderMarkdown } from '../components/markdown-renderer.js';
import { createMarkdownIt, prepareMarkdownSource } from './parser.js';
import { createSlugTracker } from './slugify.js';

const blockTokenizer = createMarkdownIt();

interface BlockRange {
    /** Character offset of block start in the source string */
    start: number;
    /** Character offset of block end in the source string */
    end: number;
}

/**
 * Compute character-offset ranges for each top-level markdown block.
 * Each range maps 1:1 to a top-level HTML element in the rendered output.
 */
function computeBlockRanges(source: string): BlockRange[] {
    const prepared = prepareMarkdownSource(source);
    const tokens = blockTokenizer.parse(prepared, {});
    const lines = source.split('\n');
    const ranges: BlockRange[] = [];
    let lastEndLine = 0;

    // Precompute line start offsets
    const lineOffsets: number[] = [0];
    for (let i = 0; i < lines.length; i++) {
        lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
    }

    for (const token of tokens) {
        if (!token.map || token.map.length < 2) {
            continue;
        }
        const [startLine, endLine] = token.map;
        const isOpening = typeof token.type === 'string'
            && (token.type.endsWith('_open') || token.type === 'hr' || token.type === 'fence' || token.type === 'code_block' || token.type === 'html_block');
        if (!isOpening || startLine < lastEndLine) {
            continue;
        }

        ranges.push({
            start: lineOffsets[startLine],
            end: lineOffsets[endLine] - 1, // exclude trailing \n
        });
        lastEndLine = endLine;
    }

    return ranges;
}

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
            return `${Array.from(element.children).map((child) => {
                const content = serializeNode(child).trim();
                const lines = content.split('\n');
                return lines.map((line, idx) => idx === 0 ? `- ${line}` : `  ${line}`).join('\n');
            }).join('\n')}\n\n`;
        case 'ol':
            return `${Array.from(element.children).map((child, index) => {
                const content = serializeNode(child).trim();
                const prefix = `${index + 1}. `;
                const lines = content.split('\n');
                return lines.map((line, idx) => idx === 0 ? `${prefix}${line}` : `${' '.repeat(prefix.length)}${line}`).join('\n');
            }).join('\n')}\n\n`;
        case 'li':
            return children;
        case 'div':
            return `${children}${children.endsWith('\n') ? '' : '\n'}`;
        default:
            return children;
    }
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

        // Block-level preservation: store original source, block ranges, baseline HTML
        // and baseline text per block. On edits, try to patch the raw markdown directly
        // using text diffs — only fall back to serializeNode when text patching fails.
        let originalSource = options.value;
        let blockRanges = computeBlockRanges(options.value);
        let baselineElementsHtml = Array.from(editor.children).map((el) => el.innerHTML);
        const extractVisibleText = (el: Element): string => {
            let text = '';
            for (const node of el.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.textContent ?? '';
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    const child = node as Element;
                    if (child.tagName === 'IMG') {
                        text += child.getAttribute('alt') ?? '';
                    } else if (child.tagName === 'BR') {
                        text += '\n';
                    } else {
                        text += extractVisibleText(child);
                    }
                }
            }
            return text;
        };

        let baselineElementsText = Array.from(editor.children).map((el) => extractVisibleText(el));
        let baselineSerializedBlocks = Array.from(editor.children).map((el) => serializeNode(el).trim());

        /**
         * Try to apply a text-level change directly to the raw markdown source.
         * Compares plain text before/after to find what changed, then locates
         * and replaces that text in the source — no HTML→markdown conversion needed.
         */
        const tryTextPatch = (
            oldText: string,
            newText: string,
            source: string,
            rangeStart: number,
            rangeEnd: number
        ): string | null => {
            if (oldText === newText) {
                return null; // Text unchanged, formatting changed — serialize block to markdown
            }

            let prefixLen = 0;
            const minLen = Math.min(oldText.length, newText.length);
            while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
                prefixLen++;
            }

            let suffixLen = 0;
            const maxSuffix = Math.min(oldText.length - prefixLen, newText.length - prefixLen);
            while (
                suffixLen < maxSuffix
                && oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
            ) {
                suffixLen++;
            }

            const oldPart = oldText.slice(prefixLen, oldText.length - suffixLen);
            const newPart = newText.slice(prefixLen, newText.length - suffixLen);

            if (oldPart.length === 0 && newPart.length === 0) {
                return source;
            }

            const blockSource = source.slice(rangeStart, rangeEnd);

            if (oldPart.length === 0) {
                // Insertion: locate by surrounding context (before + after)
                const contextBefore = oldText.slice(Math.max(0, prefixLen - 30), prefixLen);
                const contextAfter = oldText.slice(prefixLen, prefixLen + 30);
                const fullContext = contextBefore + contextAfter;
                if (fullContext.length > 0) {
                    const contextIndex = blockSource.indexOf(fullContext);
                    if (contextIndex >= 0) {
                        const insertPos = rangeStart + contextIndex + contextBefore.length;
                        return source.slice(0, insertPos) + newPart + source.slice(insertPos);
                    }
                }
                if (contextBefore.length > 0) {
                    const contextIndex = blockSource.indexOf(contextBefore);
                    if (contextIndex >= 0) {
                        const insertPos = rangeStart + contextIndex + contextBefore.length;
                        return source.slice(0, insertPos) + newPart + source.slice(insertPos);
                    }
                }
                return null;
            }

            // Replacement or deletion: use surrounding context to find the right occurrence
            const contextBefore = oldText.slice(Math.max(0, prefixLen - 30), prefixLen);
            const contextAfter = oldText.slice(prefixLen + oldPart.length, prefixLen + oldPart.length + 30);
            const searchWithContext = contextBefore + oldPart + contextAfter;
            const contextIdx = blockSource.indexOf(searchWithContext);
            if (contextIdx >= 0) {
                const pos = rangeStart + contextIdx + contextBefore.length;
                return source.slice(0, pos) + newPart + source.slice(pos + oldPart.length);
            }

            // No context match — try plain search, but only if unambiguous
            const firstIndex = blockSource.indexOf(oldPart);
            if (firstIndex < 0) {
                return null;
            }
            if (blockSource.indexOf(oldPart, firstIndex + 1) >= 0) {
                return null; // ambiguous — fall back to serializeNode
            }

            const pos = rangeStart + firstIndex;
            return source.slice(0, pos) + newPart + source.slice(pos + oldPart.length);
        };

        const patchMarkdownFromHtml = (): string => {
            const currentElements = Array.from(editor.children);
            if (
                currentElements.length === baselineElementsHtml.length
                && baselineElementsHtml.length === blockRanges.length
            ) {
                let result = originalSource;
                for (let i = currentElements.length - 1; i >= 0; i--) {
                    if (currentElements[i].innerHTML === baselineElementsHtml[i]) {
                        continue;
                    }

                    const oldText = baselineElementsText[i];
                    const newText = extractVisibleText(currentElements[i]);

                    // Try text-level patch first (preserves all raw markdown)
                    const patched = tryTextPatch(oldText, newText, result, blockRanges[i].start, blockRanges[i].end);
                    if (patched !== null) {
                        result = patched;
                    } else {
                        // Formatting-only change: diff serialized outputs and apply
                        // only the formatting markers to the raw source
                        const oldSerialized = baselineSerializedBlocks[i];
                        const newSerialized = serializeNode(currentElements[i]).trim();
                        const formattingPatched = tryTextPatch(oldSerialized, newSerialized, result, blockRanges[i].start, blockRanges[i].end);
                        if (formattingPatched !== null) {
                            result = formattingPatched;
                        }
                    }
                }
                return result;
            }
            // Block count changed — serialize all blocks from the DOM.
            // This may lose some markdown formatting nuances but never deletes content.
            return Array.from(currentElements)
                .map((el) => serializeNode(el))
                .join('')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        };

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

        const resetBaselines = (): void => {
            blockRanges = computeBlockRanges(originalSource);
            baselineElementsHtml = Array.from(editor.children).map((el) => el.innerHTML);
            baselineElementsText = Array.from(editor.children).map((el) => extractVisibleText(el));
            baselineSerializedBlocks = Array.from(editor.children).map((el) => serializeNode(el).trim());
        };

        const syncFromEditor = (syncContent: boolean): void => {
            if (syncContent) {
                syncHeadingAttributes();
                const nextMarkdownValue = patchMarkdownFromHtml();
                if (nextMarkdownValue !== lastMarkdownValue) {
                    lastMarkdownValue = nextMarkdownValue;
                    originalSource = nextMarkdownValue;
                    resetBaselines();
                    options.onChange(nextMarkdownValue);
                } else {
                    // DOM changed but markdown didn't — keep baselines in sync
                    resetBaselines();
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

        /**
         * Get the visible-text offset of the cursor within a given container element.
         * Walks the DOM tree in order, counting text characters until the cursor position.
         */
        const getCursorTextOffset = (container: Element): number | null => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return null;
            const range = sel.getRangeAt(0);
            // Create a range from container start to cursor
            const preRange = document.createRange();
            preRange.setStart(container, 0);
            preRange.setEnd(range.startContainer, range.startOffset);
            // Use a temporary element to extract text length
            const fragment = preRange.cloneContents();
            const div = document.createElement('div');
            div.appendChild(fragment);
            return extractVisibleText(div).length;
        };

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Tab') {
                event.preventDefault();
                document.execCommand('insertText', false, '    ');
                syncFromEditor(true);
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                // Insert \n\n directly into the raw source at the cursor position
                const blockRange = getSelectionBlockRange();
                const sel = window.getSelection();
                let blockEl: Element | null = null;
                let node: Node | null = sel?.anchorNode ?? null;
                while (node && node.parentElement !== editor) {
                    node = node.parentElement;
                }
                if (node) blockEl = node as Element;
                const blockIdx = blockEl ? Array.from(editor.children).indexOf(blockEl) : -1;

                if (blockRange && blockEl && blockIdx >= 0) {
                    const cursorOffset = getCursorTextOffset(blockEl);
                    if (cursorOffset !== null) {
                        const blockText = extractVisibleText(blockEl);
                        const textBefore = blockText.slice(Math.max(0, cursorOffset - 30), cursorOffset);
                        const blockSource = originalSource.slice(blockRange.start, blockRange.end);

                        // Find cursor position in source using text context
                        let sourcePos = -1;
                        if (textBefore.length > 0) {
                            const idx = blockSource.lastIndexOf(textBefore);
                            if (idx >= 0) {
                                sourcePos = blockRange.start + idx + textBefore.length;
                            }
                        } else {
                            // Cursor at start of block
                            sourcePos = blockRange.start;
                        }

                        if (sourcePos >= 0) {
                            event.preventDefault();
                            originalSource = originalSource.slice(0, sourcePos) + '\n\n' + originalSource.slice(sourcePos);
                            lastMarkdownValue = originalSource;
                            editor.innerHTML = renderMarkdown(originalSource);
                            resetBaselines();
                            syncHeadingAttributes();
                            options.onChange(originalSource);
                            // Place cursor after the new paragraph break
                            requestAnimationFrame(() => {
                                const newChildren = Array.from(editor.children);
                                // The new block should be right after the split
                                const targetBlock = newChildren[blockIdx + 1] ?? newChildren[blockIdx];
                                if (targetBlock) {
                                    const r = document.createRange();
                                    r.setStart(targetBlock, 0);
                                    r.collapse(true);
                                    const s = window.getSelection();
                                    s?.removeAllRanges();
                                    s?.addRange(r);
                                }
                            });
                            return;
                        }
                    }
                }
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

        const getSelectionBlockRange = (): BlockRange | null => {
            const sel = window.getSelection();
            let node: Node | null = sel?.anchorNode ?? null;
            while (node && node.parentElement !== editor) {
                node = node.parentElement;
            }
            if (!node) return null;
            const idx = Array.from(editor.children).indexOf(node as Element);
            return idx >= 0 && idx < blockRanges.length ? blockRanges[idx] : null;
        };

        const applyMarkdownFormatToSource = (format: string, selectedText: string): boolean => {
            if (!selectedText) {
                return false;
            }
            const wrappers: Record<string, [string, string]> = {
                bold: ['**', '**'],
                italic: ['*', '*'],
                strike: ['~~', '~~'],
                code: ['`', '`'],
            };
            const wrapper = wrappers[format];
            if (!wrapper) {
                return false;
            }
            const [prefix, suffix] = wrapper;
            const range = getSelectionBlockRange();
            const searchSlice = range ? originalSource.slice(range.start, range.end) : originalSource;
            const offset = range ? range.start : 0;
            // Check if already wrapped — toggle off
            const wrappedSearch = `${prefix}${selectedText}${suffix}`;
            const unwrapIdx = searchSlice.indexOf(wrappedSearch);
            if (unwrapIdx >= 0) {
                const abs = offset + unwrapIdx;
                originalSource = originalSource.slice(0, abs) + selectedText + originalSource.slice(abs + wrappedSearch.length);
            } else {
                // Wrap — find the selected text in source
                const idx = searchSlice.indexOf(selectedText);
                if (idx < 0) {
                    return false;
                }
                const abs = offset + idx;
                originalSource = originalSource.slice(0, abs) + prefix + selectedText + suffix + originalSource.slice(abs + selectedText.length);
            }
            lastMarkdownValue = originalSource;
            editor.innerHTML = renderMarkdown(originalSource);
            resetBaselines();
            syncHeadingAttributes();
            options.onChange(originalSource);
            return true;
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
                return;
            }
            const selectedText = window.getSelection()?.toString() ?? '';
            if (applyMarkdownFormatToSource(format, selectedText)) {
                return;
            }
            // Fallback for unsupported formats
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
            editingLinkOldHref = null;
            linkResultsMessage = 'Search for a file to link';
            renderLinkResults();
        };

        const handleLinkApply = (): void => {
            editor.focus();
            restoreSelection();
            if (linkMode === 'url') {
                const href = linkInput?.value?.trim();
                const label = linkLabelInput?.value?.trim() || window.getSelection()?.toString().trim() || href || 'link';
                const selectedText = window.getSelection()?.toString() ?? '';
                if (href && selectedText) {
                    const markdownLink = `[${label}](${href})`;
                    const range = getSelectionBlockRange();
                    const searchSlice = range ? originalSource.slice(range.start, range.end) : originalSource;
                    const searchOffset = range ? range.start : 0;
                    // When editing an existing link, replace the full [text](old-url) instead of just the visible text
                    const oldLink = editingLinkOldHref ? `[${selectedText}](${editingLinkOldHref})` : null;
                    const searchTarget = oldLink && searchSlice.includes(oldLink) ? oldLink : selectedText;
                    const idx = searchSlice.indexOf(searchTarget);
                    if (idx >= 0) {
                        const abs = searchOffset + idx;
                        originalSource = originalSource.slice(0, abs) + markdownLink + originalSource.slice(abs + searchTarget.length);
                        lastMarkdownValue = originalSource;
                        editor.innerHTML = renderMarkdown(originalSource);
                        resetBaselines();
                        syncHeadingAttributes();
                        options.onChange(originalSource);
                    }
                } else if (href) {
                    // No selection — insert link at cursor
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

        // Link hover popover
        const linkPopover = document.createElement('div');
        linkPopover.className = 'markdown-link-popover';
        linkPopover.hidden = true;
        editor.parentElement?.appendChild(linkPopover);
        let popoverHideTimer: ReturnType<typeof setTimeout> | null = null;

        let activePopoverAnchor: HTMLAnchorElement | null = null;
        let editingLinkOldHref: string | null = null;

        const showLinkPopover = (anchor: HTMLAnchorElement): void => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
            activePopoverAnchor = anchor;
            const href = anchor.getAttribute('href') ?? '';
            linkPopover.innerHTML = `<button class="markdown-link-popover-btn" id="link-popover-edit" type="button" title="Edit link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="markdown-link-popover-btn" id="link-popover-open" type="button" title="Open link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`;
            linkPopover.hidden = false;

            linkPopover.querySelector('#link-popover-open')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                linkPopover.hidden = true;
                // Dispatch a click on the anchor so the controller's link handler opens it
                anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }, { once: true });

            linkPopover.querySelector('#link-popover-edit')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                linkPopover.hidden = true;
                // Select the link text and open the link modal in URL mode
                const selection = window.getSelection();
                if (selection) {
                    const range = document.createRange();
                    range.selectNodeContents(anchor);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    savedRange = range.cloneRange();
                }
                const label = anchor.textContent?.trim() ?? '';
                editingLinkOldHref = href;
                linkModal?.removeAttribute('hidden');
                updateLinkMode('url');
                if (linkInput) { linkInput.value = href; }
                if (linkLabelInput) { linkLabelInput.value = label; }
            }, { once: true });

            const rect = anchor.getBoundingClientRect();
            const parentRect = (editor.parentElement as HTMLElement).getBoundingClientRect();
            linkPopover.style.left = `${Math.max(4, rect.left - parentRect.left)}px`;
            linkPopover.style.top = `${rect.bottom - parentRect.top + 4}px`;
        };

        const hideLinkPopover = (): void => {
            popoverHideTimer = setTimeout(() => {
                linkPopover.hidden = true;
            }, 200);
        };

        editor.addEventListener('mouseover', (e) => {
            const target = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
            if (target && editor.contains(target)) {
                showLinkPopover(target);
            }
        });
        editor.addEventListener('mouseout', (e) => {
            const target = (e.target as HTMLElement)?.closest?.('a[href]');
            if (target) {
                hideLinkPopover();
            }
        });
        linkPopover.addEventListener('mouseenter', () => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
        });
        linkPopover.addEventListener('mouseleave', () => {
            hideLinkPopover();
        });

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
        const handleModalBackdropClick = (e: MouseEvent): void => {
            if (e.target === linkModal) {
                closeLinkModal();
            }
        };
        linkModal?.addEventListener('click', handleModalBackdropClick);
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
                linkModal?.removeEventListener('click', handleModalBackdropClick);
                linkPopover.remove();
                if (popoverHideTimer) { clearTimeout(popoverHideTimer); }
                options.target.replaceChildren();
            },
            focus: () => {
                editor.focus();
            },
            getValue: () => patchMarkdownFromHtml(),
            setValue: (value: string) => {
                lastMarkdownValue = value;
                editor.innerHTML = renderMarkdown(value);
                originalSource = value;
                resetBaselines();
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
