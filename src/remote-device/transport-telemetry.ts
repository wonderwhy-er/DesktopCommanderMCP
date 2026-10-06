import { randomUUID } from 'node:crypto';
import { sanitizeTransportEvent } from '@desktop-commander/telemetry-contract/transport';
import { captureTransport } from '../utils/capture.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROCESS_ID = randomUUID();

type TransportObservation = (
    | { stage: 'received'; payload: any; deviceId: string | null; userId: string | undefined }
    | { stage: string; callId: string; deviceId: string | null | undefined; toolName?: string; operation?: string; operationId?: string }
) & { transport?: 'broadcast' | 'mqtt' };

/** Record a device transport checkpoint without affecting command handling. */
export function observeTransport(input: TransportObservation) {
    try {
        const timestamp_utc = new Date().toISOString();
        const receipt = 'payload' in input;
        const callId = receipt ? input.payload?.call_id : input.callId;
        const deviceId = input.deviceId;
        if (typeof callId !== 'string' || !ID.test(callId) ||
            typeof deviceId !== 'string' || !ID.test(deviceId)) return null;
        if (receipt && (input.payload.device_id !== deviceId || !input.userId ||
            (input.payload.user_id !== undefined && input.payload.user_id !== input.userId))) return null;

        const observationId = randomUUID();
        let operationId: string | undefined;
        if (!receipt) {
            operationId = input.stage === 'operation_start' ? observationId : input.operationId;
        }
        const event = {
            call_id: callId,
            device_id: deviceId,
            stage: input.stage,
            ...(input.transport === 'broadcast' || input.transport === 'mqtt' ? { transport: input.transport } : {}),
            ...(input.transport === 'broadcast' ? {
                notification_id: `${callId}:broadcast:1`, attempt_number: 1,
            } : {}),
            ...(!receipt && typeof input.toolName === 'string' && input.toolName.length > 0 &&
                input.toolName.length <= 128 ? { tool_name: input.toolName } : {}),
            ...(!receipt && input.operation ? { operation: input.operation } : {}),
            ...(operationId ? { operation_id: operationId } : {}),
            observation_id: observationId,
            source_process_id: PROCESS_ID,
            schema_version: 1,
            timestamp_utc,
        };
        void captureTransport(input.stage, sanitizeTransportEvent(input.stage, event));
        return event;
    } catch {
        // Telemetry must never affect command handling.
        return null;
    }
}
