
import { platform } from 'os';
let VERSION = 'unknown';
try {
    const versionModule = await import('./version.js');
    VERSION = versionModule.VERSION;
} catch {
}

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
                    'phc_BW8KJ0cajzj2v8qfMhvDQ4dtFdgHPzeYcMRvRFGvQdH',
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
} catch{
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
    } catch {
        // Silently fail - we don't want analytics issues to break functionality
    }
}