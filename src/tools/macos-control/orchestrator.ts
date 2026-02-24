import { axAdapter } from './ax-adapter.js';
import { cdpAdapter } from './cdp-adapter.js';
import {
  AxBatchCommand,
  AxBatchResult,
  AxElement,
  MacosControlErrorCode,
  MacosControlResult,
} from './types.js';

function fail<T = never>(code: MacosControlErrorCode, message: string): MacosControlResult<T> {
  return {
    ok: false,
    error: {
      code: code as any,
      message,
    },
  };
}

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export class MacosControlOrchestrator {
  async axStatus() {
    return axAdapter.status();
  }

  async axListApps() {
    return axAdapter.listApps();
  }

  async axListElements(args: {
    scope?: 'top_window' | 'app' | 'all';
    app?: string;
    text?: string;
    role?: string;
    depth?: number;
    limit?: number;
  }) {
    return axAdapter.listElements(args);
  }

  async axFind(args: {
    app: string;
    text?: string;
    role?: string;
    index?: number;
    depth?: number;
    limit?: number;
  }): Promise<MacosControlResult<AxElement[]>> {
    return axAdapter.find(args);
  }

  async axClick(args: {
    id?: string;
    app?: string;
    text?: string;
    role?: string;
    index?: number;
    depth?: number;
    limit?: number;
  }): Promise<MacosControlResult<Record<string, unknown>>> {
    if (args.id) {
      return axAdapter.clickById(args.id, args.app);
    }

    if (!args.app || !args.text) {
      return fail('INVALID_ARGUMENT', 'Provide either id or app+text for macos_ax_click');
    }

    const found = await axAdapter.find({
      app: args.app,
      text: args.text,
      role: args.role,
      depth: args.depth,
      limit: args.limit,
      index: args.index,
    });

    if (!found.ok) {
      return {
        ok: false,
        error: found.error,
      };
    }

    const target = found.data?.[0];
    if (!target) {
      return fail('NOT_FOUND', `No element matched text "${args.text}" in ${args.app}`);
    }

    return axAdapter.clickById(target.id, args.app);
  }

  async axGetState(args: {
    app: string;
    text?: string;
    role?: string;
    index?: number;
    depth?: number;
    limit?: number;
  }): Promise<MacosControlResult<Record<string, unknown>>> {
    return axAdapter.getState(args);
  }

  async axFindAndClick(args: {
    app: string;
    text?: string;
    role?: string;
    index?: number;
    depth?: number;
    limit?: number;
    timeout_ms?: number;
    if_exists?: boolean;
  }): Promise<MacosControlResult<Record<string, unknown>>> {
    const timeoutMs = args.timeout_ms ?? 0;

    if (timeoutMs > 0 && args.text) {
      const waited = await this.axWaitFor({
        app: args.app,
        text: args.text,
        role: args.role,
        timeout_ms: timeoutMs,
        depth: args.depth,
      });

      if (!waited.ok) {
        if (args.if_exists && waited.error?.code === 'TIMEOUT') {
          return { ok: true, data: { skipped: true } };
        }
        return { ok: false, error: waited.error };
      }
    }

    const found = await this.axFind({
      app: args.app,
      text: args.text,
      role: args.role,
      index: args.index,
      depth: args.depth,
      limit: args.limit,
    });

    if (!found.ok) {
      if (args.if_exists && found.error?.code === 'NOT_FOUND') {
        return { ok: true, data: { skipped: true } };
      }
      return { ok: false, error: found.error };
    }

    const element = found.data?.[0];
    if (!element) {
      if (args.if_exists) {
        return { ok: true, data: { skipped: true } };
      }
      return fail('NOT_FOUND', `No element matched criteria in ${args.app}`);
    }

    const clickResult = await axAdapter.clickById(element.id, args.app);
    if (!clickResult.ok) {
      return { ok: false, error: clickResult.error };
    }

    return {
      ok: true,
      data: {
        element,
        click_result: clickResult.data,
      },
    };
  }

  async axType(text: string) {
    return axAdapter.typeText(text);
  }

  async axKey(key: string, modifiers: string[] = []) {
    return axAdapter.pressKey(key, modifiers);
  }

  async axActivate(app: string) {
    return axAdapter.activate(app);
  }

  async axWaitFor(args: {
    app: string;
    text: string;
    role?: string;
    timeout_ms?: number;
    depth?: number;
  }) {
    return axAdapter.waitFor(args);
  }

  async axBatch(commands: AxBatchCommand[], stopOnError: boolean = true): Promise<MacosControlResult<AxBatchResult>> {
    if (!isMacOS()) {
      return fail('UNSUPPORTED_PLATFORM', 'macOS control tools are only available on macOS.');
    }
    return axAdapter.batch(commands, stopOnError);
  }

  async electronDebugAttach(args: {
    host?: string;
    port?: number;
    targetIndex?: number;
    targetId?: string;
  }) {
    return cdpAdapter.attach(args);
  }

  async electronDebugEval(args: {
    sessionId: string;
    expression: string;
    returnByValue?: boolean;
    awaitPromise?: boolean;
  }) {
    return cdpAdapter.evaluate(args);
  }

  async electronDebugDisconnect(args: { sessionId: string }) {
    return cdpAdapter.disconnect(args.sessionId);
  }
}

export const macosControlOrchestrator = new MacosControlOrchestrator();
