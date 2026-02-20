import { platform } from 'os';
import * as https from 'https';
import { configManager } from '../config-manager.js';
import { currentClient } from '../server.js';

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
const TELEMETRY_PROXY_URL = 'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/mp/collect';
const TELEMETRY_PROXY_TOKEN = 'Od44UB_fTrVfGPGRPLr5QdVgFhuKdiGaBmvazTdxVdQ';


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

    // Remove any file paths using regex
    // This pattern matches common path formats including Windows and Unix-style paths
    errorMessage = errorMessage.replace(/(?:\/|\\)[\w\d_.-\/\\]+/g, '[PATH]');
    errorMessage = errorMessage.replace(/[A-Za-z]:\\[\w\d_.-\/\\]+/g, '[PATH]');

    return {
        message: errorMessage,
        code: errorCode
    };
}


/**
 * Send an event to Google Analytics
 * @param event Event name
 * @param properties Optional event properties
 */
export const captureBase = async (captureURL: string, event: string, properties?: any) => {
    try {
        // Check if telemetry is enabled in config (defaults to true if not set)
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');

        // If telemetry is explicitly disabled or GA credentials are missing, don't send
        if (telemetryEnabled === false || !captureURL) {
            return;
        }

        // Get or create the client ID if not already initialized
        if (uniqueUserId === 'unknown') {
            uniqueUserId = await configManager.getOrCreateClientId();
        }

        // Get current client information for all events
        let clientContext = {};
        if (currentClient) {
            clientContext = {
                client_name: currentClient.name,
                client_version: currentClient.version,
            };
        }

        // Track if user saw onboarding page
        const sawOnboardingPage = await configManager.getValue('sawOnboardingPage');
        if (sawOnboardingPage !== undefined) {
            clientContext = { ...clientContext, saw_onboarding_page: sawOnboardingPage };
        }

        // Create a deep copy of properties to avoid modifying the original objects
        // This ensures we don't alter error objects that are also returned to the AI
        let sanitizedProperties;
        try {
            sanitizedProperties = properties ? JSON.parse(JSON.stringify(properties)) : {};
        } catch (e) {
            sanitizedProperties = {}
        }

        // Sanitize error objects if present
        if (sanitizedProperties.error) {
            // Handle different types of error objects
            if (typeof sanitizedProperties.error === 'object' && sanitizedProperties.error !== null) {
                const sanitized = sanitizeError(sanitizedProperties.error);
                sanitizedProperties.error = sanitized.message;
                if (sanitized.code) {
                    sanitizedProperties.errorCode = sanitized.code;
                }
            } else if (typeof sanitizedProperties.error === 'string') {
                sanitizedProperties.error = sanitizeError(sanitizedProperties.error).message;
            }
        }

        // Remove any properties that might contain paths
        const sensitiveKeys = ['path', 'filePath', 'directory', 'file_path', 'sourcePath', 'destinationPath', 'fullPath', 'rootPath'];
        for (const key of Object.keys(sanitizedProperties)) {
            const lowerKey = key.toLowerCase();
            if (sensitiveKeys.some(sensitiveKey => lowerKey.includes(sensitiveKey)) &&
                lowerKey !== 'fileextension') { // keep fileExtension as it's safe
                delete sanitizedProperties[key];
            }
        }

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
            ...sanitizedProperties
        };

        // Prepare GA4 payload
        const payload = {
            client_id: uniqueUserId,
            non_personalized_ads: false,
            timestamp_micros: Date.now() * 1000,
            events: [{
                name: event,
                params: eventProperties
            }]
        };

        // Send data to Google Analytics
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
                    // console.debug(`GA tracking error: ${res.statusCode} ${data}`);
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
 * Build the standard event properties used by both GA4 and the telemetry proxy.
 * Extracted from captureBase so both paths get identical data.
 */
const buildEventProperties = async (properties?: any) => {
    if (uniqueUserId === 'unknown') {
        uniqueUserId = await configManager.getOrCreateClientId();
    }

    let clientContext: any = {};
    if (currentClient) {
        clientContext = {
            client_name: currentClient.name,
            client_version: currentClient.version,
        };
    }

    const sawOnboardingPage = await configManager.getValue('sawOnboardingPage');
    if (sawOnboardingPage !== undefined) {
        clientContext.saw_onboarding_page = sawOnboardingPage;
    }

    let sanitizedProperties: any;
    try {
        sanitizedProperties = properties ? JSON.parse(JSON.stringify(properties)) : {};
    } catch {
        sanitizedProperties = {};
    }

    if (sanitizedProperties.error) {
        if (typeof sanitizedProperties.error === 'object' && sanitizedProperties.error !== null) {
            const sanitized = sanitizeError(sanitizedProperties.error);
            sanitizedProperties.error = sanitized.message;
            if (sanitized.code) sanitizedProperties.errorCode = sanitized.code;
        } else if (typeof sanitizedProperties.error === 'string') {
            sanitizedProperties.error = sanitizeError(sanitizedProperties.error).message;
        }
    }

    const sensitiveKeys = ['path', 'filePath', 'directory', 'file_path', 'sourcePath', 'destinationPath', 'fullPath', 'rootPath'];
    for (const key of Object.keys(sanitizedProperties)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some(sk => lowerKey.includes(sk)) && lowerKey !== 'fileextension') {
            delete sanitizedProperties[key];
        }
    }

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
        ...sanitizedProperties,
    };
};

/**
 * Send event to the telemetry proxy (direct BigQuery ingestion).
 * Runs in parallel with GA4 — used for high-volume events to avoid
 * the 1M/day GA4 BigQuery export limit.
 */
const sendToTelemetryProxy = async (event: string, eventProperties: any) => {
    try {
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');
        if (telemetryEnabled === false) return;

        const payload = JSON.stringify({
            client_id: uniqueUserId,
            timestamp_micros: Date.now() * 1000,
            events: [{
                name: event,
                params: eventProperties
            }]
        });

        const url = new URL(TELEMETRY_PROXY_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TELEMETRY_PROXY_TOKEN}`,
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            res.resume(); // drain response
        });
        req.on('error', () => { }); // silent fail
        req.setTimeout(3000, () => req.destroy());
        req.write(payload);
        req.end();
    } catch {
        // Silent fail — telemetry should never break functionality
    }
};

export const capture_call_tool = async (event: string, properties?: any) => {
    // Old property (G-8L163XZ1CE) — keeps lower-volume tool events
    const GA_OLD_ID = 'G-8L163XZ1CE';
    const GA_OLD_SECRET = 'hNxh4TK2TnSy4oLZn4RwTA';
    const GA_OLD_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_OLD_ID}&api_secret=${GA_OLD_SECRET}`;

    // New property (dc_high_volume) — receives highest-volume tool events to avoid 1M/day BQ export limit
    const GA_NEW_ID = 'G-ZDF1M5403Z';
    const GA_NEW_SECRET = 'cUEilpa0SpWfc2UjblDtKQ';
    const GA_NEW_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_NEW_ID}&api_secret=${GA_NEW_SECRET}`;

    // Route highest-volume tools to new property, rest to old
    const HIGH_VOLUME_TOOLS = ['start_process',  'track_ui_event'];
    const toolName = properties?.name;
    const gaUrl = HIGH_VOLUME_TOOLS.includes(toolName) ? GA_NEW_URL : GA_OLD_URL;

    // Build properties once, send to GA4 + telemetry proxy in parallel
    const eventProperties = await buildEventProperties(properties);
    await Promise.all([
        captureBase(gaUrl, event, properties),                 // GA4 (routed by tool name)
        sendToTelemetryProxy(event, eventProperties),          // direct BigQuery (all events)
    ]);
}

export const capture = async (event: string, properties?: any) => {
    const GA_MEASUREMENT_ID = 'G-F3GK01G39Y';
    const GA_API_SECRET = 'SqdcIAweSQS1RQErURMdEA';
    const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

    // Build properties once, send to both GA4 and telemetry proxy in parallel
    const eventProperties = await buildEventProperties(properties);
    await Promise.all([
        captureBase(GA_BASE_URL, event, properties),           // existing GA4
        sendToTelemetryProxy(event, eventProperties),          // new: direct BigQuery
    ]);
}

export const capture_ui_event = async (event: string, properties?: any) => {
    const GA_MEASUREMENT_ID = 'G-MPFSWEGQ0T';
    const GA_API_SECRET = 'BeK3uyAOQ6-TK6wnaDG2Ww';
    const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
    return await captureBase(GA_BASE_URL, event, properties);
}

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