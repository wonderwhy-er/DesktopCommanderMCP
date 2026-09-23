import { randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROCESS_ID = randomUUID();

type Arrival = { timestamp_utc: string; monotonic_ms: number };

/** Build the one device observation at callback entry; never affect command handling. */
export function broadcastReceipt(
    payload: any,
    deviceId: string | null,
    userId: string | undefined,
    arrival: Arrival,
) {
    const callId = payload?.call_id;
    if (typeof callId !== 'string' || !ID.test(callId) ||
        typeof deviceId !== 'string' || !ID.test(deviceId) ||
        payload?.device_id !== deviceId || !userId ||
        (payload.user_id !== undefined && payload.user_id !== userId)) return null;

    return {
        call_id: callId,
        device_id: deviceId,
        transport: 'broadcast',
        stage: 'received',
        notification_id: `${callId}:broadcast:1`,
        attempt_number: 1,
        observation_id: randomUUID(),
        source_process_id: PROCESS_ID,
        schema_version: 1,
        ...arrival,
    };
}

/** A device checkpoint with only bounded identifiers and timing metadata. */
export function broadcastStage(callId: string, deviceId: string | undefined | null, stage: string, fields: Record<string, string | number> = {}) {
    if (typeof callId !== 'string' || !ID.test(callId) || typeof deviceId !== 'string' || !ID.test(deviceId)) return null;
    return {
        ...fields,
        call_id: callId,
        device_id: deviceId,
        transport: 'broadcast',
        stage,
        notification_id: `${callId}:broadcast:1`,
        attempt_number: 1,
        ...(stage === 'operation_end' ? { operation_id: randomUUID(), operation_attempt: 1 } : {}),
        observation_id: randomUUID(),
        source_process_id: PROCESS_ID,
        schema_version: 1,
        timestamp_utc: new Date(Date.now()).toISOString(),
        monotonic_ms: performance.now(),
    };
}
