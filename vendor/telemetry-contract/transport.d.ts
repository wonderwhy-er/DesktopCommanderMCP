export interface TransportParams {
  call_id: string;
  stage: string;
  timestamp_utc: string;
  monotonic_ms?: number;
  transport?: 'mqtt' | 'broadcast';
  device_id?: string;
  [key: string]: unknown;
}

export interface TransportEvent {
  name: string;
  params: TransportParams;
}

export interface RemoteTransportPayload {
  user_id: string;
  timestamp_micros?: number;
  events: TransportEvent[];
}

export interface DeviceTransportPayload {
  client_id: string;
  timestamp_micros?: number;
  events: Array<{ name: string; params: TransportParams & { device_id: string } }>;
}

/** Identifies a transport batch before choosing the ordinary event path. */
export function hasTransportEvents(payload: unknown): boolean;

/** Validates one event and removes unknown or invalid optional fields. */
export function sanitizeTransportEvent(eventName: string, params: unknown): TransportParams;

/** Validates a 1–10 event authenticated backend batch. */
export function parseRemoteTransportPayload(payload: unknown): RemoteTransportPayload;

/** Validates a 1–10 event device batch and assigns source=device. */
export function parseDeviceTransportPayload(payload: unknown): DeviceTransportPayload;
