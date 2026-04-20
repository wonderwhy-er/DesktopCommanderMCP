import { escapeHtml } from './components/highlighting.js';
import type { RenderBodyResult, RenderPayload } from './model.js';
import { buildRenderPayload, extractToolText } from './payload-utils.js';

interface DirEntry {
    name: string;
    isDir: boolean;
    isDenied: boolean;
    isWarning: boolean;
    warningText: string;
    children: DirEntry[];
    relativePath: string;
}

function parseDirectoryEntries(content: string): { hint: string; entries: DirEntry[] } {
    const lines = content.split('\n');
    const hintLines: string[] = [];
    const entryLines: string[] = [];
    for (const line of lines) {
        if (/^\[(DIR|FILE|DENIED|WARNING)\]/.test(line.trim())) {
            entryLines.push(line.trim());
        } else if (entryLines.length === 0) {
            hintLines.push(line);
        }
    }

    const flat: Array<{
        name: string;
        fullPath: string;
        isDir: boolean;
        isDenied: boolean;
        isWarning: boolean;
        warningText: string;
        depth: number;
    }> = [];
    for (const line of entryLines) {
        if (line.startsWith('[WARNING]')) {
            const warnBody = line.replace(/^\[WARNING\]\s*/, '');
            const colonIdx = warnBody.indexOf(':');
            const dirName = colonIdx >= 0 ? warnBody.slice(0, colonIdx).trim() : '';
            const msg = colonIdx >= 0 ? warnBody.slice(colonIdx + 1).trim() : warnBody;
            const parts = dirName.replace(/\\/g, '/').split('/').filter(Boolean);
            flat.push({
                name: dirName,
                fullPath: dirName,
                isDir: false,
                isDenied: false,
                isWarning: true,
                warningText: msg,
                depth: parts.length,
            });
            continue;
        }

        const isDir = line.startsWith('[DIR]');
        const isDenied = line.startsWith('[DENIED]');
        const name = line.replace(/^\[(DIR|FILE|DENIED)\]\s*/, '');
        const parts = name.replace(/\\/g, '/').split('/');
        flat.push({
            name,
            fullPath: name,
            isDir,
            isDenied,
            isWarning: false,
            warningText: '',
            depth: parts.length - 1,
        });
    }

    const root: DirEntry[] = [];
    const stack: DirEntry[][] = [root];

    for (const item of flat) {
        const baseName = item.fullPath.replace(/\\/g, '/').split('/').pop() ?? item.fullPath;
        const entry: DirEntry = {
            name: baseName,
            isDir: item.isDir,
            isDenied: item.isDenied,
            isWarning: item.isWarning,
            warningText: item.warningText,
            children: [],
            relativePath: item.fullPath,
        };

        while (stack.length > item.depth + 1) {
            stack.pop();
        }

        const parent = stack[stack.length - 1];
        parent.push(entry);

        if (item.isDir) {
            stack.push(entry.children);
        }
    }

    return { hint: hintLines.join('\n').trim(), entries: root };
}

let dirEntryIdCounter = 0;

function renderDirTree(entries: DirEntry[], rootPath: string): string {
    if (entries.length === 0) {
        return '<div class="dir-tree"><span class="dir-empty">Empty directory</span></div>';
    }

    function renderEntries(items: DirEntry[]): string {
        return items.map((item) => {
            const id = `de-${dirEntryIdCounter++}`;
            const fullPath = `${rootPath}/${item.relativePath.replace(/\\/g, '/')}`;
            const escapedPath = escapeHtml(fullPath);

            if (item.isWarning) {
                return `<div class="dir-entry"><button class="dir-row dir-row-warning dir-load-more" data-loadpath="${escapedPath}"><span class="dir-warning-icon">⚠️</span> <span class="dir-warning-text">${escapeHtml(item.warningText)} — click to load all</span></button></div>`;
            }
            if (item.isDenied) {
                return `<div class="dir-entry"><span class="dir-icon">🚫</span> <span class="dir-name-denied">${escapeHtml(item.name)}</span></div>`;
            }
            if (item.isDir) {
                const hasChildren = item.children.length > 0;
                const chevron = `<span class="dir-chevron${hasChildren ? ' expanded' : ''}">${hasChildren ? '▼' : '▶'}</span>`;
                const openButton = `<button class="dir-open-btn" data-openpath="${escapedPath}" title="Open in Finder">📂</button>`;
                const childrenHtml = hasChildren ? `<div class="dir-children" id="${id}-ch">${renderEntries(item.children)}</div>` : '';
                return `<div class="dir-entry-group" id="${id}"><div class="dir-row dir-row-folder" data-path="${escapedPath}" data-eid="${id}" data-loaded="${hasChildren}">${chevron} <span class="dir-icon">📁</span> <span class="dir-name">${escapeHtml(item.name)}</span>${openButton}</div>${childrenHtml}</div>`;
            }

            return `<div class="dir-entry"><div class="dir-row dir-row-file" data-path="${escapedPath}"><span class="file-icon">📄</span> <span class="file-name">${escapeHtml(item.name)}</span></div></div>`;
        }).join('');
    }

    return `<div class="dir-tree">${renderEntries(entries)}</div>`;
}

export function renderDirectoryBody(content: string, rootPath: string): RenderBodyResult {
    dirEntryIdCounter = 0;
    const { hint, entries } = parseDirectoryEntries(content);
    return {
        notice: hint || undefined,
        html: `<div class="panel-content directory-content">${renderDirTree(entries, rootPath)}</div>`,
    };
}

export function attachDirectoryHandlers(options: {
    container: HTMLElement;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    buildOpenInFolderCommand: (filePath: string) => string | undefined;
    onOpenPayload: (payload: RenderPayload) => void;
}): void {
    const tree = options.container.querySelector('.dir-tree');
    if (!tree) {
        return;
    }

    tree.addEventListener('click', async (event) => {
        const openBtn = (event.target as HTMLElement).closest('.dir-open-btn') as HTMLElement | null;
        if (openBtn) {
            event.stopPropagation();
            const openPath = openBtn.dataset.openpath;
            if (!openPath) {
                return;
            }
            const command = options.buildOpenInFolderCommand(openPath);
            if (command) {
                try {
                    await options.callTool?.('start_process', { command, timeout_ms: 12000 });
                } catch {
                    // Keep UI stable if opening folder fails.
                }
            }
            return;
        }

        const loadMoreBtn = (event.target as HTMLElement).closest('.dir-load-more') as HTMLElement | null;
        if (loadMoreBtn) {
            event.stopPropagation();
            const loadPath = loadMoreBtn.dataset.loadpath;
            if (!loadPath) {
                return;
            }
            loadMoreBtn.querySelector('.dir-warning-text')!.textContent = 'Loading…';
            (loadMoreBtn as HTMLButtonElement).disabled = true;
            try {
                const result = await options.callTool?.('list_directory', { path: loadPath, depth: 1 });
                const text = extractToolText(result) ?? '';
                if (text) {
                    const parsed = parseDirectoryEntries(text);
                    const html = renderDirTree(parsed.entries, loadPath);
                    const parentChildren = loadMoreBtn.closest('.dir-children');
                    if (parentChildren) {
                        const temp = document.createElement('div');
                        temp.innerHTML = html;
                        const inner = temp.querySelector('.dir-tree');
                        parentChildren.innerHTML = inner ? inner.innerHTML : '';
                    }
                }
            } catch {
                loadMoreBtn.querySelector('.dir-warning-text')!.textContent = 'Failed to load';
                (loadMoreBtn as HTMLButtonElement).disabled = false;
            }
            return;
        }

        const target = (event.target as HTMLElement).closest('.dir-row') as HTMLElement | null;
        if (!target) {
            return;
        }
        const fullPath = target.dataset.path;
        if (!fullPath) {
            return;
        }

        if (target.classList.contains('dir-row-folder')) {
            const entryId = target.dataset.eid;
            if (!entryId) {
                return;
            }
            const childrenEl = document.getElementById(`${entryId}-ch`);
            const chevron = target.querySelector('.dir-chevron');

            if (childrenEl) {
                const hidden = childrenEl.classList.toggle('dir-collapsed');
                chevron?.classList.toggle('expanded', !hidden);
                if (chevron) chevron.textContent = hidden ? '▶' : '▼';
                return;
            }

            if (target.dataset.loaded === 'true') {
                return;
            }
            if (chevron) chevron.textContent = '⏳';
            try {
                const result = await options.callTool?.('list_directory', { path: fullPath, depth: 2 });
                const text = extractToolText(result) ?? '';
                if (text) {
                    target.dataset.loaded = 'true';
                    const parsed = parseDirectoryEntries(text);
                    const html = renderDirTree(parsed.entries, fullPath);
                    const wrapper = document.createElement('div');
                    wrapper.className = 'dir-children';
                    wrapper.id = `${entryId}-ch`;
                    const temp = document.createElement('div');
                    temp.innerHTML = html;
                    const inner = temp.querySelector('.dir-tree');
                    wrapper.innerHTML = inner ? inner.innerHTML : '<span class="dir-empty">Empty</span>';
                    target.parentElement?.appendChild(wrapper);
                    chevron?.classList.add('expanded');
                    if (chevron) chevron.textContent = '▼';
                }
            } catch {
                if (chevron) chevron.textContent = '⚠';
            }
            return;
        }

        if (target.classList.contains('dir-row-file')) {
            target.classList.add('dir-loading');
            try {
                const result = await options.callTool?.('read_file', { path: fullPath });
                if (!result || typeof result !== 'object' || result === null) {
                    return;
                }
                const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
                if (structuredContent && typeof structuredContent === 'object') {
                    const text = extractToolText(result) ?? '';
                    options.onOpenPayload(buildRenderPayload(structuredContent as any, text));
                }
            } catch {
                target.classList.remove('dir-loading');
            }
        }
    });
}
