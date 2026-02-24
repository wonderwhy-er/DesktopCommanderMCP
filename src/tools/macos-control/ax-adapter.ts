import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { expandRoleAlias } from './role-aliases.js';
import {
  AxBatchCommand,
  AxBatchResult,
  AxAppInfo,
  AxElement,
  AxElementSignature,
  AxStatus,
  HelperRequest,
  HelperResponse,
  MacosControlError,
  MacosControlResult,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function normalizeHelperError(code: string): MacosControlError['code'] {
  switch (code) {
    case 'UNSUPPORTED_PLATFORM':
      return 'UNSUPPORTED_PLATFORM';
    case 'HELPER_NOT_FOUND':
      return 'HELPER_NOT_FOUND';
    case 'PERMISSION_DENIED':
      return 'PERMISSION_DENIED';
    case 'INVALID_ARGUMENT':
      return 'INVALID_ARGUMENT';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'ACTION_FAILED':
      return 'ACTION_FAILED';
    default:
      return 'INTERNAL_ERROR';
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function makeError(code: MacosControlError['code'], message: string, details?: Record<string, unknown>): MacosControlResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

function parseBounds(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length === 4) {
    return [
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
      Number(value[3]) || 0,
    ];
  }
  return [0, 0, 0, 0];
}

function toAxElement(raw: any): AxElement {
  return {
    id: String(raw?.id ?? ''),
    app: String(raw?.app ?? ''),
    pid: Number(raw?.pid ?? 0),
    role: String(raw?.role ?? ''),
    title: raw?.title ? String(raw.title) : undefined,
    label: raw?.label ? String(raw.label) : undefined,
    desc: raw?.desc ? String(raw.desc) : undefined,
    text: raw?.text ? String(raw.text) : undefined,
    checked: typeof raw?.checked === 'boolean' ? raw.checked : undefined,
    selected: typeof raw?.selected === 'boolean' ? raw.selected : undefined,
    focused: typeof raw?.focused === 'boolean' ? raw.focused : undefined,
    actions: Array.isArray(raw?.actions) ? raw.actions.map((a: unknown) => String(a)) : undefined,
    bounds: parseBounds(raw?.bounds),
  };
}

export class AxAdapter {
  private helperPathCache: string | null = null;
  private signatures = new Map<string, AxElementSignature>();

  private async resolveHelperPath(): Promise<string | null> {
    if (this.helperPathCache !== null) {
      return this.helperPathCache;
    }

    const envOverride = process.env.DC_MACOS_AX_HELPER_PATH;
    const archName = process.arch === 'arm64' ? 'arm64' : 'x64';

    const candidates = [
      envOverride,
      path.join(PROJECT_ROOT, 'bin', 'macos', `macos-ax-helper-darwin-${archName}`),
      path.join(PROJECT_ROOT, 'native', 'macos-ax-helper', '.build', 'apple', 'Products', 'Release', 'macos-ax-helper'),
      path.join(PROJECT_ROOT, 'native', 'macos-ax-helper', '.build', 'release', 'macos-ax-helper'),
      path.join(PROJECT_ROOT, 'native', 'macos-ax-helper', '.build', `${process.arch}-apple-macosx`, 'release', 'macos-ax-helper'),
    ].filter((value): value is string => !!value);

    for (const candidate of candidates) {
      if (existsSync(candidate) && await isExecutable(candidate)) {
        this.helperPathCache = candidate;
        return candidate;
      }
    }

    this.helperPathCache = null;
    return null;
  }

  private async runHelper<T = unknown>(request: HelperRequest, timeoutMs = 15000): Promise<MacosControlResult<T>> {
    if (process.platform !== 'darwin') {
      return makeError('UNSUPPORTED_PLATFORM', 'macOS control tools are only available on macOS.');
    }

    const helperPath = await this.resolveHelperPath();
    if (!helperPath) {
      return makeError(
        'HELPER_NOT_FOUND',
        'macOS accessibility helper binary not found. Build it with ./build-macos-helper.sh',
        { projectRoot: PROJECT_ROOT },
      );
    }

    const payload = JSON.stringify(request);

    return await new Promise((resolve) => {
      const child = spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve(makeError('HELPER_EXEC_FAILED', `Failed to execute AX helper: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve(makeError('TIMEOUT', 'AX helper request timed out', { timeoutMs, command: request.command }));
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(makeError('HELPER_PROTOCOL_ERROR', 'AX helper returned empty response', { code, stderr }));
          return;
        }

        let parsed: HelperResponse<T>;
        try {
          parsed = JSON.parse(trimmed) as HelperResponse<T>;
        } catch {
          resolve(makeError('HELPER_PROTOCOL_ERROR', 'AX helper returned invalid JSON', { code, stderr, stdout: trimmed.slice(0, 400) }));
          return;
        }

        if (!parsed.ok) {
          const helperCode = parsed.error?.code ?? 'INTERNAL_ERROR';
          resolve({
            ok: false,
            error: {
              code: normalizeHelperError(helperCode),
              message: parsed.error?.message || 'AX helper request failed',
              details: {
                helperCode,
                helperDetails: parsed.error?.details,
                stderr,
              },
            },
          });
          return;
        }

        resolve({ ok: true, data: parsed.data });
      });

      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  private rememberElements(elements: AxElement[]): void {
    for (const element of elements) {
      if (!element.id) {
        continue;
      }

      this.signatures.set(element.id, {
        app: element.app,
        role: element.role,
        title: element.title,
        label: element.label,
        text: element.text,
        bounds: element.bounds,
      });
    }
  }

  private elementScore(candidate: AxElement, signature: AxElementSignature): number {
    let score = 0;

    if (candidate.role === signature.role) {
      score += 8;
    }

    if (signature.title && candidate.title === signature.title) {
      score += 6;
    }

    if (signature.label && candidate.label === signature.label) {
      score += 4;
    }

    if (signature.text && candidate.text === signature.text) {
      score += 3;
    }

    if (signature.bounds && candidate.bounds) {
      const dx = Math.abs(candidate.bounds[0] - signature.bounds[0]);
      const dy = Math.abs(candidate.bounds[1] - signature.bounds[1]);
      if (dx < 8 && dy < 8) {
        score += 5;
      }
    }

    return score;
  }

  private async fallbackRefindElement(staleId: string): Promise<AxElement | null> {
    const signature = this.signatures.get(staleId);
    if (!signature) {
      return null;
    }

    const queryText = signature.title || signature.label || signature.text;
    const refreshed = await this.listElements({
      scope: 'app',
      app: signature.app,
      text: queryText,
      role: signature.role,
      limit: 50,
      depth: 12,
    });

    if (!refreshed.ok || !refreshed.data || refreshed.data.length === 0) {
      return null;
    }

    const sorted = [...refreshed.data].sort((a, b) => this.elementScore(b, signature) - this.elementScore(a, signature));
    return sorted[0] ?? null;
  }

  async status(): Promise<MacosControlResult<AxStatus>> {
    const result = await this.runHelper<AxStatus>({ command: 'status' }, 8000);
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      data: {
        ...(result.data ?? { platform: process.platform, hasPermission: false }),
        platform: process.platform,
        helperPath: await this.resolveHelperPath() ?? undefined,
      },
    };
  }

  async listApps(): Promise<MacosControlResult<AxAppInfo[]>> {
    const result = await this.runHelper<{ apps?: unknown[] }>({ command: 'list_apps' });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
      };
    }

    const apps = Array.isArray(result.data?.apps)
      ? result.data.apps.map((app: any) => ({
          name: String(app?.name ?? 'Unknown'),
          pid: Number(app?.pid ?? 0),
          bundleId: app?.bundleId ? String(app.bundleId) : undefined,
          active: Boolean(app?.active),
        }))
      : [];

    return { ok: true, data: apps };
  }

  async listElements(args: {
    scope?: 'top_window' | 'app' | 'all';
    app?: string;
    text?: string;
    role?: string;
    depth?: number;
    limit?: number;
  }): Promise<MacosControlResult<AxElement[]>> {
    const roleFilters = expandRoleAlias(args.role);

    const result = await this.runHelper<{ elements?: unknown[] }>({
      command: 'list_elements',
      args: {
        scope: args.scope ?? 'top_window',
        app: args.app,
        text: args.text,
        roles: roleFilters,
        depth: args.depth,
        limit: args.limit,
      },
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
      };
    }

    const elements = Array.isArray(result.data?.elements)
      ? result.data.elements.map(toAxElement).filter((element) => element.id)
      : [];

    this.rememberElements(elements);
    return { ok: true, data: elements };
  }

  async find(args: {
    app: string;
    text?: string;
    role?: string;
    depth?: number;
    limit?: number;
    index?: number;
  }): Promise<MacosControlResult<AxElement[]>> {
    const index = Math.max(0, args.index ?? 0);
    const roleFilters = expandRoleAlias(args.role);
    const limit = Math.max(index + 1, args.limit ?? 0) || undefined;

    const result = await this.runHelper<{ elements?: unknown[] }>({
      command: 'find',
      args: {
        app: args.app,
        text: args.text,
        roles: roleFilters,
        depth: args.depth,
        limit,
        index,
      },
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
      };
    }

    const elements = Array.isArray(result.data?.elements)
      ? result.data.elements.map(toAxElement).filter((element) => element.id)
      : [];

    this.rememberElements(elements);
    return { ok: true, data: elements };
  }

  async clickById(id: string, appHint?: string): Promise<MacosControlResult<Record<string, unknown>>> {
    const clickResult = await this.runHelper<Record<string, unknown>>({
      command: 'click',
      args: {
        id,
        app: appHint,
      },
    });

    if (clickResult.ok) {
      return clickResult;
    }

    if (clickResult.error?.code !== 'NOT_FOUND') {
      return clickResult;
    }

    const fallbackElement = await this.fallbackRefindElement(id);
    if (!fallbackElement) {
      return clickResult;
    }

    return this.runHelper<Record<string, unknown>>({
      command: 'click',
      args: {
        id: fallbackElement.id,
        app: fallbackElement.app,
      },
    });
  }

  async typeText(text: string): Promise<MacosControlResult<Record<string, unknown>>> {
    return this.runHelper<Record<string, unknown>>({
      command: 'type_text',
      args: { text },
    });
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<MacosControlResult<Record<string, unknown>>> {
    return this.runHelper<Record<string, unknown>>({
      command: 'press_key',
      args: { key, modifiers },
    });
  }

  async activate(app: string): Promise<MacosControlResult<Record<string, unknown>>> {
    return this.runHelper<Record<string, unknown>>({
      command: 'activate',
      args: { app },
    });
  }

  async waitFor(args: {
    app: string;
    text: string;
    role?: string;
    timeout_ms?: number;
    depth?: number;
  }): Promise<MacosControlResult<AxElement>> {
    const result = await this.runHelper<{ element?: unknown }>({
      command: 'wait_for',
      args: {
        app: args.app,
        text: args.text,
        roles: expandRoleAlias(args.role),
        timeout_ms: args.timeout_ms,
        depth: args.depth,
      },
    }, (args.timeout_ms ?? 5000) + 3000);

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
      };
    }

    const element = result.data?.element ? toAxElement(result.data.element) : null;
    if (!element) {
      return makeError('NOT_FOUND', 'Element not found before timeout');
    }

    this.rememberElements([element]);
    return { ok: true, data: element };
  }

  async getState(args: {
    app: string;
    text?: string;
    role?: string;
    depth?: number;
    limit?: number;
    index?: number;
  }): Promise<MacosControlResult<Record<string, unknown>>> {
    const found = await this.find(args);
    if (!found.ok) {
      return {
        ok: false,
        error: found.error,
      };
    }

    const element = found.data?.[0];
    if (!element) {
      return makeError('NOT_FOUND', `No element matched criteria in ${args.app}`);
    }

    return {
      ok: true,
      data: {
        element,
        checked: element.checked,
        selected: element.selected,
        text: element.text,
      },
    };
  }

  async scroll(args: {
    x: number;
    y: number;
    direction?: 'up' | 'down';
    amount?: number;
  }): Promise<MacosControlResult<Record<string, unknown>>> {
    return this.runHelper<Record<string, unknown>>({
      command: 'scroll',
      args: {
        x: args.x,
        y: args.y,
        direction: args.direction ?? 'down',
        amount: args.amount ?? 3,
      },
    });
  }

  async batch(commands: AxBatchCommand[], stopOnError: boolean): Promise<MacosControlResult<AxBatchResult>> {
    const waitBudgetMs = commands.reduce((sum, command) => {
      if (command.action === 'wait') {
        return sum + Math.max(0, command.ms ?? 500);
      }
      if (command.action === 'wait_for') {
        return sum + Math.max(0, command.timeout_ms ?? 5000);
      }
      return sum;
    }, 0);
    const timeoutMs = Math.min(Math.max(30000, waitBudgetMs + commands.length * 4000), 5 * 60 * 1000);

    return this.runHelper<AxBatchResult>({
      command: 'batch',
      args: {
        commands,
        stop_on_error: stopOnError,
      },
    }, timeoutMs);
  }
}

export const axAdapter = new AxAdapter();
