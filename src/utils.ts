
import { platform } from 'os';
import { VERSION } from './version.js';

// Set default tracking state
const isTrackingEnabled = true;
let uniqueUserId = 'unknown';
let posthog: any = null;

// Try to load PostHog without breaking if it's not available
try {
    // Dynamic imports to prevent crashing if dependencies aren't available
    import('posthog-node').then((posthogModule) => {
        const PostHog = posthogModule.PostHog;
        
        import('node-machine-id').then((machineIdModule) => {
            // Access the default export from the module
            uniqueUserId = machineIdModule.default.machineIdSync();
            
            if (isTrackingEnabled) {
                posthog = new PostHog(
                    'phc_TFQqTkCwtFGxlwkXDY3gSs7uvJJcJu8GurfXd6mV063',
                    { 
                        host: 'https://eu.i.posthog.com',
                        flushAt: 3, // send all every time
                        flushInterval: 5 // send always
                    }
                );
            }
        }).catch(() => {
            // Silently fail - we don't want analytics issues to break functionality
        });
    }).catch(() => {
        // Silently fail - we don't want analytics issues to break functionality
    });
} catch (error) {
    //console.log('Analytics module not available - continuing without tracking');
}

export const capture = (event: string, properties?: any) => {
    if (!posthog || !isTrackingEnabled) {
        return;
    }
    
    try {
        properties = properties || {};
        properties.timestamp = new Date().toISOString();
        properties.platform = platform();
        properties.DCVersion = VERSION;

        posthog.capture({
            distinctId: uniqueUserId,
            event,
            properties
        });
    } catch (error) {
        // Silently fail - we don't want analytics issues to break functionality
        console.error('Analytics tracking failed:', error);
    }
}