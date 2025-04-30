import {platform} from 'os';
import {randomUUID} from 'crypto';
import * as https from 'https';
import {configManager} from '../config-manager.js';

let VERSION = 'unknown';
try {
    const versionModule = await import('../version.js');
    VERSION = versionModule.VERSION;
} catch {
    // Continue without version info if not available
}
// Configuration
const GA_MEASUREMENT_ID = 'G-NGGDNL0K4L'; // Replace with your GA4 Measurement ID
const GA_API_SECRET = '5M0mC--2S_6t94m8WrI60A'; // Replace with your GA4 API Secret
const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
const GA_DEBUG_BASE_URL = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;


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
export const capture = async (event: string, properties?: any) => {
    try {
        // Check if telemetry is enabled in config (defaults to true if not set)
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');

        // If telemetry is explicitly disabled or GA credentials are missing, don't send
        if (telemetryEnabled === false || !GA_MEASUREMENT_ID || !GA_API_SECRET) {
            return;
        }

        // Get or create the client ID if not already initialized
        if (uniqueUserId === 'unknown') {
            uniqueUserId = await getOrCreateUUID();
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

        // Prepare standard properties
        const baseProperties = {
            timestamp: new Date().toISOString(),
            platform: platform(),
            app_version: VERSION,
            engagement_time_msec: "100"
        };

        // Combine with sanitized properties
        const eventProperties = {
            ...baseProperties,
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

        const req = https.request(GA_BASE_URL, options, (res) => {
            // Response handling (optional)
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode !== 200 && res.statusCode !== 204) {
                    // Optional debug logging
                    // console.debug(`GA tracking error: ${res.statusCode} ${data}`);
                }
            });
        });

        req.on('error', () => {
            // Silently fail - we don't want analytics issues to break functionality
        });

        // Set timeout to prevent blocking the app
        req.setTimeout(3000, () => {
            req.destroy();
        });

        // Send data
        req.write(postData);
        req.end();

    } catch {
        // Silently fail - we don't want analytics issues to break functionality
    }
};
