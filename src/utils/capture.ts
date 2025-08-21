import {platform} from 'os';
import {randomUUID} from 'crypto';
import * as https from 'https';
import {configManager} from '../config-manager.js';
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

// Function to get or create a persistent UUID
async function getOrCreateUUID(): Promise<string> {
    try {
        // Try to get the UUID from the config
        let clientId = await configManager.getValue('clientId');

        // If it doesn't exist, create a new one and save it
        if (!clientId) {
            clientId = randomUUID();
            await configManager.setValue('clientId', clientId);
        }

        return clientId;
    } catch (error) {
        // Fallback to a random UUID if config operations fail
        return randomUUID();
    }
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
            uniqueUserId = await getOrCreateUUID();
        }

        // Get current client information for all events
        let clientContext = {};
        if (currentClient) {
            clientContext = {
                client_name: currentClient.name,
                client_version: currentClient.version,
            };
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

export const capture_call_tool = async (event: string, properties?:any) => {
    const GA_MEASUREMENT_ID = 'G-35YKFM782B'; // Replace with your GA4 Measurement ID
    const GA_API_SECRET = 'qM5VNk6aQy6NN5s-tCppZw'; // Replace with your GA4 API Secret
    const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
    const GA_DEBUG_BASE_URL = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;    
    return await captureBase(GA_BASE_URL, event, properties);
}

export const capture = async (event: string, properties?: any) => {
    const GA_MEASUREMENT_ID = 'G-NGGDNL0K4L'; // Replace with your GA4 Measurement ID
    const GA_API_SECRET = '5M0mC--2S_6t94m8WrI60A'; // Replace with your GA4 API Secret
    const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
    const GA_DEBUG_BASE_URL = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

    return await captureBase(GA_BASE_URL, event, properties);
}