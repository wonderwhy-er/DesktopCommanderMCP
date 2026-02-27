import { escapeHtml } from '../../shared/escape-html.js';

export interface ArrayModalEntry {
    key: string;
    label?: string;
    description?: string;
    value: unknown;
}

interface CreateArrayModalControllerOptions {
    container: HTMLElement;
    parseEntryItems: (entry: ArrayModalEntry) => string[];
    formatEntryTitle: (entry: ArrayModalEntry) => string;
    onSave: (entryKey: string, items: string[]) => void | Promise<void>;
}

export interface ArrayModalController {
    open: (entry: ArrayModalEntry) => void;
    close: () => void;
}

export function renderArrayModalMarkup(initialTitle: string): string {
    return `
        <div class="array-modal" id="array-modal" hidden>
          <div class="array-modal-card">
            <header>
              <h3 id="array-modal-title">${escapeHtml(initialTitle)}</h3>
              <div class="array-modal-actions">
                <button type="button" id="array-modal-save" aria-label="Save list changes">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 13l4 4L19 7"></path></svg>
                </button>
                <button type="button" id="array-modal-close" aria-label="Close list editor">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17"></path></svg>
                </button>
              </div>
            </header>
            <p class="array-modal-description" id="array-modal-description"></p>
            <p class="array-modal-hint">Type an item, then press Enter (or click away) to add it. A new empty row appears automatically.</p>
            <div class="array-modal-list" id="array-modal-list"></div>
          </div>
        </div>
    `;
}

export function createArrayModalController(options: CreateArrayModalControllerOptions): ArrayModalController {
    const { container, parseEntryItems, formatEntryTitle, onSave } = options;

    const modal = container.querySelector('#array-modal') as HTMLElement | null;
    const modalList = container.querySelector('#array-modal-list') as HTMLElement | null;
    const modalTitleElement = container.querySelector('#array-modal-title') as HTMLElement | null;
    const modalDescriptionElement = container.querySelector('#array-modal-description') as HTMLElement | null;
    const modalClose = container.querySelector('#array-modal-close') as HTMLButtonElement | null;
    const modalSave = container.querySelector('#array-modal-save') as HTMLButtonElement | null;

    let modalEntryKey: string | null = null;
    let modalItems: string[] = [];

    const collectModalItemsFromDom = (): string[] => {
        if (!modalList) {
            return [...modalItems];
        }

        const existing = Array.from(modalList.querySelectorAll('.array-modal-item-input'))
            .map((input) => (input as HTMLInputElement).value.trim())
            .filter((value) => value.length > 0);

        const newInput = modalList.querySelector('#array-modal-new-item') as HTMLInputElement | null;
        const newValue = newInput?.value.trim() ?? '';

        if (newValue.length > 0) {
            return [newValue, ...existing];
        }

        return existing;
    };

    const renderModalList = (): void => {
        if (!modalList) {
            return;
        }

        modalList.innerHTML = `
          <div class="array-modal-row array-modal-row--new">
            <input id="array-modal-new-item" type="text" placeholder="Add item" aria-label="Add new item" />
          </div>
          ${modalItems.map((item, index) => `
            <div class="array-modal-row" data-modal-index="${index}">
              <input class="array-modal-item-input" type="text" value="${escapeHtml(item)}" aria-label="Item ${index + 1}" />
              <button type="button" class="array-modal-item-remove" aria-label="Remove item ${index + 1}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7"></path></svg>
              </button>
            </div>
          `).join('')}
        `;

        const addModalItem = (value: string): void => {
            const normalized = value.trim();
            if (!normalized) {
                return;
            }
            const exists = modalItems.some((item) => item.trim() === normalized);
            if (!exists) {
                modalItems.unshift(normalized);
            }
            renderModalList();
        };

        const newInput = modalList.querySelector('#array-modal-new-item') as HTMLInputElement | null;
        newInput?.addEventListener('blur', () => {
            const value = newInput.value.trim();
            if (!value) {
                return;
            }
            addModalItem(value);
            const refreshedNewInput = modalList.querySelector('#array-modal-new-item') as HTMLInputElement | null;
            refreshedNewInput?.focus();
        });
        newInput?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') {
                return;
            }
            event.preventDefault();
            const value = newInput.value.trim();
            if (!value) {
                return;
            }
            addModalItem(value);
            const refreshedNewInput = modalList.querySelector('#array-modal-new-item') as HTMLInputElement | null;
            refreshedNewInput?.focus();
        });

        modalList.querySelectorAll('.array-modal-row[data-modal-index]').forEach((rowElement) => {
            const row = rowElement as HTMLElement;
            const index = Number(row.dataset.modalIndex);
            const input = row.querySelector('.array-modal-item-input') as HTMLInputElement | null;
            const removeButton = row.querySelector('.array-modal-item-remove') as HTMLButtonElement | null;

            input?.addEventListener('blur', () => {
                modalItems[index] = input.value.trim();
                modalItems = modalItems.filter((item) => item.length > 0);
                renderModalList();
            });

            removeButton?.addEventListener('click', () => {
                modalItems = modalItems.filter((_, itemIndex) => itemIndex !== index);
                renderModalList();
            });
        });
    };

    const close = (): void => {
        if (modal) {
            modal.hidden = true;
        }
        modalEntryKey = null;
    };

    const open = (entry: ArrayModalEntry): void => {
        modalEntryKey = entry.key;
        modalItems = parseEntryItems(entry);

        if (modalTitleElement) {
            modalTitleElement.textContent = formatEntryTitle(entry);
        }
        if (modalDescriptionElement) {
            modalDescriptionElement.textContent = entry.description ?? '';
            modalDescriptionElement.classList.toggle('hidden', !modalDescriptionElement.textContent.trim());
        }

        renderModalList();
        if (modal) {
            modal.hidden = false;
        }
    };

    modalClose?.addEventListener('click', close);
    modal?.addEventListener('click', (event) => {
        if (event.target === modal) {
            close();
        }
    });
    modalSave?.addEventListener('click', async () => {
        if (!modalEntryKey) {
            return;
        }
        const changedKey = modalEntryKey;
        modalItems = collectModalItemsFromDom();
        try {
            await onSave(changedKey, modalItems);
        } finally {
            close();
        }
    });

    return { open, close };
}
