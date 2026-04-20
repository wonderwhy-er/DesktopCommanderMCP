import { escapeHtml } from '../../shared/escape-html.js';

export interface DocumentOutlineItem {
    id: string;
    text: string;
    level: number;
    line?: number;
}

export interface DocumentOutlineHandle {
    dispose: () => void;
    refresh: (outline: DocumentOutlineItem[], activeHeadingId?: string | null) => void;
}

function setActiveItem(nav: HTMLElement, activeId: string | null): void {
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('[data-toc-id]'));
    buttons.forEach((button) => {
        const isActive = button.dataset.tocId === activeId;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-current', isActive ? 'location' : 'false');
    });
}

function renderDocumentOutlineItems(outline: DocumentOutlineItem[], activeHeadingId?: string | null): string {
    return outline.map((item) => {
        const activeClass = item.id === activeHeadingId ? ' is-active' : '';
        return `<button class="document-outline-link markdown-toc-link${activeClass}" type="button" data-toc-id="${escapeHtml(item.id)}" data-level="${item.level}" aria-current="${item.id === activeHeadingId ? 'location' : 'false'}">${escapeHtml(item.text)}</button>`;
    }).join('');
}

function renderCollapseIcon(): string {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
}

function renderExpandIcon(): string {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
}

export function renderDocumentOutline(outline: DocumentOutlineItem[], activeHeadingId?: string | null): string {
    if (outline.length === 0) {
        return '';
    }

    return `
      <aside class="document-outline-shell markdown-toc-shell" aria-label="Table of contents">
        <div class="document-outline-header markdown-toc-header">
          <span class="document-outline-title markdown-toc-title">Contents</span>
          <button class="document-outline-toggle" id="toc-toggle" type="button" title="Collapse sidebar" aria-label="Collapse sidebar">${renderCollapseIcon()}</button>
        </div>
        <nav class="document-outline-nav markdown-toc-nav">${renderDocumentOutlineItems(outline, activeHeadingId)}</nav>
      </aside>
    `;
}

export function attachDocumentOutline(options: {
    shell: HTMLElement;
    outline: DocumentOutlineItem[];
    scrollContainer: HTMLElement;
    onSelect: (headingId: string) => void;
}): DocumentOutlineHandle | null {
    const nav = options.shell.querySelector('.document-outline-nav') as HTMLElement | null;
    if (!nav) {
        return null;
    }
    let currentOutline = options.outline;

    const handleClick = (event: Event): void => {
        const target = event.target as HTMLElement | null;
        const button = target?.closest<HTMLButtonElement>('[data-toc-id]');
        const headingId = button?.dataset.tocId;
        if (!headingId) {
            return;
        }

        options.onSelect(headingId);
        setActiveItem(nav, headingId);
    };

    const updateActiveHeading = (): void => {
        const headings = currentOutline
            .map((item) => {
                const element = document.getElementById(item.id);
                return element ? { item, element } : null;
            })
            .filter((entry): entry is { item: DocumentOutlineItem; element: HTMLElement } => entry !== null);

        if (headings.length === 0) {
            return;
        }

        const scrollTop = options.scrollContainer.scrollTop;
        const nextActive = headings.reduce<string | null>((activeId, current) => {
            if (current.element.offsetTop - scrollTop <= 96) {
                return current.item.id;
            }
            return activeId;
        }, headings[0].item.id);

        setActiveItem(nav, nextActive);
    };

    const toggleButton = options.shell.querySelector('#toc-toggle') as HTMLButtonElement | null;
    const handleToggle = (): void => {
        const isCollapsed = options.shell.classList.toggle('markdown-toc-collapsed');
        if (toggleButton) {
            toggleButton.innerHTML = isCollapsed ? renderExpandIcon() : renderCollapseIcon();
            toggleButton.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
            toggleButton.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
        }
    };
    toggleButton?.addEventListener('click', handleToggle);

    nav.addEventListener('click', handleClick);
    options.scrollContainer.addEventListener('scroll', updateActiveHeading, { passive: true });
    updateActiveHeading();

    return {
        dispose: () => {
            nav.removeEventListener('click', handleClick);
            options.scrollContainer.removeEventListener('scroll', updateActiveHeading);
            toggleButton?.removeEventListener('click', handleToggle);
        },
        refresh: (outline, activeHeadingId) => {
            currentOutline = outline;
            nav.innerHTML = renderDocumentOutlineItems(currentOutline, activeHeadingId);
            setActiveItem(nav, activeHeadingId ?? null);
            updateActiveHeading();
        },
    };
}
