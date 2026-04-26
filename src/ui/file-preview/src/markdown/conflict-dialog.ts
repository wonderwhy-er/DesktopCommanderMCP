/**
 * The "file changed on disk" conflict resolver.
 *
 * Shown when saveDocument detected that disk differs from what the editor
 * thought it had. The editor has already re-synced its disk baseline to the
 * fresh disk content with keepDraft: true — so the dialog's two actions map
 * onto concrete state transitions:
 *
 *   "Use disk version"   — replace the draft with disk content
 *                          (syncStateFromContent without keepDraft).
 *                          Destroys unsaved edits.
 *
 *   "Save my changes"    — close the dialog and re-run saveDocument.
 *                          computeEditBlocks will now diff against the fresh
 *                          disk content, so non-overlapping edits merge in
 *                          and overlapping edits win over disk for the
 *                          lines the user actually touched.
 *
 * The dialog is modal (dimmed backdrop, keyboard-trapped, click-outside does
 * not dismiss). Escape and the ✕ button both close it without taking either
 * action — equivalent to "I'll deal with this later"; the save button stays
 * dirty so the user can retry or keep editing.
 */

export interface OpenConflictDialogOptions {
    fileName: string;
    onUseDiskVersion: () => void;
    onSaveMyChanges: () => void;
    onCancel?: () => void;
}

export interface ConflictDialogController {
    open: (options: OpenConflictDialogOptions) => void;
    close: () => void;
    isOpen: () => boolean;
}

export function renderConflictDialogMarkup(): string {
    return `
        <div class="md-conflict-modal" id="md-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="md-conflict-title" aria-describedby="md-conflict-body" hidden>
          <div class="md-conflict-card">
            <header class="md-conflict-header">
              <h3 id="md-conflict-title">⚠ This file changed on disk</h3>
              <button type="button" class="md-conflict-close" id="md-conflict-close" aria-label="Close">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </button>
            </header>
            <div class="md-conflict-body" id="md-conflict-body">
              <p>
                Something else modified
                <strong class="md-conflict-filename" id="md-conflict-filename"></strong>
                while you were editing. Your unsaved edits are preserved.
              </p>
              <p>If you save now:</p>
              <ul>
                <li>Changes you made to lines the external edit didn't touch will be saved alongside the external changes.</li>
                <li>Changes you made to lines that also changed externally will overwrite the external version on those lines.</li>
              </ul>
            </div>
            <footer class="md-conflict-footer">
              <button type="button" class="md-conflict-btn md-conflict-btn--secondary" id="md-conflict-use-disk">
                Use disk version
              </button>
              <button type="button" class="md-conflict-btn md-conflict-btn--primary" id="md-conflict-save-mine">
                Save my changes
              </button>
            </footer>
          </div>
        </div>
    `;
}

interface CreateConflictDialogOptions {
    container: ParentNode;
}

export function createConflictDialogController(options: CreateConflictDialogOptions): ConflictDialogController {
    const { container } = options;

    const modal = container.querySelector('#md-conflict-modal') as HTMLElement | null;
    const filenameEl = container.querySelector('#md-conflict-filename') as HTMLElement | null;
    const useDiskBtn = container.querySelector('#md-conflict-use-disk') as HTMLButtonElement | null;
    const saveMineBtn = container.querySelector('#md-conflict-save-mine') as HTMLButtonElement | null;
    const closeBtn = container.querySelector('#md-conflict-close') as HTMLButtonElement | null;

    let currentOptions: OpenConflictDialogOptions | null = null;
    let previousActiveElement: HTMLElement | null = null;

    const close = (): void => {
        if (!modal || modal.hidden) {
            return;
        }
        modal.hidden = true;
        document.removeEventListener('keydown', handleKeyDown, true);
        modal.removeEventListener('click', handleBackdropClick);
        const cancel = currentOptions?.onCancel;
        currentOptions = null;
        // Restore focus to whatever the user was on before the dialog opened.
        if (previousActiveElement && document.contains(previousActiveElement)) {
            try {
                previousActiveElement.focus();
            } catch {
                /* focus can throw on removed nodes — ignore */
            }
        }
        previousActiveElement = null;
        cancel?.();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
        if (!modal || modal.hidden) {
            return;
        }
        if (event.key === 'Escape') {
            event.stopPropagation();
            event.preventDefault();
            close();
            return;
        }
        if (event.key === 'Tab') {
            // Minimal focus trap between the three buttons.
            const focusable = [useDiskBtn, saveMineBtn, closeBtn].filter(
                (el): el is HTMLButtonElement => !!el
            );
            if (focusable.length === 0) return;
            const active = document.activeElement as HTMLElement | null;
            const currentIndex = active ? focusable.indexOf(active as HTMLButtonElement) : -1;
            const direction = event.shiftKey ? -1 : 1;
            const nextIndex = currentIndex === -1
                ? (direction === 1 ? 0 : focusable.length - 1)
                : (currentIndex + direction + focusable.length) % focusable.length;
            event.preventDefault();
            focusable[nextIndex].focus();
        }
    };

    const handleBackdropClick = (event: MouseEvent): void => {
        // Click on the dimmed backdrop (the modal element itself, not the card)
        // is deliberately not a dismiss — the user must make a choice or hit ✕.
        if (event.target === modal) {
            event.stopPropagation();
        }
    };

    const handleUseDisk = (): void => {
        const cb = currentOptions?.onUseDiskVersion;
        // Clear currentOptions first so close() doesn't also fire onCancel.
        currentOptions = null;
        close();
        cb?.();
    };

    const handleSaveMine = (): void => {
        const cb = currentOptions?.onSaveMyChanges;
        currentOptions = null;
        close();
        cb?.();
    };

    useDiskBtn?.addEventListener('click', handleUseDisk);
    saveMineBtn?.addEventListener('click', handleSaveMine);
    closeBtn?.addEventListener('click', close);

    return {
        open: (options) => {
            if (!modal) {
                // No-op if the markup wasn't injected — fall back to cancel callback
                // so the editor can still notify the user via the inline path.
                options.onCancel?.();
                return;
            }
            currentOptions = options;
            if (filenameEl) {
                filenameEl.textContent = options.fileName;
            }
            previousActiveElement = (document.activeElement as HTMLElement | null) ?? null;
            modal.hidden = false;
            document.addEventListener('keydown', handleKeyDown, true);
            modal.addEventListener('click', handleBackdropClick);
            // Default focus goes to the safer action ("Save my changes" is the
            // non-destructive intent — it doesn't discard the user's draft).
            window.requestAnimationFrame(() => {
                saveMineBtn?.focus();
            });
        },
        close,
        isOpen: () => !!modal && !modal.hidden,
    };
}
