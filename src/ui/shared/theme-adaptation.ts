/**
 * Theme synchronization utilities that adapt embedded UI styles to host light/dark context. It centralizes theme event handling and class/token updates.
 */
type ThemeMode = 'light' | 'dark';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function normalizeThemeMode(value: unknown): ThemeMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'dark' || normalized === 'night') {
    return 'dark';
  }
  if (normalized === 'light' || normalized === 'day') {
    return 'light';
  }
  return undefined;
}

function pickThemeCandidate(value: unknown): unknown[] {
  if (!isObject(value)) {
    return [];
  }

  const candidates: unknown[] = [
    value.theme,
    value.colorScheme,
    value.appearance,
    value.mode,
  ];

  if (isObject(value.context)) {
    candidates.push(value.context, value.context.theme, value.context.colorScheme);
  }
  if (isObject(value.params)) {
    candidates.push(value.params, value.params.theme, value.params.colorScheme, value.params.context);
  }

  return candidates;
}

export function resolveThemeMode(value: unknown): ThemeMode | undefined {
  const direct = normalizeThemeMode(value);
  if (direct) {
    return direct;
  }
  if (!isObject(value)) {
    return undefined;
  }

  for (const candidate of pickThemeCandidate(value)) {
    const resolved = resolveThemeMode(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function isSafeCssVariableName(name: string): boolean {
  return /^--[a-zA-Z0-9_-]+$/.test(name);
}

function extractCssVariableMap(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    return {};
  }
  const params = isObject(value.params) ? value.params : undefined;
  const paramsContext = params && isObject(params.context) ? params.context : undefined;

  const rawMapCandidates: unknown[] = [
    value.cssVariables,
    value.variables,
    value.tokens,
    isObject(value.theme) ? value.theme.cssVariables : undefined,
    isObject(value.theme) ? value.theme.variables : undefined,
    isObject(value.theme) ? value.theme.tokens : undefined,
    isObject(value.context) ? (value.context as JsonObject).cssVariables : undefined,
    isObject(value.context) ? (value.context as JsonObject).variables : undefined,
    isObject(value.context) ? (value.context as JsonObject).tokens : undefined,
    params ? params.cssVariables : undefined,
    params ? params.variables : undefined,
    params ? params.tokens : undefined,
    paramsContext ? paramsContext.cssVariables : undefined,
    paramsContext ? paramsContext.variables : undefined,
    paramsContext ? paramsContext.tokens : undefined,
  ];

  for (const candidate of rawMapCandidates) {
    if (!isObject(candidate)) {
      continue;
    }

    const next: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(candidate)) {
      if (typeof rawValue !== 'string') {
        continue;
      }
      const key = rawKey.startsWith('--') ? rawKey : `--${rawKey}`;
      if (!isSafeCssVariableName(key)) {
        continue;
      }
      next[key] = rawValue.trim();
    }
    return next;
  }

  return {};
}

function applyCssVariables(root: HTMLElement, variableMap: Record<string, string>): void {
  for (const [name, value] of Object.entries(variableMap)) {
    root.style.setProperty(name, value);
  }
}

export interface UiThemeAdapter {
  applyFromData: (data: unknown) => boolean;
}

export function createUiThemeAdapter(root: HTMLElement = document.documentElement): UiThemeAdapter {
  const applyFromData = (data: unknown): boolean => {
    const mode = resolveThemeMode(data);
    const variableMap = extractCssVariableMap(data);
    const hasChanges = Boolean(mode) || Object.keys(variableMap).length > 0;

    if (mode) {
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
    }
    if (Object.keys(variableMap).length > 0) {
      applyCssVariables(root, variableMap);
    }

    return hasChanges;
  };

  return {
    applyFromData,
  };
}
