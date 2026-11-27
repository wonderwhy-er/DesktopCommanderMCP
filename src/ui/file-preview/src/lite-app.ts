/**
 * Minimal MCP Apps client used by the unopened File Preview card.
 * Keep this dependency-free: the full ext-apps SDK is loaded only after a click.
 */
type JsonRpcId = string | number;
type ToolResult = {
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
};

type PendingRequest = {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

export interface LiteAppInfo {
    name: string;
    version: string;
}

export const LITE_MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
}
export class LiteMcpApp {
    ontoolinput?: (params: { arguments?: Record<string, unknown> }) => void;
    ontoolresult?: (params: ToolResult) => void;
    ontoolcancelled?: (params: { reason?: string }) => void;
    onhostcontextchanged?: (params: Record<string, unknown>) => void;
    onteardown?: () => Record<string, unknown> | Promise<Record<string, unknown>>;

    private nextId = 0;
    private pending = new Map<JsonRpcId, PendingRequest>();
    private hostContext?: Record<string, unknown>;
    private connected = false;
    private resizeCleanup?: () => void;

    constructor(
        private readonly appInfo: LiteAppInfo,
        private readonly appCapabilities: Record<string, unknown> = {},
        private readonly autoResize = true,
    ) {}

    getHostContext(): Record<string, unknown> | undefined {
        return this.hostContext;
    }

    async connect(): Promise<void> {
        if (this.connected) return;
        window.addEventListener('message', this.handleMessage);
        try {
            const result = await this.request('ui/initialize', {
                appCapabilities: this.appCapabilities,
                appInfo: this.appInfo,
                protocolVersion: LITE_MCP_APPS_PROTOCOL_VERSION,
            }) as Record<string, unknown>;
            this.hostContext = isRecord(result.hostContext) ? result.hostContext : undefined;
            this.connected = true;
            this.notify('ui/notifications/initialized');
            if (this.autoResize) this.resizeCleanup = this.setupAutoResize();
        } catch (error) {
            window.removeEventListener('message', this.handleMessage);
            throw error;
        }
    }

    async callServerTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult> {
        return this.request('tools/call', params) as Promise<ToolResult>;
    }

    async updateModelContext(params: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.request('ui/update-model-context', params) as Promise<Record<string, unknown>>;
    }

    async openLink(params: { url: string }): Promise<{ isError?: boolean; [key: string]: unknown }> {
        return this.request('ui/open-link', params) as Promise<{ isError?: boolean; [key: string]: unknown }>;
    }

    async requestDisplayMode(params: { mode: 'inline' | 'fullscreen' | 'pip' }): Promise<{ mode: string }> {
        return this.request('ui/request-display-mode', params) as Promise<{ mode: string }>;
    }
    private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP Apps request timed out: ${method}`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
        });
    }

    private notify(method: string, params?: Record<string, unknown>): void {
        this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    }

    private post(message: Record<string, unknown>): void {
        window.parent.postMessage(message, '*');
    }

    private handleMessage = (event: MessageEvent): void => {
        if (event.source !== window.parent || !isRecord(event.data) || event.data.jsonrpc !== '2.0') return;
        const message = event.data;
        if (typeof message.method === 'string') {
            this.handleIncomingMethod(message);
            return;
        }
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id as JsonRpcId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id as JsonRpcId);
        if (isRecord(message.error)) {
            pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP Apps request failed'));
        } else {
            pending.resolve(message.result);
        }
    };

    private handleIncomingMethod(message: Record<string, any>): void {
        const params = isRecord(message.params) ? message.params : {};
        switch (message.method) {
            case 'ui/notifications/tool-input':
                this.ontoolinput?.(params as { arguments?: Record<string, unknown> });
                return;
            case 'ui/notifications/tool-result':
                this.ontoolresult?.(params as ToolResult);
                return;
            case 'ui/notifications/tool-cancelled':
                this.ontoolcancelled?.(params as { reason?: string });
                return;
            case 'ui/notifications/host-context-changed':
                this.hostContext = { ...(this.hostContext ?? {}), ...params };
                this.onhostcontextchanged?.(params);
                return;
            case 'ui/resource-teardown':
                if (message.id !== undefined) void this.respondToTeardown(message.id as JsonRpcId);
                return;
            case 'ping':
                if (message.id !== undefined) this.post({ jsonrpc: '2.0', id: message.id, result: {} });
        }
    }
    private async respondToTeardown(id: JsonRpcId): Promise<void> {
        try {
            const result = await this.onteardown?.() ?? {};
            this.post({ jsonrpc: '2.0', id, result });
        } catch (error) {
            this.post({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        } finally {
            this.resizeCleanup?.();
            this.resizeCleanup = undefined;
            window.removeEventListener('message', this.handleMessage);
            this.connected = false;
            for (const pending of this.pending.values()) clearTimeout(pending.timer);
            this.pending.clear();
        }
    }

    private setupAutoResize(): (() => void) | undefined {
        if (typeof ResizeObserver !== 'function') return;
        let scheduled = false;
        let frame = 0;
        let lastWidth = 0;
        let lastHeight = 0;
        const schedule = (): void => {
            if (scheduled) return;
            scheduled = true;
            frame = requestAnimationFrame(() => {
                scheduled = false;
                frame = 0;
                const root = document.documentElement;
                const previousWidth = root.style.width;
                const previousHeight = root.style.height;
                root.style.width = 'fit-content';
                root.style.height = 'fit-content';
                const rect = root.getBoundingClientRect();
                root.style.width = previousWidth;
                root.style.height = previousHeight;
                const scrollbarWidth = window.innerWidth - root.clientWidth;
                const width = Math.ceil(rect.width + scrollbarWidth);
                const height = Math.ceil(rect.height);
                if (width === lastWidth && height === lastHeight) return;
                lastWidth = width;
                lastHeight = height;
                this.notify('ui/notifications/size-changed', { width, height });
            });
        };
        schedule();
        const observer = new ResizeObserver(schedule);
        observer.observe(document.documentElement);
        if (document.body) observer.observe(document.body);
        return () => {
            observer.disconnect();
            if (frame) cancelAnimationFrame(frame);
        };
    }
}
