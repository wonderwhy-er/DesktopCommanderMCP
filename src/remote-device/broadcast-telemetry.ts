import {
  getTelemetryClientId, TELEMETRY_PROXY_URL, TELEMETRY_PROXY_FALLBACK_URL,
} from '../utils/capture.js';
import type { BroadcastEvent } from './broadcast-analytics.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Await public memory admission; the caller owns opt-outs, buffering and bounded retries. */
export async function sendBroadcastObservations(
  deviceId: string, observations: BroadcastEvent[], signal: AbortSignal,
  endpoints: readonly [string, string] = [TELEMETRY_PROXY_URL, TELEMETRY_PROXY_FALLBACK_URL],
): Promise<number> {
  if (typeof deviceId !== 'string' || !ID.test(deviceId) || observations.length < 1 || observations.length > 50) {
    throw new Error('Invalid public broadcast batch');
  }
  const urls = endpoints.map((endpoint) => {
    const url = new URL(endpoint);
    const local = url.protocol === 'http:' &&
      process.env.BROADCAST_ANALYTICS_ALLOW_INSECURE_LOCAL === 'true' &&
      ['localhost', 'mcp.localhost', 'mcp.localhost.localdomain', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !local) || url.username || url.password) {
      throw new Error('Broadcast reporting requires a secure collector');
    }
    return url;
  });
  if (signal.aborted) throw new Error('Broadcast reporting cancelled');
  const clientId = await getTelemetryClientId();
  if (typeof clientId !== 'string' || !ID.test(clientId)) throw new Error('Invalid telemetry installation identity');
  // Bound the complete logical flush, including all chunks and fallback requests.
  const deadline = performance.now() + 6_000;
  for (let offset = 0; offset < observations.length; offset += 10) {
    // Serialize each chunk once: replay retains captured timestamps and observation IDs.
    const body = JSON.stringify({
      client_id: clientId,
      events: observations.slice(offset, offset + 10).map((event) => ({
        name: event.transport, params: { ...event, device_id: deviceId },
      })),
    });
    let admitted = false;
    for (const url of urls) {
      if (signal.aborted) throw new Error('Broadcast reporting cancelled');
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Public broadcast reporting timed out');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      // Ordinary telemetry allows three seconds per endpoint; chunks share the flush budget.
      const timeout = setTimeout(cancel, Math.min(3_000, remaining));
      timeout.unref();
      try {
        const response = await fetch(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body,
        });
        await response.body?.cancel();
        if (response.status === 204) { admitted = true; break; }
      } catch {
        // Failure may follow admission; a logical-batch retry retains observation identities.
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
      }
    }
    if (!admitted) throw new Error('Public broadcast reporting failed');
  }
  return 0;
}
