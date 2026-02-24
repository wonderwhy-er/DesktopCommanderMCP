export type MacosControlErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'HELPER_NOT_FOUND'
  | 'HELPER_EXEC_FAILED'
  | 'HELPER_PROTOCOL_ERROR'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'ACTION_FAILED'
  | 'CDP_CONNECT_FAILED'
  | 'CDP_NOT_CONNECTED'
  | 'CDP_CALL_FAILED'
  | 'INTERNAL_ERROR';

export interface MacosControlError {
  code: MacosControlErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retriable?: boolean;
}

export interface MacosControlResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: MacosControlError;
}

export interface AxElement {
  id: string;
  app: string;
  pid: number;
  role: string;
  title?: string;
  label?: string;
  desc?: string;
  text?: string;
  checked?: boolean;
  selected?: boolean;
  focused?: boolean;
  actions?: string[];
  bounds: [number, number, number, number];
}

export interface AxAppInfo {
  name: string;
  pid: number;
  bundleId?: string;
  active: boolean;
}

export interface AxStatus {
  platform: NodeJS.Platform;
  hasPermission: boolean;
  helperPath?: string;
  helperVersion?: string;
  processInfo?: string;
}

export interface AxBatchCommand {
  action: 'activate' | 'find' | 'click' | 'find_and_click' | 'type' | 'key' | 'wait' | 'wait_for' | 'get_state' | 'scroll';
  app?: string;
  text?: string;
  role?: string;
  id?: string;
  timeout_ms?: number;
  depth?: number;
  limit?: number;
  key?: string;
  modifiers?: string[];
  index?: number;
  if_exists?: boolean;
  ms?: number;
  x?: number;
  y?: number;
  direction?: 'up' | 'down';
  amount?: number;
}

export interface AxBatchResultItem {
  action: string;
  success: boolean;
  skipped?: boolean;
  element?: AxElement;
  error?: string;
  [key: string]: unknown;
}

export interface AxBatchResult {
  success: boolean;
  results: AxBatchResultItem[];
  failedAt: number | null;
  completed: number;
  total: number;
}

export interface ElectronDebugTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface ElectronDebugAttachResult {
  sessionId: string;
  host: string;
  port: number;
  targetId: string;
  targetTitle: string;
  targetUrl: string;
  availableTargets: Array<{ id: string; title: string; url: string; type: string }>;
}

export interface ElectronDebugEvalResult {
  result?: unknown;
  type?: string;
  description?: string;
  subtype?: string;
}

export interface AxElementSignature {
  app: string;
  role: string;
  title?: string;
  label?: string;
  text?: string;
  bounds?: [number, number, number, number];
}

export interface HelperRequest {
  command: string;
  args?: Record<string, unknown>;
  requestId?: string;
}

export interface HelperError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HelperResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: HelperError;
  meta?: {
    requestId?: string;
    durationMs?: number;
    [key: string]: unknown;
  };
}
