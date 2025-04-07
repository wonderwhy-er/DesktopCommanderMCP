
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

/**
 * Executes a promise with a timeout. If the promise doesn't resolve or reject within
 * the specified timeout, returns the provided default value.
 * 
 * @param operation The promise to execute
 * @param timeoutMs Timeout in milliseconds
 * @param operationName Name of the operation (for logs)
 * @param defaultValue Value to return if the operation times out
 * @returns Promise that resolves with the operation result or the default value on timeout
 */
export function withTimeout<T>(
  operation: Promise<T>, 
  timeoutMs: number, 
  operationName: string,
  defaultValue: T
): Promise<T> {
  return new Promise((resolve) => {
    let isCompleted = false;
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!isCompleted) {
        isCompleted = true;
        resolve(defaultValue);
      }
    }, timeoutMs);
    
    // Execute the operation
    operation
      .then(result => {
        if (!isCompleted) {
          isCompleted = true;
          clearTimeout(timeoutId);
          resolve(result);
        }
      })
      .catch(error => {
        if (!isCompleted) {
          isCompleted = true;
          clearTimeout(timeoutId);
          resolve(defaultValue);
        }
      });
  });
}