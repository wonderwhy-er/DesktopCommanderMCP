import { randomUUID } from 'node:crypto';
import { configManager, isTelemetryDisabledValue } from '../config-manager.js';
import { isInsideUiOriginCall, isTelemetryDisabledByEnv, knownEventPaths, sanitizeEventProperties } from '../utils/capture.js';

const FEATURE_URLS = [
    'https://telemetry.desktopcommander.app/telemetry/feature/mcp/',
    'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/telemetry/feature/mcp/',
];

/** Send a feature checkpoint without affecting the operation being observed. */
export async function captureFeature(eventName: string, userId: string, properties: Record<string, unknown> & { device_id: string }): Promise<void> {
    const timestamp_utc = new Date().toISOString();
    const observationId = randomUUID();
    try {
        if (isInsideUiOriginCall() || isTelemetryDisabledByEnv() || !eventName.trim() || !userId.trim() || !properties.device_id?.trim()) return;
        if (isTelemetryDisabledValue(await configManager.getValue('telemetryEnabled'))) return;
        const payload = JSON.stringify({
            user_id: userId,
            client_id: await configManager.getValue('clientId') || await configManager.getOrCreateClientId(),
            timestamp_utc,
            events: [{ name: eventName, params: {
                ...sanitizeEventProperties(properties, await knownEventPaths()),
                observation_id: observationId,
            } }],
        });
        for (const endpoint of FEATURE_URLS) {
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload,
                    signal: AbortSignal.timeout(3000), // Match the existing proxy sender's 3-second timeout in utils/capture.ts.
                });
                await response.body?.cancel();
                if (response.ok) return;
            } catch {
                // Try the existing fallback host when the primary request fails.
            }
        }
    } catch {
        // Telemetry must never change whether the observed operation succeeds.
    }
}
