import type { MarkdownOutlineItem } from './outline.js';

export interface MarkdownTocHandle {
    dispose: () => void;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setActiveItem(nav: HTMLElement, activeId: string | null): void {
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('[data-toc-id]'));
    buttons.forEach((button) => {
        const isActive = button.dataset.tocId === activeId;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-current', isActive ? 'location' : 'false');
    });
}

export function renderMarkdownToc(outline: MarkdownOutlineItem[], activeHeadingId?: string | null): string {
    if (outline.length === 0) {
        return '';
    }

    const items = outline.map((item) => {
        const activeClass = item.id === activeHeadingId ? ' is-active' : '';
        return `<button class="markdown-toc-link${activeClass}" type="button" data-toc-id="${escapeHtml(item.id)}" data-level="${item.level}" aria-current="${item.id === activeHeadingId ? 'location' : 'false'}">${escapeHtml(item.text)}</button>`;
    }).join('');

    return `
      <aside class="markdown-toc-shell" aria-label="Table of contents">
        <div class="markdown-toc-title">Contents</div>
        <nav class="markdown-toc-nav">${items}</nav>
      </aside>
    `;
}

export function attachMarkdownToc(options: {
    shell: HTMLElement;
    outline: MarkdownOutlineItem[];
    scrollContainer: HTMLElement;
    onSelect: (headingId: string) => void;
}): MarkdownTocHandle | null {
    const nav = options.shell.querySelector('.markdown-toc-nav') as HTMLElement | null;
    if (!nav) {
        return null;
    }

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
        const headings = options.outline
            .map((item) => {
                const element = document.getElementById(item.id);
                return element ? { item, element } : null;
            })
            .filter((entry): entry is { item: MarkdownOutlineItem; element: HTMLElement } => entry !== null);

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

    nav.addEventListener('click', handleClick);
    options.scrollContainer.addEventListener('scroll', updateActiveHeading, { passive: true });
    updateActiveHeading();

    return {
        dispose: () => {
            nav.removeEventListener('click', handleClick);
            options.scrollContainer.removeEventListener('scroll', updateActiveHeading);
        },
    };
}
