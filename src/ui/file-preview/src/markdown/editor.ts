import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view';

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

interface MarkdownLinkRange {
    from: number;
    labelFrom: number;
    labelTo: number;
    to: number;
    label: string;
    href: string;
    kind: 'markdown' | 'wiki';
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
          ${isMarkdownView ? `<div id="markdown-editor-context-menu" class="markdown-editor-toolbar" hidden>${renderFormattingButtons()}</div><div id="markdown-link-modal" class="markdown-link-modal" hidden><div class="markdown-link-modal-card"><div class="markdown-link-mode-tabs"><button type="button" id="markdown-link-mode-file" class="markdown-link-mode-tab is-active">File</button><button type="button" id="markdown-link-mode-url" class="markdown-link-mode-tab">URL</button></div><div id="markdown-link-file-fields"><label class="markdown-link-modal-label" for="markdown-link-search">Find note</label><input id="markdown-link-search" class="markdown-link-modal-input" type="text" placeholder="Search files..." /><div id="markdown-link-results" class="markdown-link-results"></div><label class="markdown-link-modal-label" for="markdown-link-heading">Heading</label><select id="markdown-link-heading" class="markdown-link-modal-input markdown-link-modal-select"><option value="">None</option></select><label class="markdown-link-modal-label" for="markdown-link-alias">Alias</label><input id="markdown-link-alias" class="markdown-link-modal-input" type="text" placeholder="Optional label" /></div><div id="markdown-link-url-fields" hidden><label class="markdown-link-modal-label" for="markdown-link-input">URL</label><input id="markdown-link-input" class="markdown-link-modal-input" type="url" placeholder="https://example.com" /><label class="markdown-link-modal-label" for="markdown-link-label">Label</label><input id="markdown-link-label" class="markdown-link-modal-input" type="text" placeholder="Optional label" /></div><div class="markdown-link-modal-actions"><button type="button" id="markdown-link-cancel" class="markdown-link-modal-button">Cancel</button><button type="button" id="markdown-link-apply" class="markdown-link-modal-button markdown-link-modal-button--primary">Insert</button></div></div></div>` : ''}
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

function isInlineMarkerAt(source: string, index: number, marker: string): boolean {
    if (!source.startsWith(marker, index)) {
        return false;
    }
    if (marker === '*') {
        return source[index - 1] !== '*' && source[index + 1] !== '*';
    }
    return true;
}

class BulletWidget extends WidgetType {
    eq(other: WidgetType): boolean {
        return other instanceof BulletWidget;
    }
    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-bullet';
        span.textContent = '•';
        return span;
    }
    // CodeMirror's default is to treat events from inside a widget as belonging
    // to it (so clicks won't move the caret). We want clicks on the bullet to
    // place the caret at the underlying marker position, like normal text.
    ignoreEvent(): boolean {
        return false;
    }
}

const SHARED_BULLET_WIDGET = new BulletWidget();

const UNORDERED_LIST_PREFIX = /^(\s*)[-*+]\s+/;
const ORDERED_LIST_PREFIX = /^\s*\d+[.)]\s+/;
const BLOCKQUOTE_PREFIX = /^\s*>\s?/;
const HORIZONTAL_RULE_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

// Order matters: longer prefixes first so `**` is matched before `*`.
const SPANNING_WRAPPER_KINDS: ReadonlyArray<{ prefix: string; suffix: string; className: string }> = [
    { prefix: '**', suffix: '**', className: 'cm-md-strong-text' },
    { prefix: '~~', suffix: '~~', className: 'cm-md-strike-text' },
    { prefix: '*', suffix: '*', className: 'cm-md-emphasis-text' },
    { prefix: '`', suffix: '`', className: 'cm-md-inline-code-text' },
];

interface MarkerRange {
    from: number;
    to: number;
    className?: string;
    widget?: WidgetType;
}

function buildMarkdownLineDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const addAbsoluteMark = (
        ranges: MarkerRange[],
        from: number,
        to: number,
        className: string
    ): void => {
        if (to > from) {
            ranges.push({ from, to, className });
        }
    };
    const addMark = (
        ranges: MarkerRange[],
        lineFrom: number,
        from: number,
        to: number,
        className: string
    ): void => {
        if (to > from) {
            ranges.push({ from: lineFrom + from, to: lineFrom + to, className });
        }
    };

    const collectSpanningWrapperRanges = (): MarkerRange[] => {
        const source = view.state.doc.toString();
        const ranges: MarkerRange[] = [];
        // Single linear scan that recognizes all wrapper kinds at once. Order
        // matters only for length tie-breaks (longer markers first); `*` vs `**`
        // is already disambiguated by isInlineMarkerAt's neighbor check.
        const opens: Array<number | null> = SPANNING_WRAPPER_KINDS.map(() => null);
        let index = 0;
        while (index < source.length) {
            let consumed = 0;
            for (let kind = 0; kind < SPANNING_WRAPPER_KINDS.length; kind += 1) {
                const { prefix, suffix, className } = SPANNING_WRAPPER_KINDS[kind];
                const openPos = opens[kind];
                if (openPos === null) {
                    if (isInlineMarkerAt(source, index, prefix)) {
                        opens[kind] = index;
                        consumed = prefix.length;
                        break;
                    }
                    continue;
                }
                if (isInlineMarkerAt(source, index, suffix)) {
                    const contentFrom = openPos + prefix.length;
                    const contentTo = index;
                    if (source.slice(contentFrom, contentTo).includes('\n')) {
                        addAbsoluteMark(ranges, openPos, contentFrom, 'cm-md-hidden-marker');
                        let line = view.state.doc.lineAt(contentFrom);
                        while (line.from <= contentTo) {
                            addAbsoluteMark(
                                ranges,
                                Math.max(contentFrom, line.from),
                                Math.min(contentTo, line.to),
                                className
                            );
                            if (line.to >= contentTo || line.number >= view.state.doc.lines) {
                                break;
                            }
                            line = view.state.doc.line(line.number + 1);
                        }
                        addAbsoluteMark(ranges, contentTo, index + suffix.length, 'cm-md-hidden-marker');
                    }
                    opens[kind] = null;
                    consumed = suffix.length;
                    break;
                }
            }
            index += consumed > 0 ? consumed : 1;
        }
        return ranges;
    };

    const spanningInlineRanges = collectSpanningWrapperRanges();

    const collectInlineRanges = (text: string, lineFrom: number): MarkerRange[] => {
        const ranges: MarkerRange[] = [];
        for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
            const start = match.index ?? 0;
            const label = match[1] ?? '';
            if (text[start - 1] === '!' || label.startsWith('![')) {
                continue;
            }
            addMark(ranges, lineFrom, start, start + 1, 'cm-md-hidden-marker');
            addMark(ranges, lineFrom, start + 1, start + 1 + label.length, 'cm-md-link-text');
            addMark(ranges, lineFrom, start + 1 + label.length, start + match[0].length, 'cm-md-hidden-marker');
        }
        for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
            const start = match.index ?? 0;
            const body = match[1] ?? '';
            const pipeIndex = body.lastIndexOf('|');
            const labelStart = pipeIndex >= 0 ? pipeIndex + 1 : 0;
            const label = body.slice(labelStart);
            addMark(ranges, lineFrom, start, start + 2, 'cm-md-hidden-marker');
            if (labelStart > 0) {
                addMark(ranges, lineFrom, start + 2, start + 2 + labelStart, 'cm-md-hidden-marker');
            }
            addMark(ranges, lineFrom, start + 2 + labelStart, start + 2 + labelStart + label.length, 'cm-md-link-text');
            addMark(ranges, lineFrom, start + 2 + labelStart + label.length, start + match[0].length, 'cm-md-hidden-marker');
        }
        for (const match of text.matchAll(/(`+)([^`\n]+)\1/g)) {
            const start = match.index ?? 0;
            const ticks = match[1]?.length ?? 1;
            addMark(ranges, lineFrom, start, start + ticks, 'cm-md-hidden-marker');
            addMark(ranges, lineFrom, start + ticks, start + match[0].length - ticks, 'cm-md-inline-code-text');
            addMark(ranges, lineFrom, start + match[0].length - ticks, start + match[0].length, 'cm-md-hidden-marker');
        }
        for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
            const start = match.index ?? 0;
            addMark(ranges, lineFrom, start, start + 2, 'cm-md-hidden-marker');
            addMark(ranges, lineFrom, start + 2, start + match[0].length - 2, 'cm-md-strong-text');
            addMark(ranges, lineFrom, start + match[0].length - 2, start + match[0].length, 'cm-md-hidden-marker');
        }
        for (const match of text.matchAll(/~~([^~\n]+)~~/g)) {
            const start = match.index ?? 0;
            addMark(ranges, lineFrom, start, start + 2, 'cm-md-hidden-marker');
            addMark(ranges, lineFrom, start + 2, start + match[0].length - 2, 'cm-md-strike-text');
            addMark(ranges, lineFrom, start + match[0].length - 2, start + match[0].length, 'cm-md-hidden-marker');
        }
        for (const match of text.matchAll(/(^|[^*])\*([^*\n]+)\*/g)) {
            const start = (match.index ?? 0) + (match[1]?.length ?? 0);
            addMark(ranges, lineFrom, start, start + 1, 'cm-md-hidden-marker');
            addMark(ranges, lineFrom, start + 1, start + match[0].length - (match[1]?.length ?? 0) - 1, 'cm-md-emphasis-text');
            addMark(ranges, lineFrom, start + match[0].length - (match[1]?.length ?? 0) - 1, start + match[0].length - (match[1]?.length ?? 0), 'cm-md-hidden-marker');
        }
        return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
    };

    for (const { from, to } of view.visibleRanges) {
        let line = view.state.doc.lineAt(from);
        while (line.from <= to) {
            const text = line.text;
            const headingMatch = /^(#{1,6})\s+/.exec(text);
            let className = '';
            const markerRanges: MarkerRange[] = [];
            if (headingMatch) {
                className = `cm-md-heading cm-md-heading-${headingMatch[1].length}`;
                addMark(markerRanges, line.from, 0, headingMatch[0].length, 'cm-md-hidden-marker');
            } else if (BLOCKQUOTE_PREFIX.test(text)) {
                className = 'cm-md-quote';
                const marker = text.match(BLOCKQUOTE_PREFIX);
                addMark(markerRanges, line.from, 0, marker?.[0].length ?? 0, 'cm-md-hidden-marker');
            } else {
                const unorderedMatch = UNORDERED_LIST_PREFIX.exec(text);
                if (unorderedMatch) {
                    className = 'cm-md-list cm-md-list-unordered';
                    const markerStart = unorderedMatch[1].length;
                    markerRanges.push({
                        from: line.from + markerStart,
                        to: line.from + markerStart + 1,
                        widget: SHARED_BULLET_WIDGET,
                    });
                } else if (ORDERED_LIST_PREFIX.test(text)) {
                    className = 'cm-md-list cm-md-list-ordered';
                } else if (HORIZONTAL_RULE_LINE.test(text)) {
                    className = 'cm-md-rule';
                }
            }

            if (className) {
                builder.add(line.from, line.from, Decoration.line({ class: className }));
            }
            markerRanges.push(...spanningInlineRanges.filter((range) => range.to > line.from && range.from < line.to));
            markerRanges.push(...collectInlineRanges(text, line.from));
            for (const range of markerRanges.sort((left, right) => left.from - right.from || left.to - right.to)) {
                if (range.widget) {
                    builder.add(range.from, range.to, Decoration.replace({ widget: range.widget }));
                } else if (range.className) {
                    builder.add(range.from, range.to, Decoration.mark({ class: range.className }));
                }
            }
            if (line.to >= to || line.number >= view.state.doc.lines) {
                break;
            }
            line = view.state.doc.line(line.number + 1);
        }
    }
    return builder.finish();
}

const markdownLinePreviewPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = buildMarkdownLineDecorations(view);
    }

    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = buildMarkdownLineDecorations(update.view);
        }
    }
}, {
    decorations: (plugin) => plugin.decorations,
});

export function mountMarkdownEditor(options: {
    target: HTMLElement;
    value: string;
    view: MarkdownEditorView;
    initialScrollTop?: number;
    currentFilePath: string;
    searchLinks?: (query: string) => Promise<MarkdownLinkSearchItem[]>;
    loadHeadings?: (filePath: string) => Promise<MarkdownLinkHeading[]>;
    onOpenLink?: (href: string) => void | Promise<void>;
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
        let suppressChange = false;
        let positionToolbar: (preferredPoint?: { x: number; y: number }) => void = () => {};
        let activePopoverLink: MarkdownLinkRange | null = null;
        let popoverHideTimer: ReturnType<typeof setTimeout> | null = null;
        const view = new EditorView({
            parent: options.target,
            state: EditorState.create({
                doc: options.value,
                extensions: [
                    history(),
                    markdown(),
                    EditorView.lineWrapping,
                    markdownLinePreviewPlugin,
                    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
                    EditorView.updateListener.of((update) => {
                        if (!suppressChange && update.docChanged) {
                            options.onChange(update.state.doc.toString());
                        }
                        if (update.selectionSet || update.focusChanged) {
                            window.requestAnimationFrame(() => positionToolbar());
                        }
                    }),
                ],
            }),
        });
        const linkPopover = document.createElement('div');
        linkPopover.className = 'markdown-link-popover';
        linkPopover.hidden = true;
        shell?.appendChild(linkPopover);

        const getValue = (): string => view.state.doc.toString();

        const getSelectedText = (): string => {
            const selection = view.state.selection.main;
            return view.state.doc.sliceString(selection.from, selection.to);
        };

        const insertText = (insert: string, selectFrom?: number, selectTo?: number): void => {
            const selection = view.state.selection.main;
            if (typeof selectFrom === 'number') {
                view.dispatch({
                    changes: { from: selection.from, to: selection.to, insert },
                    selection: EditorSelection.range(selection.from + selectFrom, selection.from + (selectTo ?? selectFrom)),
                    userEvent: 'input',
                });
            } else {
                view.dispatch({
                    changes: { from: selection.from, to: selection.to, insert },
                    userEvent: 'input',
                });
            }
            view.focus();
            window.requestAnimationFrame(() => positionToolbar());
        };

        const findEnclosingWrapper = (prefix: string, suffix: string = prefix): { from: number; contentFrom: number; contentTo: number; to: number } | null => {
            const selection = view.state.selection.main;
            const line = view.state.doc.lineAt(selection.from);
            if (selection.to > line.to) {
                return null;
            }
            const lineText = line.text;
            const relativeFrom = selection.from - line.from;
            const relativeTo = selection.to - line.from;
            let openIndex = lineText.lastIndexOf(prefix, Math.max(0, relativeFrom - 1));
            while (openIndex >= 0) {
                const contentFrom = openIndex + prefix.length;
                const closeIndex = lineText.indexOf(suffix, Math.max(contentFrom, relativeTo));
                if (closeIndex >= 0 && contentFrom <= relativeFrom && relativeTo <= closeIndex) {
                    return {
                        from: line.from + openIndex,
                        contentFrom: line.from + contentFrom,
                        contentTo: line.from + closeIndex,
                        to: line.from + closeIndex + suffix.length,
                    };
                }
                openIndex = lineText.lastIndexOf(prefix, openIndex - 1);
            }
            return null;
        };

        const findWrapperRanges = (prefix: string, suffix: string = prefix): Array<{
            from: number;
            contentFrom: number;
            contentTo: number;
            to: number;
        }> => {
            const source = view.state.doc.toString();
            const ranges: Array<{ from: number; contentFrom: number; contentTo: number; to: number }> = [];
            let open: number | null = null;
            for (let index = 0; index < source.length;) {
                if (open === null && isInlineMarkerAt(source, index, prefix)) {
                    open = index;
                    index += prefix.length;
                    continue;
                }
                if (open !== null && isInlineMarkerAt(source, index, suffix)) {
                    ranges.push({
                        from: open,
                        contentFrom: open + prefix.length,
                        contentTo: index,
                        to: index + suffix.length,
                    });
                    open = null;
                    index += suffix.length;
                    continue;
                }
                index += 1;
            }
            return ranges;
        };

        const selectionTouchesOnlyMarkedText = (prefix: string, suffix: string = prefix): boolean => {
            const selection = view.state.selection.main;
            if (selection.empty) {
                return false;
            }
            const source = view.state.doc.toString();
            const ranges = findWrapperRanges(prefix, suffix);
            let sawContent = false;

            for (let position = selection.from; position < selection.to; position += 1) {
                const char = source[position];
                if (!char || /\s/.test(char)) {
                    continue;
                }
                const isMarker = ranges.some((range) => (
                    (range.from <= position && position < range.contentFrom)
                    || (range.contentTo <= position && position < range.to)
                ));
                if (isMarker) {
                    continue;
                }
                sawContent = true;
                const isCovered = ranges.some((range) => range.contentFrom <= position && position < range.contentTo);
                if (!isCovered) {
                    return false;
                }
            }

            return sawContent;
        };

        const getBoundaryWrapperState = (prefix: string, suffix: string = prefix): { startsInside: boolean; endsInside: boolean } => {
            const selection = view.state.selection.main;
            const ranges = findWrapperRanges(prefix, suffix);
            return {
                startsInside: ranges.some((range) => range.contentFrom <= selection.from && selection.from < range.contentTo),
                endsInside: ranges.some((range) => range.contentFrom < selection.to && selection.to <= range.contentTo),
            };
        };

        const removeWrappersTouchingSelection = (prefix: string, suffix: string = prefix): boolean => {
            const selection = view.state.selection.main;
            const changes = findWrapperRanges(prefix, suffix)
                .filter((range) => range.contentTo > selection.from && range.contentFrom < selection.to)
                .flatMap((range) => [
                    { from: range.from, to: range.contentFrom, insert: '' },
                    { from: range.contentTo, to: range.to, insert: '' },
                ])
                .sort((left, right) => left.from - right.from);

            if (changes.length === 0) {
                return false;
            }

            const removedBefore = (position: number): number => changes.reduce((total, change) => (
                change.to <= position ? total + (change.to - change.from) : total
            ), 0);
            view.dispatch({
                changes,
                selection: EditorSelection.range(
                    Math.max(0, selection.from - removedBefore(selection.from)),
                    Math.max(0, selection.to - removedBefore(selection.to))
                ),
                userEvent: 'input',
            });
            view.focus();
            window.requestAnimationFrame(() => positionToolbar());
            return true;
        };

        const toggleWrapper = (prefix: string, suffix: string = prefix, placeholder = 'text'): void => {
            const selected = getSelectedText();
            const selection = view.state.selection.main;

            if (selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length >= prefix.length + suffix.length) {
                const body = selected.slice(prefix.length, selected.length - suffix.length);
                view.dispatch({
                    changes: { from: selection.from, to: selection.to, insert: body },
                    selection: EditorSelection.range(selection.from, selection.from + body.length),
                    userEvent: 'input',
                });
                view.focus();
                window.requestAnimationFrame(() => positionToolbar());
                return;
            }

            const hasSurroundingMarkers = selection.from >= prefix.length
                && view.state.doc.sliceString(selection.from - prefix.length, selection.from) === prefix
                && view.state.doc.sliceString(selection.to, selection.to + suffix.length) === suffix;
            if (hasSurroundingMarkers) {
                view.dispatch({
                    changes: [
                        { from: selection.from - prefix.length, to: selection.from, insert: '' },
                        { from: selection.to, to: selection.to + suffix.length, insert: '' },
                    ],
                    selection: EditorSelection.range(selection.from - prefix.length, selection.to - prefix.length),
                    userEvent: 'input',
                });
                view.focus();
                window.requestAnimationFrame(() => positionToolbar());
                return;
            }

            if (!selection.empty && selectionTouchesOnlyMarkedText(prefix, suffix)) {
                if (removeWrappersTouchingSelection(prefix, suffix)) {
                    return;
                }
            }

            const enclosingWrapper = findEnclosingWrapper(prefix, suffix);
            if (enclosingWrapper) {
                const cursor = selection.empty
                    ? Math.max(enclosingWrapper.from, selection.from - prefix.length)
                    : selection.from - prefix.length;
                view.dispatch({
                    changes: [
                        { from: enclosingWrapper.from, to: enclosingWrapper.contentFrom, insert: '' },
                        { from: enclosingWrapper.contentTo, to: enclosingWrapper.to, insert: '' },
                    ],
                    selection: EditorSelection.cursor(Math.max(enclosingWrapper.from, cursor)),
                    userEvent: 'input',
                });
                view.focus();
                window.requestAnimationFrame(() => positionToolbar());
                return;
            }

            if (!selection.empty) {
                const { startsInside, endsInside } = getBoundaryWrapperState(prefix, suffix);
                const body = selected;
                const insertPrefix = startsInside ? '' : prefix;
                const insertSuffix = endsInside ? '' : suffix;
                const insert = `${insertPrefix}${body}${insertSuffix}`;
                view.dispatch({
                    changes: { from: selection.from, to: selection.to, insert },
                    selection: EditorSelection.range(
                        selection.from + insertPrefix.length,
                        selection.from + insertPrefix.length + body.length
                    ),
                    userEvent: 'input',
                });
                view.focus();
                window.requestAnimationFrame(() => positionToolbar());
                return;
            }

            const body = selected || placeholder;
            insertText(`${prefix}${body}${suffix}`, prefix.length, prefix.length + body.length);
        };

        const updateSelectedLines = (mapLine: (line: string, index: number) => string): void => {
            const doc = view.state.doc;
            const selection = view.state.selection.main;
            const fromLine = doc.lineAt(selection.from);
            const toLine = doc.lineAt(selection.to);
            const changes: Array<{ from: number; to: number; insert: string }> = [];
            for (let lineNumber = fromLine.number; lineNumber <= toLine.number; lineNumber += 1) {
                const line = doc.line(lineNumber);
                const nextLine = mapLine(line.text, lineNumber - fromLine.number);
                if (nextLine !== line.text) {
                    changes.push({ from: line.from, to: line.to, insert: nextLine });
                }
            }
            if (changes.length > 0) {
                view.dispatch({ changes, userEvent: 'input' });
            }
            view.focus();
            window.requestAnimationFrame(() => positionToolbar());
        };

        const setHeadingLevel = (level: 0 | 1 | 2 | 3 | 4 | 5 | 6): void => {
            updateSelectedLines((line) => {
                const stripped = line.replace(/^\s{0,3}#{1,6}\s+/, '');
                if (level === 0) {
                    return stripped;
                }
                const existing = line.match(/^\s{0,3}(#{1,6})\s+/);
                if (existing?.[1].length === level) {
                    return stripped;
                }
                return `${'#'.repeat(level)} ${stripped || 'Heading'}`;
            });
        };

        const toggleLinePrefix = (prefix: string, pattern: RegExp): void => {
            updateSelectedLines((line) => pattern.test(line) ? line.replace(pattern, '') : `${prefix}${line || 'List item'}`);
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

        const findMarkdownLinkInLine = (line: { from: number; text: string }, relativeFrom: number, relativeTo: number = relativeFrom): MarkdownLinkRange | null => {
            for (const match of line.text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
                const start = match.index ?? 0;
                const label = match[1] ?? '';
                if (line.text[start - 1] === '!' || label.startsWith('![')) {
                    continue;
                }
                const end = start + match[0].length;
                if (start <= relativeFrom && relativeTo <= end) {
                    const href = (match[2] ?? '').trim();
                    return {
                        from: line.from + start,
                        labelFrom: line.from + start + 1,
                        labelTo: line.from + start + 1 + label.length,
                        to: line.from + end,
                        label,
                        href,
                        kind: 'markdown',
                    };
                }
            }

            for (const match of line.text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
                const start = match.index ?? 0;
                const end = start + match[0].length;
                if (start <= relativeFrom && relativeTo <= end) {
                    const body = match[1] ?? '';
                    const pipeIndex = body.lastIndexOf('|');
                    const label = pipeIndex >= 0 ? body.slice(pipeIndex + 1) : body;
                    const labelOffset = pipeIndex >= 0 ? 2 + pipeIndex + 1 : 2;
                    return {
                        from: line.from + start,
                        labelFrom: line.from + start + labelOffset,
                        labelTo: line.from + start + labelOffset + label.length,
                        to: line.from + end,
                        label,
                        href: match[0],
                        kind: 'wiki',
                    };
                }
            }

            return null;
        };

        const findMarkdownLinkAtPosition = (position: number): MarkdownLinkRange | null => {
            const safePosition = Math.max(0, Math.min(view.state.doc.length, position));
            const line = view.state.doc.lineAt(safePosition);
            const relativePosition = safePosition - line.from;
            return findMarkdownLinkInLine(line, relativePosition, relativePosition);
        };

        const findEnclosingMarkdownLink = (): MarkdownLinkRange | null => {
            const selection = view.state.selection.main;
            const line = view.state.doc.lineAt(selection.from);
            if (selection.to > line.to) {
                return null;
            }
            return findMarkdownLinkInLine(line, selection.from - line.from, selection.to - line.from);
        };

        const openLinkModalForSelection = (existingLink?: MarkdownLinkRange): void => {
            if (!linkModal) {
                return;
            }
            if (existingLink) {
                view.dispatch({ selection: EditorSelection.range(existingLink.from, existingLink.to) });
            }
            const selectedText = existingLink?.label ?? getSelectedText().trim();
            linkModal.removeAttribute('hidden');
            updateLinkMode(existingLink?.kind === 'wiki' ? 'file' : 'url');
            if (linkLabelInput) {
                linkLabelInput.value = selectedText;
            }
            if (linkInput) {
                linkInput.value = existingLink?.kind === 'markdown' ? existingLink.href : '';
            }
            if (linkAliasInput) {
                linkAliasInput.value = existingLink?.kind === 'wiki' ? existingLink.label : '';
            }
            if (linkSearchInput) {
                linkSearchInput.value = '';
            }
            if (existingLink?.kind === 'wiki') {
                linkSearchInput?.focus();
            } else if (linkInput) {
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
                const existingLink = findEnclosingMarkdownLink();
                if (existingLink) {
                    view.dispatch({
                        changes: { from: existingLink.from, to: existingLink.to, insert: `[${label}](${href})` },
                        selection: EditorSelection.range(existingLink.from + 1, existingLink.from + 1 + label.length),
                        userEvent: 'input',
                    });
                    view.focus();
                    window.requestAnimationFrame(() => positionToolbar());
                } else {
                    insertText(`[${label}](${href})`, 1, 1 + label.length);
                }
            } else if (selectedLinkItem) {
                const selectedHeadingId = linkHeadingSelect?.value?.trim();
                const selectedHeadingText = linkHeadingSelect?.selectedOptions[0]?.dataset.headingText?.trim();
                const alias = linkAliasInput?.value?.trim();
                const pathPart = selectedLinkItem.path === options.currentFilePath ? '' : selectedLinkItem.wikiPath;
                const wikiLink = `[[${pathPart}${selectedHeadingId ? `#${selectedHeadingId}` : ''}${alias ? `|${alias}` : ''}]]`;
                const label = alias || selectedHeadingText || selectedLinkItem.title;
                const existingLink = findEnclosingMarkdownLink();
                if (existingLink) {
                    view.dispatch({
                        changes: { from: existingLink.from, to: existingLink.to, insert: wikiLink },
                        selection: EditorSelection.range(existingLink.from + 2, existingLink.from + 2 + label.length),
                        userEvent: 'input',
                    });
                    view.focus();
                    window.requestAnimationFrame(() => positionToolbar());
                } else {
                    insertText(wikiLink, 2, 2 + label.length);
                }
            }
            closeLinkModal();
        };

        const handleFormatClick = (event: Event): void => {
            const target = event.currentTarget as HTMLButtonElement;
            const format = target.dataset.format;
            if (!format) {
                return;
            }
            switch (format) {
                case 'bold':
                    toggleWrapper('**', '**', 'bold text');
                    break;
                case 'italic':
                    toggleWrapper('*', '*', 'italic text');
                    break;
                case 'strike':
                    toggleWrapper('~~', '~~', 'struck text');
                    break;
                case 'quote':
                    toggleLinePrefix('> ', BLOCKQUOTE_PREFIX);
                    break;
                case 'list':
                    toggleLinePrefix('- ', UNORDERED_LIST_PREFIX);
                    break;
                case 'code':
                    toggleWrapper('`', '`', 'code');
                    break;
                case 'link':
                    {
                        const existingLink = findEnclosingMarkdownLink();
                        if (existingLink) {
                            view.dispatch({
                                changes: { from: existingLink.from, to: existingLink.to, insert: existingLink.label },
                                selection: EditorSelection.range(existingLink.from, existingLink.from + existingLink.label.length),
                                userEvent: 'input',
                            });
                            view.focus();
                            window.requestAnimationFrame(() => positionToolbar());
                            break;
                        }
                    }
                    openLinkModalForSelection();
                    break;
            }
        };

        const handleBlockStyleChange = (): void => {
            const value = blockStyleSelect?.value;
            if (!value) {
                return;
            }
            if (value === 'p') {
                setHeadingLevel(0);
                return;
            }
            const match = /^h([1-6])$/.exec(value);
            if (match) {
                const level = Number.parseInt(match[1], 10) as 1 | 2 | 3 | 4 | 5 | 6;
                setHeadingLevel(level);
            }
        };

        const handleLinkModeFileClick = (): void => updateLinkMode('file');
        const handleLinkModeUrlClick = (): void => {
            updateLinkMode('url');
            linkInput?.focus();
        };
        const handleSearchInput = (): void => { void runLinkSearch(); };
        const handleModalBackdropClick = (e: MouseEvent): void => {
            if (e.target === linkModal) {
                closeLinkModal();
            }
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

        positionToolbar = (preferredPoint?: { x: number; y: number }): void => {
            if (!contextMenu || !shell) {
                return;
            }

            const activeElement = document.activeElement;
            if (!view.hasFocus && activeElement && !shell.contains(activeElement)) {
                contextMenu.hidden = true;
                return;
            }

            const selection = view.state.selection.main;
            const fromCoords = view.coordsAtPos(selection.from);
            const toCoords = view.coordsAtPos(selection.to);
            const shellRect = (shell as HTMLElement).getBoundingClientRect();
            let clientX = preferredPoint?.x ?? fromCoords?.left ?? shellRect.left + shellRect.width / 2;
            let clientY = preferredPoint?.y ?? fromCoords?.top ?? shellRect.top + 24;

            if (!selection.empty && fromCoords && toCoords) {
                clientX = (fromCoords.left + toCoords.right) / 2;
                clientY = Math.min(fromCoords.top, toCoords.top);
            }

            contextMenu.hidden = false;
            const toolbarWidth = contextMenu.offsetWidth || 1;
            const toolbarHeight = contextMenu.offsetHeight || 1;
            const minLeft = 8;
            const maxLeft = Math.max(minLeft, shellRect.width - toolbarWidth - 8);
            const unclampedLeft = clientX - shellRect.left - toolbarWidth / 2;
            const left = Math.min(Math.max(unclampedLeft, minLeft), maxLeft);
            let top = clientY - shellRect.top - toolbarHeight - 10;
            if (top < 8) {
                top = clientY - shellRect.top + 18;
            }
            const maxTop = Math.max(8, shellRect.height - toolbarHeight - 8);
            top = Math.min(Math.max(top, 8), maxTop);
            contextMenu.style.left = `${left}px`;
            contextMenu.style.top = `${top}px`;
        };

        const hideLinkPopover = (delayMs = 180): void => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
            }
            popoverHideTimer = setTimeout(() => {
                linkPopover.hidden = true;
                activePopoverLink = null;
                popoverHideTimer = null;
            }, delayMs);
        };

        const showLinkPopover = (link: MarkdownLinkRange, clientX: number, clientY: number): void => {
            if (!shell) {
                return;
            }
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
            activePopoverLink = link;
            linkPopover.innerHTML = `
              <button class="markdown-link-popover-btn" id="link-popover-edit" type="button" title="Edit link" aria-label="Edit link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
              <button class="markdown-link-popover-btn" id="link-popover-open" type="button" title="Open link" aria-label="Open link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>
            `;
            linkPopover.hidden = false;

            // Position alongside the link rather than below it so the mouse can
            // travel from the link to the popover without crossing another line —
            // moving down would otherwise hover the next line's link and replace
            // this popover before the user can click.
            const fromCoords = view.coordsAtPos(link.labelFrom);
            const toCoords = view.coordsAtPos(link.labelTo);
            const shellRect = (shell as HTMLElement).getBoundingClientRect();
            const popoverWidth = linkPopover.offsetWidth || 1;
            const popoverHeight = linkPopover.offsetHeight || 1;
            const gap = 8;
            const linkRight = toCoords?.right ?? clientX;
            const linkLeft = fromCoords?.left ?? clientX;
            const linkTop = fromCoords?.top ?? clientY;
            const linkBottom = fromCoords?.bottom ?? clientY;
            const linkMid = (linkTop + linkBottom) / 2;
            let anchorLeft = linkRight + gap;
            if (anchorLeft + popoverWidth > shellRect.right - gap) {
                anchorLeft = linkLeft - popoverWidth - gap;
            }
            const anchorTop = linkMid - popoverHeight / 2;
            const left = Math.min(
                Math.max(anchorLeft - shellRect.left, gap),
                Math.max(gap, shellRect.width - popoverWidth - gap)
            );
            const top = Math.min(
                Math.max(anchorTop - shellRect.top, gap),
                Math.max(gap, shellRect.height - popoverHeight - gap)
            );
            linkPopover.style.left = `${left}px`;
            linkPopover.style.top = `${top}px`;
        };

        const handleLinkMouseMove = (event: MouseEvent): void => {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (typeof pos !== 'number') {
                hideLinkPopover();
                return;
            }
            const link = findMarkdownLinkAtPosition(pos);
            if (!link) {
                hideLinkPopover();
                return;
            }
            showLinkPopover(link, event.clientX, event.clientY);
        };

        const handleLinkPopoverMouseDown = (event: MouseEvent): void => {
            event.preventDefault();
        };

        const handleLinkPopoverClick = (event: MouseEvent): void => {
            const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
            if (!button || !activePopoverLink) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const link = activePopoverLink;
            linkPopover.hidden = true;
            activePopoverLink = null;

            if (button.id === 'link-popover-open') {
                void options.onOpenLink?.(link.href);
                return;
            }

            if (button.id === 'link-popover-edit') {
                openLinkModalForSelection(link);
            }
        };

        const handleEditorMouseUp = (event: MouseEvent): void => {
            positionToolbar({ x: event.clientX, y: event.clientY });
        };
        const handleEditorKeyUp = (): void => {
            positionToolbar();
        };
        const handleEditorFocusIn = (): void => {
            positionToolbar();
        };
        const handleFormatMouseDown = (event: MouseEvent): void => {
            event.preventDefault();
        };

        view.dom.addEventListener('focusout', handleFocusOut);
        view.dom.addEventListener('mousemove', handleLinkMouseMove);
        view.dom.addEventListener('mouseleave', () => hideLinkPopover());
        view.dom.addEventListener('mouseup', handleEditorMouseUp);
        view.dom.addEventListener('keyup', handleEditorKeyUp);
        view.dom.addEventListener('focusin', handleEditorFocusIn);
        const handleLinkPopoverMouseEnter = (): void => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
        };
        const handleLinkPopoverMouseLeave = (): void => hideLinkPopover();
        linkPopover.addEventListener('mousedown', handleLinkPopoverMouseDown);
        linkPopover.addEventListener('click', handleLinkPopoverClick);
        linkPopover.addEventListener('mouseenter', handleLinkPopoverMouseEnter);
        linkPopover.addEventListener('mouseleave', handleLinkPopoverMouseLeave);
        formatButtons.forEach((button) => button.addEventListener('click', handleFormatClick));
        formatButtons.forEach((button) => button.addEventListener('mousedown', handleFormatMouseDown));
        blockStyleSelect?.addEventListener('change', handleBlockStyleChange);
        linkModeFile?.addEventListener('click', handleLinkModeFileClick);
        linkModeUrl?.addEventListener('click', handleLinkModeUrlClick);
        linkSearchInput?.addEventListener('input', handleSearchInput);
        linkApply?.addEventListener('click', handleLinkApply);
        linkCancel?.addEventListener('click', closeLinkModal);
        linkModal?.addEventListener('click', handleModalBackdropClick);

        if (typeof options.initialScrollTop === 'number') {
            view.scrollDOM.scrollTop = options.initialScrollTop;
        }
        renderLinkResults();

        return {
            destroy: () => {
                view.dom.removeEventListener('focusout', handleFocusOut);
                view.dom.removeEventListener('mousemove', handleLinkMouseMove);
                view.dom.removeEventListener('mouseup', handleEditorMouseUp);
                view.dom.removeEventListener('keyup', handleEditorKeyUp);
                view.dom.removeEventListener('focusin', handleEditorFocusIn);
                linkPopover.removeEventListener('mousedown', handleLinkPopoverMouseDown);
                linkPopover.removeEventListener('click', handleLinkPopoverClick);
                linkPopover.removeEventListener('mouseenter', handleLinkPopoverMouseEnter);
                linkPopover.removeEventListener('mouseleave', handleLinkPopoverMouseLeave);
                formatButtons.forEach((button) => button.removeEventListener('click', handleFormatClick));
                formatButtons.forEach((button) => button.removeEventListener('mousedown', handleFormatMouseDown));
                blockStyleSelect?.removeEventListener('change', handleBlockStyleChange);
                linkModeFile?.removeEventListener('click', handleLinkModeFileClick);
                linkModeUrl?.removeEventListener('click', handleLinkModeUrlClick);
                linkSearchInput?.removeEventListener('input', handleSearchInput);
                linkApply?.removeEventListener('click', handleLinkApply);
                linkCancel?.removeEventListener('click', closeLinkModal);
                linkModal?.removeEventListener('click', handleModalBackdropClick);
                if (popoverHideTimer) { clearTimeout(popoverHideTimer); }
                linkPopover.remove();
                view.destroy();
                options.target.replaceChildren();
            },
            focus: () => {
                view.focus();
            },
            getValue,
            setValue: (value: string) => {
                suppressChange = true;
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
                suppressChange = false;
            },
            revealLine: (lineNumber: number) => {
                const targetLine = Math.max(1, Math.min(view.state.doc.lines, Math.floor(lineNumber)));
                const line = view.state.doc.line(targetLine);
                view.dispatch({
                    selection: EditorSelection.cursor(line.from),
                    effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 48 }),
                });
                view.focus();
            },
            setScrollTop: (scrollTop: number) => {
                view.scrollDOM.scrollTop = Math.max(0, scrollTop);
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
