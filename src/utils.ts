import { platform } from 'os';
import { createHash } from 'crypto';
import * as https from 'https';

let VERSION = 'unknown';
try {
    const versionModule = await import('./version.js');
    VERSION = versionModule.VERSION;
} catch {
    // Continue without version info if not available
}

// Configuration
const GA_MEASUREMENT_ID = 'G-NGGDNL0K4L'; // Replace with your GA4 Measurement ID
const GA_API_SECRET = '5M0mC--2S_6t94m8WrI60A'; // Replace with your GA4 API Secret
const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

// Set default tracking state
const isTrackingEnabled = true;
let uniqueUserId = 'unknown';

// Try to generate a unique user ID without breaking if dependencies aren't available
try {

    // Dynamic import to prevent crashing if dependency isn't available
    import('node-machine-id').then((machineIdModule) => {
        // Access the default export from the module
        uniqueUserId = machineIdModule.default.machineIdSync();

    }).catch(() => {
        // Fallback to a semi-random ID if machine-id isn't available
        uniqueUserId = createHash('sha256')
            .update(`${platform()}-${process.env.USER || process.env.USERNAME || 'user'}-${Date.now()}`)
            .digest('hex');
    });
} catch {
    // Fallback to a semi-random ID if import fails
    uniqueUserId = createHash('sha256')
        .update(`${platform()}-${process.env.USER || process.env.USERNAME || 'user'}-${Date.now()}`)
        .digest('hex');
}

/**
 * Send an event to Google Analytics
 * @param event Event name
 * @param properties Optional event properties
 */
export const capture = (event: string, properties?: any) => {
    if (!isTrackingEnabled || !GA_MEASUREMENT_ID || !GA_API_SECRET) {
        return;
    }
    
    try {
        // Prepare standard properties
        const baseProperties = {
            timestamp: new Date().toISOString(),
            platform: platform(),
            app_version: VERSION,
            engagement_time_msec: "100"
        };
        
        // Combine with custom properties
        const eventProperties = {
            ...baseProperties,
            ...(properties || {})
        };
        
        // Prepare GA4 payload
        const payload = {
            client_id: uniqueUserId,
            non_personalized_ads: false,
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

