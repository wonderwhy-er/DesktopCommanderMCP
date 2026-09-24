import { platform, homedir } from 'os';
import * as https from 'https';
import { AsyncLocalStorage } from 'async_hooks';
import { configManager, isTelemetryDisabledValue } from '../config-manager.js';
import { currentClient, currentCallIsRemote, currentRemoteClient } from '../server.js';

// Execution context for tool calls fired programmatically by the widget UIs
// (file preview, config editor), marked by args.origin === 'ui'. While code
// runs inside this context, capture() drops every event, so UI refresh churn
// (pull-by-path reads, in-preview saves, folder expansion, link search, ...)
// produces zero telemetry. AsyncLocalStorage (rather than a module-level flag)
// keeps attribution correct when a widget call interleaves with an agent call.
const uiOriginCallContext = new AsyncLocalStorage<boolean>();

export function runInUiOriginCallContext<T>(fn: () => T): T {
    return uiOriginCallContext.run(true, fn);
}

export function isInsideUiOriginCall(): boolean {
    return uiOriginCallContext.getStore() === true;
}

let VERSION = 'unknown';
try {
    const versionModule = await import('../version.js');
    VERSION = versionModule.VERSION;
} catch {
    // Continue without version info if not available
}

// Will be initialized when needed
let uniqueUserId = 'unknown';

// --- Telemetry Proxy (direct BigQuery ingestion) ---
// TODO: Move proxy endpoints, auth header setup, request retry/fallback, and
// transport code into a dedicated telemetry utility once this migration lands.
// TODO(security): bearer token was removed, so this endpoint is now unauthenticated.
// Confirm the proxy enforces rate limiting / payload validation server-side,
// otherwise anyone can POST arbitrary events straight into BigQuery ingestion.
const TELEMETRY_PROXY_URL = 'https://telemetry.desktopcommander.app/mp/collect';
const TELEMETRY_PROXY_FALLBACK_URL = 'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/mp/collect';

/**
 * Hard kill-switch for telemetry via environment variable.
 *
 * Independent of the persisted `telemetryEnabled` config so that tests, CI and
 * one-off runs can suppress all analytics without mutating the user's config.
 * Set DESKTOP_COMMANDER_DISABLE_TELEMETRY to 1/true/yes/on to disable.
 */
export function isTelemetryDisabledByEnv(): boolean {
    const raw = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    if (!raw) return false;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}


/**
 * Sanitizes error objects to remove potentially sensitive information like file paths
 * @param error Error object or string to sanitize
 * @returns An object with sanitized message and optional error code
 */
export function sanitizeError(error: any): { message: string, code?: string } {
    let errorMessage = '';
    let errorCode = undefined;

    if (error instanceof Error) {
        // Extract just the error name and message without stack trace
        errorMessage = error.name + ': ' + error.message;

        // Extract error code if available (common in Node.js errors)
        if ('code' in error) {
            errorCode = (error as any).code;
        }
    } else if (typeof error === 'string') {
        errorMessage = error;
    } else {
        errorMessage = 'Unknown error';
    }

    return {
        message: redactPaths(errorMessage),
        code: errorCode
    };
}

// Quoted text containing a separator is a path, whatever else it contains
// (Node quotes paths in fs errors: open 'C:\Users\John Smith\a.txt').
const QUOTED_PATH_PATTERN = /(['"`])(?:(?!\1)[^\r\n])*[\\/](?:(?!\1)[^\r\n])*\1/g;
// An unquoted path starts at a separator (optionally after a drive letter) and
// runs to whitespace or a quote. A space is part of it when more path follows
// (C:\Users\John Smith\a.txt), so no name fragment survives between two [PATH]s.
const PATH_PATTERN = /(?:[A-Za-z]:)?[\\/][^\s'"`]*(?: +[^\s'"`\\/]+[\\/][^\s'"`]*)*/g;

/**
 * Replaces every file path in a message with [PATH]. The home directory is
 * replaced first because it is the part that identifies the user, and it may
 * contain spaces that the generic pattern cannot attribute to a path.
 */
function redactPaths(message: string): string {
    const home = homedir();
    if (home && home.replace(/[\\/]/g, '').length > 0) {
        const homeSource = home.split(/[\\/]+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+') + '(?=[\\\\/\'"`\\s]|$)';
        message = message.replace(new RegExp(homeSource, platform() === 'win32' ? 'gi' : 'g'), '[PATH]');
    }
    return message
        .replace(QUOTED_PATH_PATTERN, '$1[PATH]$1')
        .replace(PATH_PATTERN, '[PATH]')
        .replace(/(?:\[PATH\])+/g, '[PATH]');
}

/**
 * Copies caller-supplied event properties into a telemetry-safe object.
 * The copy is deep so we never alter objects the caller keeps using (e.g. error
 * objects that are also returned to the AI). `error` is sanitized from the
 * ORIGINAL value: an Error's name, message and code are not enumerable, so the
 * JSON copy reduces it to {} and would report "Unknown error".
 */
function sanitizeEventProperties(properties?: any): Record<string, any> {
    let sanitizedProperties: any;
    try {
        sanitizedProperties = properties ? JSON.parse(JSON.stringify(properties)) : {};
    } catch {
        // Properties JSON can't copy (circular, BigInt) are dropped; the event itself is still sent
        sanitizedProperties = {};
    }

    const error = properties?.error;
    if (error && (typeof error === 'object' || typeof error === 'string')) {
        const sanitized = sanitizeError(error);
        sanitizedProperties.error = sanitized.message;
        if (sanitized.code) sanitizedProperties.errorCode = sanitized.code;
    }

    // Remove any properties that might contain paths
    const sensitiveKeys = ['path', 'filePath', 'directory', 'file_path', 'sourcePath', 'destinationPath', 'fullPath', 'rootPath'];
    for (const key of Object.keys(sanitizedProperties)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some(sk => lowerKey.includes(sk)) && lowerKey !== 'fileextension') { // keep fileExtension as it's safe
            delete sanitizedProperties[key];
        }
    }

    return sanitizedProperties;
}

/**
 * Send an event to telemetry
 * @param event Event name
 * @param properties Optional event properties
 */
// TODO(cleanup): captureBase is now dead code — no caller remains after the GA
// removal (only referenced in a comment). It still carries the full GA4-flavored
// send path. Remove it, or repurpose it as the shared proxy transport.
export const captureBase = async (captureURL: string, event: string, properties?: any) => {
    try {
        // Env kill-switch takes precedence over config (tests/CI).
        if (isTelemetryDisabledByEnv()) {
            return;
        }

        // Check if telemetry is enabled in config (defaults to true if not set)
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');

        // If telemetry is explicitly disabled or GA credentials are missing, don't send
        if (isTelemetryDisabledValue(telemetryEnabled) || !captureURL) {
            return;
        }

        // Get or create the client ID if not already initialized
        if (uniqueUserId === 'unknown') {
            uniqueUserId = await configManager.getOrCreateClientId();
        }

        // Get current client information for all events
        // For remote calls, attribute to the originating remote client (carried on
        // the tool call) instead of the device's local currentClient.
        const effectiveClient =
            currentCallIsRemote && currentRemoteClient ? currentRemoteClient : currentClient;
        let clientContext = {};
        if (effectiveClient) {
            clientContext = {
                client_name: effectiveClient.name,
                client_version: effectiveClient.version,
            };
        }

        // Track if user saw onboarding page
        const sawOnboardingPage = await configManager.getValue('sawOnboardingPage');
        if (sawOnboardingPage !== undefined) {
            clientContext = { ...clientContext, saw_onboarding_page: sawOnboardingPage };
        }

        const sanitizedProperties = sanitizeEventProperties(properties);

        // Is MCP installed with DXT
        let isDXT: string = 'false';
        if (process.env.MCP_DXT) {
            isDXT = 'true';
        }

        // Is MCP running in a container - use robust detection
        const { getSystemInfo } = await import('./system-info.js');
        const systemInfo = getSystemInfo();
        const isContainer: string = systemInfo.docker.isContainer ? 'true' : 'false';
        const containerType: string = systemInfo.docker.containerType || 'none';
        const orchestrator: string = systemInfo.docker.orchestrator || 'none';

        // Add container metadata (with privacy considerations)
        let containerName: string = 'none';
        let containerImage: string = 'none';

        if (systemInfo.docker.isContainer && systemInfo.docker.containerEnvironment) {
            const env = systemInfo.docker.containerEnvironment;

            // Container name - sanitize to remove potentially sensitive info
            if (env.containerName) {
                // Keep only alphanumeric chars, dashes, and underscores
                // Remove random IDs and UUIDs for privacy
                containerName = env.containerName
                    .replace(/[0-9a-f]{8,}/gi, 'ID')  // Replace long hex strings with 'ID'
                    .replace(/[0-9]{8,}/g, 'ID')      // Replace long numeric IDs with 'ID'
                    .substring(0, 50);                // Limit length
            }

            // Docker image - sanitize registry info for privacy
            if (env.dockerImage) {
                // Remove registry URLs and keep just image:tag format
                containerImage = env.dockerImage
                    .replace(/^[^/]+\/[^/]+\//, '')   // Remove registry.com/namespace/ prefix
                    .replace(/^[^/]+\//, '')          // Remove simple registry.com/ prefix
                    .replace(/@sha256:.*$/, '')       // Remove digest hashes
                    .substring(0, 100);               // Limit length
            }
        }

        // Detect if we're running through Smithery at runtime
        let runtimeSource: string = 'unknown';
        const processArgs = process.argv.join(' ');
        try {
            if (processArgs.includes('@smithery/cli') || processArgs.includes('smithery')) {
                runtimeSource = 'smithery-runtime';
            } else if (processArgs.includes('npx')) {
                runtimeSource = 'npx-runtime';
            } else {
                runtimeSource = 'direct-runtime';
            }
        } catch (error) {
            // Ignore detection errors
        }

        // Prepare standard properties
        const baseProperties = {
            timestamp: new Date().toISOString(),
            platform: platform(),
            isContainer,
            containerType,
            orchestrator,
            containerName,
            containerImage,
            runtimeSource,
            isDXT,
            app_version: VERSION,
            engagement_time_msec: "100"
        };

        // Combine with sanitized properties and client context
        const eventProperties = {
            ...baseProperties,
            ...clientContext,
            // Attribute events to the remote path when the in-flight tool call
            // came from a remote device. Placed before sanitizedProperties so an
            // explicit `remote` passed by the caller (e.g. captureRemote) wins.
            ...(currentCallIsRemote ? { remote: String(true) } : {}),
            ...sanitizedProperties
        };

        // Prepare telemetry payload
        const payload = {
            client_id: uniqueUserId,
            non_personalized_ads: false,
            timestamp_micros: Date.now() * 1000,
            events: [{
                name: event,
                params: eventProperties
            }]
        };

        // Send data to telemetry endpoint
        const postData = JSON.stringify(payload);

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(captureURL, options, (res) => {
            // Response handling (optional)
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                const success = res.statusCode === 200 || res.statusCode === 204;
                if (!success) {
                    // Optional debug logging
                    // console.debug(`Telemetry tracking error: ${res.statusCode} ${data}`);
                }
            });
        });

        req.on('error', (error) => {
            // Silently fail - we don't want analytics issues to break functionality
        });

        // Set timeout to prevent blocking the app
        req.setTimeout(3000, () => {
            req.destroy();
        });

        // Send data
        req.write(postData);
        req.end();

    } catch (error) {
        // Silently fail - we don't want analytics issues to break functionality
    }
};

/**
 * Build the standard event properties used by the telemetry proxy.
 * Extracted from captureBase so both paths get identical data.
 */
/** Builds the telemetry payload properties for an event, with paths and errors sanitized. */
export const buildEventProperties = async (properties?: any) => {
    if (uniqueUserId === 'unknown') {
        uniqueUserId = await configManager.getOrCreateClientId();
    }

    // For remote calls, attribute to the originating remote client (carried on
    // the tool call) instead of the device's local currentClient.
    const effectiveClient =
        currentCallIsRemote && currentRemoteClient ? currentRemoteClient : currentClient;
    let clientContext: any = {};
    if (effectiveClient) {
        clientContext = {
            client_name: effectiveClient.name,
            client_version: effectiveClient.version,
        };
    }

    const sawOnboardingPage = await configManager.getValue('sawOnboardingPage');
    if (sawOnboardingPage !== undefined) {
        clientContext.saw_onboarding_page = sawOnboardingPage;
    }

    const sanitizedProperties = sanitizeEventProperties(properties);

    let isDXT = 'false';
    if (process.env.MCP_DXT) isDXT = 'true';

    const { getSystemInfo } = await import('./system-info.js');
    const systemInfo = getSystemInfo();
    const isContainer = systemInfo.docker.isContainer ? 'true' : 'false';
    const containerType = systemInfo.docker.containerType || 'none';
    const orchestrator = systemInfo.docker.orchestrator || 'none';

    let containerName = 'none';
    let containerImage = 'none';
    if (systemInfo.docker.isContainer && systemInfo.docker.containerEnvironment) {
        const env = systemInfo.docker.containerEnvironment;
        if (env.containerName) {
            containerName = env.containerName
                .replace(/[0-9a-f]{8,}/gi, 'ID')
                .replace(/[0-9]{8,}/g, 'ID')
                .substring(0, 50);
        }
        if (env.dockerImage) {
            containerImage = env.dockerImage
                .replace(/^[^/]+\/[^/]+\//, '')
                .replace(/^[^/]+\//, '')
                .replace(/@sha256:.*$/, '')
                .substring(0, 100);
        }
    }

    let runtimeSource = 'unknown';
    try {
        const processArgs = process.argv.join(' ');
        if (processArgs.includes('@smithery/cli') || processArgs.includes('smithery')) {
            runtimeSource = 'smithery-runtime';
        } else if (processArgs.includes('npx')) {
            runtimeSource = 'npx-runtime';
        } else {
            runtimeSource = 'direct-runtime';
        }
    } catch { }

    return {
        timestamp: new Date().toISOString(),
        platform: platform(),
        isContainer,
        containerType,
        orchestrator,
        containerName,
        containerImage,
        runtimeSource,
        isDXT,
        app_version: VERSION,
        engagement_time_msec: "100",
        ...clientContext,
        // Attribute events to the remote path when the in-flight tool call
        // came from a remote device. Placed before sanitizedProperties so an
        // explicit `remote` passed by the caller (e.g. captureRemote) wins.
        ...(currentCallIsRemote ? { remote: String(true) } : {}),
        ...sanitizedProperties,
    };
};

/**
 * Send event to the telemetry proxy (direct BigQuery ingestion).
 * Uses the custom domain first and retries the generated Cloud Run URL on failure.
 */
const sendToTelemetryProxy = async (event: string, eventProperties: any) => {
    try {
        if (isTelemetryDisabledByEnv()) return;
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');
        if (isTelemetryDisabledValue(telemetryEnabled)) return;

        const payload = JSON.stringify({
            client_id: uniqueUserId,
            timestamp_micros: Date.now() * 1000,
            events: [{
                name: event,
                params: eventProperties
            }]
        });

        const sent = await postTelemetryPayload(TELEMETRY_PROXY_URL, payload);
        if (!sent) {
            await postTelemetryPayload(TELEMETRY_PROXY_FALLBACK_URL, payload);
        }
    } catch {
        // Silent fail — telemetry should never break functionality
    }
};

const postTelemetryPayload = async (endpoint: string, payload: string): Promise<boolean> => {
    return await new Promise((resolve) => {
        const url = new URL(endpoint);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300));
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
};

// TODO(behavior): capture() is now fire-and-forget — every `await capture(...)`
// call site resolves before the network send completes. Fine for the long-running
// MCP server, but events fired right before process exit (e.g. opt-out, feedback)
// can be silently dropped. If we need delivery guarantees on short-lived paths,
// expose an awaitable variant or flush-before-exit hook.
export const capture = async (event: string, properties?: any) => {
    // Tool calls fired programmatically by the widget UIs must produce zero
    // telemetry — drop every event raised while serving one.
    if (isInsideUiOriginCall()) {
        return;
    }
    void (async () => {
        try {
            const eventProperties = await buildEventProperties(properties);
            await sendToTelemetryProxy(event, eventProperties);
        } catch {
            // Silent fail — telemetry should never break functionality
        }
    })();
}

export const capture_call_tool = capture;
export const capture_ui_event = capture;

/**
 * Wrapper for capture() that automatically adds remote flag for remote-device telemetry
 * Also adds additional privacy filtering to remove sensitive identity information
 * @param event Event name
 * @param properties Optional event properties
 */
export const captureRemote = async (event: string, properties?: any) => {
    // Create a copy of properties to avoid mutating the original
    const sanitizedProps = properties ? { ...properties } : {};

    // Remove sensitive identity keys specific to remote devices
    const sensitiveIdentityKeys = ['deviceId', 'userId', 'email', 'user_id', 'device_id', 'user_email'];
    for (const key of sensitiveIdentityKeys) {
        if (key in sanitizedProps) {
            delete sanitizedProps[key];
        }
    }

    return await capture(event, {
        ...sanitizedProps,
        remote: String(true)
    });
}
