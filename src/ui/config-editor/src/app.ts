import { App } from '@modelcontextprotocol/ext-apps';
import { createToolBridge } from '../../shared/tool-bridge.js';
import { createCompactRowShellController, type ToolShellController } from '../../shared/tool-shell.js';
import { renderCompactRow } from '../../shared/compact-row.js';
import { escapeHtml } from '../../shared/escape-html.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { connectWithSharedHostContext, isObjectRecord, type UiChromeState } from '../../shared/host-context.js';
import { createArrayModalController, renderArrayModalMarkup } from './array-modal.js';
import { CONFIG_FIELD_DEFINITIONS, isConfigFieldKey } from '../../../config-field-definitions.js';

export interface ConfigEntry {
    key: string;
    label?: string;
    description?: string;
    value: unknown;
    valueType: 'string' | 'number' | 'boolean' | 'array' | 'null' | string;
    editable: boolean;
}

export interface ConfigEditorPayload {
    config?: Record<string, unknown>;
    uiHints?: {
        availableShells?: string[];
    };
    entries: ConfigEntry[];
}

export interface ConfigEditorState {
    payload: ConfigEditorPayload | null;
    selectedKey: string | null;
    draftValue: string;
}

export type TooltipTone = 'info' | 'error' | 'success';

export interface TooltipMessage {
    message: string;
    tone: TooltipTone;
}

export interface ApplyConfigResult {
    ok: boolean;
    tooltip?: TooltipMessage;
}

interface RenderHooks {
    onConfigChanged?: (change: { key: string; value: unknown }) => void;
    onTooltip?: (tooltip: TooltipMessage) => void;
}

type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

let shellController: ToolShellController | undefined;

function isConfigEditorPayload(value: unknown): value is ConfigEditorPayload {
    return isObjectRecord(value) && Array.isArray((value as Record<string, unknown>).entries);
}

function stringifyValueForInput(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map((item) => String(item)).join('\n');
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (value === null) {
        return 'null';
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatKeyLabel(key: string): string {
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function getConfigFieldMetadata(key: string): { label: string; description: string } | undefined {
    if (!isConfigFieldKey(key)) {
        return undefined;
    }
    return {
        label: CONFIG_FIELD_DEFINITIONS[key].label,
        description: CONFIG_FIELD_DEFINITIONS[key].description,
    };
}

function extractPayload(result: unknown): ConfigEditorPayload | null {
    if (!isObjectRecord(result)) {
        return null;
    }
    const structured = result.structuredContent;
    if (!isObjectRecord(structured) || !Array.isArray(structured.entries)) {
        return null;
    }

    const entries: ConfigEntry[] = structured.entries
        .filter((entry): entry is Record<string, unknown> => isObjectRecord(entry))
        .filter((entry) => typeof entry.key === 'string')
        .map((entry) => {
            const key = entry.key as string;
            const metadata = getConfigFieldMetadata(key);
            return {
                key,
                label: metadata?.label,
                description: metadata?.description,
                value: entry.value,
                valueType: typeof entry.valueType === 'string' ? entry.valueType : 'string',
                editable: entry.editable !== false,
            };
        });

    return {
        config: isObjectRecord(structured.config) ? structured.config : undefined,
        uiHints: isObjectRecord(structured.uiHints)
            ? {
                availableShells: Array.isArray(structured.uiHints.availableShells)
                    ? structured.uiHints.availableShells.filter((value): value is string => typeof value === 'string')
                    : undefined,
            }
            : undefined,
        entries,
    };
}

function extractToolText(result: unknown): string | undefined {
    if (!isObjectRecord(result) || !Array.isArray(result.content)) {
        return undefined;
    }

    for (const item of result.content) {
        if (!isObjectRecord(item)) {
            continue;
        }
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
            return item.text;
        }
    }

    return undefined;
}

function isToolErrorResult(result: unknown): boolean {
    return isObjectRecord(result) && result.isError === true;
}

function parseDraftValue(rawValue: string, valueType: string): { ok: true; value: unknown } | { ok: false; message: string } {
    if (valueType === 'string') {
        return { ok: true, value: rawValue.replace(/\r?\n/g, ' ') };
    }

    if (valueType === 'number') {
        const numeric = Number(rawValue);
        if (!Number.isFinite(numeric)) {
            return { ok: false, message: 'Enter a valid number.' };
        }
        return { ok: true, value: numeric };
    }

    if (valueType === 'boolean') {
        const normalized = rawValue.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            return { ok: false, message: 'Boolean values must be true or false.' };
        }
        return { ok: true, value: normalized === 'true' };
    }

    if (valueType === 'null') {
        if (rawValue.trim().toLowerCase() !== 'null') {
            return { ok: false, message: 'Null values must be exactly null.' };
        }
        return { ok: true, value: null };
    }

    if (valueType === 'array') {
        const trimmed = rawValue.trim();
        if (trimmed.length === 0) {
            return { ok: true, value: [] };
        }

        if (!trimmed.startsWith('[')) {
            const items = rawValue
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
            return { ok: true, value: items };
        }

        try {
            const parsed = JSON.parse(trimmed);
            if (!Array.isArray(parsed)) {
                return { ok: false, message: 'Array values must be valid JSON arrays.' };
            }
            if (!parsed.every((item) => typeof item === 'string')) {
                return { ok: false, message: 'Array values must contain only strings.' };
            }
            return { ok: true, value: parsed };
        } catch {
            return { ok: false, message: 'Array values must be valid JSON arrays.' };
        }
    }

    return { ok: true, value: rawValue };
}

function areConfigValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) {
            return false;
        }

        for (let index = 0; index < left.length; index += 1) {
            if (!Object.is(left[index], right[index])) {
                return false;
            }
        }

        return true;
    }

    return false;
}

function parseDraftArrayValues(draft: string): string[] {
    const trimmed = draft.trim();
    if (!trimmed) {
        return [];
    }
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.filter((item) => typeof item === 'string') as string[];
            }
        } catch {
            // fallback below
        }
    }
    return draft
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function getSettingSummary(entry: ConfigEntry): string | null {
    if (entry.key !== 'blockedCommands' && entry.key !== 'allowedDirectories') {
        return null;
    }

    const values = Array.isArray(entry.value)
        ? entry.value.filter((item) => typeof item === 'string' && item.trim().length > 0)
        : [];

    const count = values.length;
    if (entry.key === 'blockedCommands') {
        return `${count} command${count === 1 ? '' : 's'} blocked`;
    }

    if (count === 0) {
        return 'All folders allowed (no restriction)';
    }

    return `${count} folder${count === 1 ? '' : 's'} allowed`;
}

function getShellOptions(payload: ConfigEditorPayload | null, currentShell: string): string[] {
    const hintedShells = Array.isArray(payload?.uiHints?.availableShells)
        ? payload.uiHints.availableShells.filter((shell): shell is string => typeof shell === 'string' && shell.trim().length > 0)
        : [];

    const config = payload?.config;
    const systemInfo = isObjectRecord(config?.systemInfo) ? config.systemInfo : null;
    const isWindows = Boolean(systemInfo && systemInfo.isWindows === true);
    const isMacOS = Boolean(systemInfo && systemInfo.isMacOS === true);

    const baseOptions = hintedShells.length > 0
        ? hintedShells
        : isWindows
            ? ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe']
            : isMacOS
                ? ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/fish', 'zsh', 'bash', 'sh', 'fish']
                : ['/bin/bash', '/bin/sh', '/usr/bin/fish', '/bin/zsh', 'bash', 'sh', 'fish', 'zsh'];

    const options = new Set<string>();
    for (const shell of baseOptions) {
        options.add(shell);
    }
    if (currentShell.trim().length > 0) {
        options.add(currentShell);
    }

    return [...options];
}

export function createConfigEditorController(callTool: ToolCall) {
    const state: ConfigEditorState = {
        payload: null,
        selectedKey: null,
        draftValue: '',
    };

    const getSelectedEntry = (): ConfigEntry | undefined => {
        if (!state.payload || !state.selectedKey) {
            return undefined;
        }
        return state.payload.entries.find((entry) => entry.key === state.selectedKey);
    };

    const setPayload = (payload: ConfigEditorPayload | null): void => {
        state.payload = payload;
        if (!payload || payload.entries.length === 0) {
            state.selectedKey = null;
            state.draftValue = '';
            return;
        }

        if (!state.selectedKey || !payload.entries.some((entry) => entry.key === state.selectedKey)) {
            state.selectedKey = payload.entries[0].key;
        }

        const current = getSelectedEntry();
        state.draftValue = current ? stringifyValueForInput(current.value) : '';
    };

    const setSelection = (key: string): void => {
        state.selectedKey = key;
        const selected = getSelectedEntry();
        state.draftValue = selected ? stringifyValueForInput(selected.value) : '';
    };

    const setDraftValue = (value: string): void => {
        state.draftValue = value;
    };

    const apply = async (): Promise<ApplyConfigResult> => {
        const selected = getSelectedEntry();
        if (!selected) {
            return {
                ok: false,
                tooltip: {
                    message: 'Select a config key before applying.',
                    tone: 'error',
                },
            };
        }

        if (!selected.editable) {
            return {
                ok: false,
                tooltip: {
                    message: `The selected key (${selected.key}) is read-only.`,
                    tone: 'error',
                },
            };
        }

        const parsed = parseDraftValue(state.draftValue, selected.valueType);
        if (!parsed.ok) {
            return {
                ok: false,
                tooltip: {
                    message: parsed.message,
                    tone: 'error',
                },
            };
        }

        if (areConfigValuesEqual(parsed.value, selected.value)) {
            state.draftValue = stringifyValueForInput(selected.value);
            return { ok: false };
        }

        try {
            const setResult = await callTool('set_config_value', {
                key: selected.key,
                value: parsed.value,
            });
            if (isToolErrorResult(setResult)) {
                return {
                    ok: false,
                    tooltip: {
                        message: extractToolText(setResult) ?? `Failed to update ${selected.key}.`,
                        tone: 'error',
                    },
                };
            }

            const refreshed = await callTool('get_config', {});
            if (isToolErrorResult(refreshed)) {
                return {
                    ok: false,
                    tooltip: {
                        message: extractToolText(refreshed) ?? 'Value was updated but config refresh failed.',
                        tone: 'error',
                    },
                };
            }

            const refreshedPayload = extractPayload(refreshed);
            if (refreshedPayload) {
                setPayload(refreshedPayload);
                if (state.selectedKey === selected.key) {
                    const updatedSelected = getSelectedEntry();
                    state.draftValue = updatedSelected
                        ? stringifyValueForInput(updatedSelected.value)
                        : state.draftValue;
                }
            }

            return { ok: true };
        } catch (error) {
            return {
                ok: false,
                tooltip: {
                    message: `Failed to apply value: ${error instanceof Error ? error.message : String(error)}`,
                    tone: 'error',
                },
            };
        }
    };

    return {
        state,
        callTool,
        extractPayload,
        setPayload,
        setSelection,
        setDraftValue,
        apply,
    };
}

function render(container: HTMLElement, controller: ReturnType<typeof createConfigEditorController>, chrome: UiChromeState, hooks: RenderHooks = {}): void {
    shellController?.dispose();
    shellController = undefined;

    const { state } = controller;
    const entries = state.payload?.entries ?? [];
    const shellClasses = [
        'shell',
        'tool-shell',
        chrome.expanded ? 'expanded' : 'collapsed',
        'config-shell',
        chrome.hideSummaryRow ? 'host-framed' : '',
        chrome.compact ? 'compact' : '',
    ].filter(Boolean).join(' ');

    const settingsHtml = entries.map((entry, index) => {
        const keyTitle = entry.label ?? formatKeyLabel(entry.key);
        const description = entry.description ?? '';
        const summary = getSettingSummary(entry);

        let controlHtml: string;
        if (entry.key === 'defaultShell') {
            const currentShell = String(entry.value ?? '');
            const shellOptions = getShellOptions(state.payload, currentShell);
            const isCustomShell = !shellOptions.includes(currentShell);
            const options = shellOptions
                .map((shell) => `<option value="${escapeHtml(shell)}" ${shell === currentShell ? 'selected' : ''}>${escapeHtml(shell)}</option>`)
                .join('');
            controlHtml = `
                <div class="setting-shell-control">
                  <select class="setting-inline-select" data-action="shell-select" data-key-index="${index}">
                    ${options}
                    <option value="__custom__" ${isCustomShell ? 'selected' : ''}>Custom...</option>
                  </select>
                  <input class="setting-inline-input setting-shell-custom${isCustomShell ? '' : ' hidden'}" data-action="shell-custom" data-key-index="${index}" type="text" value="${escapeHtml(currentShell)}" placeholder="Type custom shell path"/>
                </div>
            `;
        } else if (entry.valueType === 'boolean') {
            const checked = String(entry.value) === 'true' ? 'checked' : '';
            controlHtml = `<label class="setting-switch"><input type="checkbox" data-action="toggle-boolean" data-key-index="${index}" ${checked}/><span class="config-boolean-slider"></span></label>`;
        } else if (entry.valueType === 'number') {
            controlHtml = `<input class="setting-inline-input" data-action="edit-number" data-key-index="${index}" type="number" step="any" value="${escapeHtml(String(entry.value ?? ''))}"/>`;
        } else if (entry.valueType === 'array') {
            controlHtml = `<button class="setting-inline-action" data-action="open-array" data-key-index="${index}">Edit</button>`;
        } else if (entry.valueType === 'null') {
            controlHtml = `<span class="setting-inline-static">null</span>`;
        } else {
            controlHtml = `<input class="setting-inline-input" data-action="edit-string" data-key-index="${index}" type="text" value="${escapeHtml(String(entry.value ?? ''))}"/>`;
        }

        return `
          <section class="setting-row">
            <div class="setting-info">
              <h3>${escapeHtml(keyTitle)}</h3>
              ${description ? `<p>${escapeHtml(description)}</p>` : ''}
              <p class="setting-summary${summary ? '' : ' hidden'}" data-setting-summary-key="${escapeHtml(entry.key)}">${summary ? escapeHtml(summary) : ''}</p>
            </div>
            <div class="setting-control">${controlHtml}</div>
          </section>
        `;
    }).join('');

    container.innerHTML = `
      <main id="tool-shell" class="${shellClasses}">
        ${renderCompactRow({ id: 'compact-toggle', label: 'View config', filename: 'Desktop Commander', variant: 'ready', expandable: true, expanded: chrome.expanded, interactive: true })}

        <section class="panel config-card">
          <div class="panel-content-wrapper">
            <div class="settings-stack" aria-label="Desktop Commander settings">${settingsHtml}</div>
          </div>
        </section>

        ${renderArrayModalMarkup('List Setting')}
      </main>
      <div id="config-tooltip" class="config-tooltip" role="status" aria-live="polite" hidden></div>
    `;

    const toolShell = container.querySelector('#tool-shell') as HTMLElement | null;
    const compactRow = container.querySelector('.compact-row--ready') as HTMLElement | null;

    const getUpdatedEntryByKey = (key: string): ConfigEntry | undefined => {
        return controller.state.payload?.entries.find((item) => item.key === key);
    };

    const refreshSettingSummary = (key: string): void => {
        const summaryElement = container.querySelector(`[data-setting-summary-key="${key}"]`) as HTMLElement | null;
        if (!summaryElement) {
            return;
        }
        const updatedEntry = getUpdatedEntryByKey(key);
        const summary = updatedEntry ? getSettingSummary(updatedEntry) : null;
        summaryElement.textContent = summary ?? '';
        summaryElement.classList.toggle('hidden', !summary);
    };

    const emitConfigChanged = (key: string, fallbackValue: unknown): void => {
        const updatedEntry = getUpdatedEntryByKey(key);
        refreshSettingSummary(key);
        hooks.onConfigChanged?.({
            key,
            value: updatedEntry ? updatedEntry.value : fallbackValue,
        });
    };

    const emitTooltip = (result: ApplyConfigResult): void => {
        if (result.tooltip) {
            hooks.onTooltip?.(result.tooltip);
        }
    };

    const arrayModal = createArrayModalController({
        container,
        parseEntryItems: (entry) => parseDraftArrayValues(stringifyValueForInput(entry.value)),
        formatEntryTitle: (entry) => entry.label ?? formatKeyLabel(entry.key),
        onSave: async (changedKey, items) => {
            controller.setSelection(changedKey);
            controller.setDraftValue(items.join('\n'));
            const result = await controller.apply();
            emitTooltip(result);
            if (result.ok) {
                emitConfigChanged(changedKey, items);
            }
        },
    });

    container.querySelectorAll('[data-action]').forEach((element) => {
        const target = element as HTMLElement;
        const action = target.dataset.action;
        const keyIndex = Number(target.dataset.keyIndex);
        const entry = entries[keyIndex];
        if (!entry) {
            return;
        }

        if (action === 'toggle-boolean') {
            target.addEventListener('change', async () => {
                const input = target as HTMLInputElement;
                const previousChecked = input.checked;
                controller.setSelection(entry.key);
                controller.setDraftValue(input.checked ? 'true' : 'false');
                const result = await controller.apply();
                emitTooltip(result);
                const updatedEntry = getUpdatedEntryByKey(entry.key);
                if (updatedEntry && typeof updatedEntry.value === 'boolean') {
                    input.checked = updatedEntry.value;
                } else if (!result.ok) {
                    input.checked = !previousChecked;
                }
                if (result.ok) {
                    emitConfigChanged(entry.key, input.checked);
                }
            });
            return;
        }

        if (action === 'edit-number') {
            target.addEventListener('blur', async () => {
                const input = target as HTMLInputElement;
                controller.setSelection(entry.key);
                controller.setDraftValue(input.value);
                const result = await controller.apply();
                emitTooltip(result);
                const updatedEntry = getUpdatedEntryByKey(entry.key);
                input.value = String(updatedEntry?.value ?? controller.state.draftValue);
                if (result.ok) {
                    emitConfigChanged(entry.key, input.value);
                }
            });
            return;
        }

        if (action === 'shell-select') {
            target.addEventListener('change', async () => {
                const select = target as HTMLSelectElement;
                const customInput = container.querySelector(`input[data-action="shell-custom"][data-key-index="${keyIndex}"]`) as HTMLInputElement | null;
                if (select.value === '__custom__') {
                    customInput?.classList.remove('hidden');
                    customInput?.focus();
                    return;
                }

                customInput?.classList.add('hidden');
                controller.setSelection(entry.key);
                controller.setDraftValue(select.value);
                const result = await controller.apply();
                emitTooltip(result);
                const updatedEntry = getUpdatedEntryByKey(entry.key);
                const shellValue = String(updatedEntry?.value ?? select.value);
                const shellCustomInput = container.querySelector(`input[data-action="shell-custom"][data-key-index="${keyIndex}"]`) as HTMLInputElement | null;
                if (shellCustomInput) {
                    shellCustomInput.value = shellValue;
                }
                if (result.ok) {
                    emitConfigChanged(entry.key, shellValue);
                }
            });
            return;
        }

        if (action === 'shell-custom') {
            const commitCustomShell = async () => {
                const input = target as HTMLInputElement;
                if (!input.value.trim()) {
                    return;
                }
                controller.setSelection(entry.key);
                controller.setDraftValue(input.value.trim());
                const result = await controller.apply();
                emitTooltip(result);
                const updatedEntry = getUpdatedEntryByKey(entry.key);
                input.value = String(updatedEntry?.value ?? controller.state.draftValue);
                if (result.ok) {
                    emitConfigChanged(entry.key, input.value);
                }
            };

            target.addEventListener('blur', () => {
                void commitCustomShell();
            });

            target.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') {
                    return;
                }
                event.preventDefault();
                void commitCustomShell();
            });
            return;
        }

        if (action === 'edit-string') {
            target.addEventListener('keydown', async (event) => {
                if (event.key !== 'Enter') {
                    return;
                }
                event.preventDefault();
                const input = target as HTMLInputElement;
                controller.setSelection(entry.key);
                controller.setDraftValue(input.value.replace(/\r?\n/g, ' '));
                const result = await controller.apply();
                emitTooltip(result);
                const updatedEntry = getUpdatedEntryByKey(entry.key);
                input.value = String(updatedEntry?.value ?? controller.state.draftValue);
                if (result.ok) {
                    emitConfigChanged(entry.key, input.value);
                }
            });
            return;
        }

        if (action === 'open-array') {
            target.addEventListener('click', () => {
                const latestEntry = getUpdatedEntryByKey(entry.key) ?? entry;
                arrayModal.open(latestEntry);
            });
        }
    });

    shellController = createCompactRowShellController({
        shell: toolShell,
        compactRow,
        initialExpanded: chrome.expanded,
        onToggle: (expanded) => {
            chrome.expanded = expanded;
        },
    });
}

function markReady(): void {
    document.body.classList.add('dc-ready');
}

export function bootstrapConfigEditorApp(): void {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }

    const bridge = createToolBridge();
    const controller = createConfigEditorController((name, args) => bridge.callTool(name, args));
    const widgetState = createWidgetStateStorage<ConfigEditorPayload>(isConfigEditorPayload);
    const chrome: UiChromeState = {
        hideSummaryRow: false,
        compact: false,
        expanded: false,
    };

    let quietContextSupported = true;
    let tooltipHideTimer: number | null = null;

    const clearTooltipTimer = (): void => {
        if (tooltipHideTimer !== null) {
            window.clearTimeout(tooltipHideTimer);
            tooltipHideTimer = null;
        }
    };

    const showTooltip = (tooltip: TooltipMessage): void => {
        const tooltipElement = container.querySelector('#config-tooltip') as HTMLElement | null;
        if (!tooltipElement) {
            return;
        }

        clearTooltipTimer();
        tooltipElement.className = `config-tooltip config-tooltip--${tooltip.tone}`;
        tooltipElement.textContent = tooltip.message;
        tooltipElement.hidden = false;

        tooltipHideTimer = window.setTimeout(() => {
            tooltipElement.hidden = true;
            tooltipElement.textContent = '';
            tooltipElement.className = 'config-tooltip';
            tooltipHideTimer = null;
        }, 2600);
    };

    const syncModelContext = (reason: string, change?: { key: string; value: unknown }): void => {
        const payload = controller.state.payload;
        if (!payload || !quietContextSupported) {
            return;
        }
        const values = payload.entries
            .map((entry) => `${entry.key}=${JSON.stringify(entry.value)}`)
            .join(', ');
        const changeText = change
            ? `Updated ${change.key} to ${JSON.stringify(change.value)}.`
            : 'Configuration updated.';
        app.updateModelContext({
            content: [{ type: 'text', text: `${changeText} Snapshot (${reason}): ${values}` }],
            structuredContent: {
                reason,
                changedKey: change?.key,
                changedValue: change?.value,
                entries: payload.entries.map((entry) => ({
                    key: entry.key,
                    label: entry.label,
                    value: entry.value,
                    valueType: entry.valueType,
                })),
            },
        }).catch(() => {
            // Host may not support updateModelContext; avoid repeated failed calls.
            quietContextSupported = false;
        });
    };

    let renderFrameId: number | null = null;
    const scheduleRender = (): void => {
        if (renderFrameId !== null) {
            return;
        }
        renderFrameId = window.requestAnimationFrame(() => {
            renderFrameId = null;
            render(container, controller, chrome, {
                onConfigChanged: (change) => {
                    if (controller.state.payload) {
                        widgetState.write(controller.state.payload);
                    }
                    syncModelContext('widget-edit', change);
                },
                onTooltip: showTooltip,
            });
            markReady();
        });
    };

    scheduleRender();

    const app = new App(
        { name: 'Desktop Commander Config Editor', version: '1.0.0' },
        {},
        { autoResize: true },
    );

    app.onteardown = async () => {
        shellController?.dispose();
        if (renderFrameId !== null) {
            window.cancelAnimationFrame(renderFrameId);
            renderFrameId = null;
        }
        clearTooltipTimer();
        return {};
    };

    const applyPayload = (payload: ConfigEditorPayload): void => {
        controller.setPayload(payload);
        widgetState.write(payload);
        scheduleRender();
    };

    const refreshConfigFromServer = async (): Promise<void> => {
        try {
            const result = await bridge.callTool('get_config', {});
            const payload = controller.extractPayload(result);
            if (payload) {
                applyPayload(payload);
            }
        } catch {
            // Best-effort refresh only
        }
    };

    app.ontoolresult = (result) => {
        const payload = controller.extractPayload(result);
        if (payload) {
            applyPayload(payload);
        }
    };

    app.ontoolcancelled = (params) => {
        showTooltip({
            message: params.reason ?? 'Tool was cancelled.',
            tone: 'error',
        });
    };

    void connectWithSharedHostContext({
        app,
        chrome,
        onContextApplied: scheduleRender,
        onConnected: async () => {
            const cachedPayload = widgetState.read();
            if (cachedPayload) {
                controller.setPayload(cachedPayload);
            }
            scheduleRender();
            await refreshConfigFromServer();
        },
    }).catch(() => {
        scheduleRender();
        window.setTimeout(() => {
            showTooltip({
                message: 'Failed to connect to host.',
                tone: 'error',
            });
        }, 0);
    });

    window.addEventListener('beforeunload', () => {
        shellController?.dispose();
        clearTooltipTimer();
    }, { once: true });
}
