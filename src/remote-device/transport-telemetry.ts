import { randomUUID } from 'node:crypto';
import { captureTransport } from '../utils/capture.js';
import type { BroadcastDoorbell } from './remote-channel.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROCESS_ID = randomUUID();

type TransportObservation = {
    stage: string;
    callId: string;
    payload?: BroadcastDoorbell;
    deviceId: string | null | undefined;
    userId: string | undefined;
    transport?: 'broadcast' | 'mqtt';
    outcome?: 'success' | 'failed';
    timestampUtc?: string;
    toolName?: string;
    operation?: string;
    operationId?: string;
    /** Who claimed the call (call_claimed): MQTT, Broadcast, or the scan for waiting calls. */
    claimedBy?: 'mqtt' | 'broadcast' | 'recovery';
};

/** Record a device transport checkpoint without affecting command handling. */
export function observeTransport(input: TransportObservation) {
    try {
        const timestamp_utc = input.timestampUtc ?? new Date().toISOString();
        const { callId, deviceId, userId, payload } = input;
        if (typeof input.stage !== 'string' || !input.stage) return null;
        if (typeof callId !== 'string' || !ID.test(callId) ||
            typeof deviceId !== 'string' || !ID.test(deviceId) ||
            typeof userId !== 'string' || !ID.test(userId)) return null;
        if (payload && (payload.call_id !== callId || payload.device_id !== deviceId ||
            (payload.user_id !== undefined && payload.user_id !== userId))) return null;

        const observationId = randomUUID();
        const operationId = input.stage === 'operation_start' ? observationId : input.operationId;
        const event = {
            call_id: callId,
            device_id: deviceId,
            stage: input.stage,
            ...(input.transport === 'broadcast' || input.transport === 'mqtt' ? { transport: input.transport } : {}),
            ...(input.outcome === 'success' || input.outcome === 'failed' ? { outcome: input.outcome } : {}),
            ...(input.stage === 'received_from_backend' && input.transport === 'broadcast' ? {
                notification_id: `${callId}:broadcast:1`, attempt_number: 1,
            } : {}),
            ...(typeof input.toolName === 'string' && input.toolName.length > 0 &&
                input.toolName.length <= 128 ? { tool_name: input.toolName } : {}),
            ...(typeof input.operation === 'string' && input.operation ? { operation: input.operation } : {}),
            ...(typeof operationId === 'string' && operationId ? { operation_id: operationId } : {}),
            ...(input.claimedBy ? { claimed_by: input.claimedBy } : {}),
            observation_id: observationId,
            source_process_id: PROCESS_ID,
            schema_version: 1,
            timestamp_utc,
        };
        void captureTransport(input.stage, event, userId);
        return event;
    } catch {
        // Telemetry must never affect command handling.
        return null;
    }
}
