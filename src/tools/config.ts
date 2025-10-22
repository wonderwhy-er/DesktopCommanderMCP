import { configManager, ServerConfig } from '../config-manager.js';
import { SetConfigValueArgsSchema } from './schemas.js';
import { getSystemInfo } from '../utils/system-info.js';
import { currentClient } from '../server.js';
import { featureFlagManager } from '../utils/feature-flags.js';

/**
 * Get the entire config including system information
 */
export async function getConfig() {
  console.error('getConfig called');
  try {
    const config = await configManager.getConfig();
    
    // Add system information and current client to the config response
    const systemInfo = getSystemInfo();
    
    // Get memory usage
    const memoryUsage = process.memoryUsage();
    const memory = {
      rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`,
      arrayBuffers: `${(memoryUsage.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
    };
    
    const configWithSystemInfo = {
      ...config,
      currentClient,
      featureFlags: featureFlagManager.getAll(),
      systemInfo: {
        ...systemInfo,
        memory
      }
    };
    
    console.error(`getConfig result: ${JSON.stringify(configWithSystemInfo, null, 2)}`);
    return {
      content: [{
        type: "text",
        text: `Current configuration:\n${JSON.stringify(configWithSystemInfo, null, 2)}`
      }],
    };
  } catch (error) {
    console.error(`Error in getConfig: ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
    // Return empty config rather than crashing
    return {
      content: [{
        type: "text",
        text: `Error getting configuration: ${error instanceof Error ? error.message : String(error)}\nUsing empty configuration.`
      }],
    };
  }
}

/**
 * Set a specific config value
 */
export async function setConfigValue(args: unknown) {
  console.error(`setConfigValue called with args: ${JSON.stringify(args)}`);
  try {
    const parsed = SetConfigValueArgsSchema.safeParse(args);
    if (!parsed.success) {
      console.error(`Invalid arguments for set_config_value: ${parsed.error}`);
      return {
        content: [{
          type: "text",
          text: `Invalid arguments: ${parsed.error}`
        }],
        isError: true
      };
    }

    try {
      // Parse string values that should be arrays or objects
      let valueToStore = parsed.data.value;
      
      // If the value is a string that looks like an array or object, try to parse it
      if (typeof valueToStore === 'string' && 
          (valueToStore.startsWith('[') || valueToStore.startsWith('{'))) {
        try {
          valueToStore = JSON.parse(valueToStore);
          console.error(`Parsed string value to object/array: ${JSON.stringify(valueToStore)}`);
        } catch (parseError) {
          console.error(`Failed to parse string as JSON, using as-is: ${parseError}`);
        }
      }

      // Special handling for known array configuration keys
      if ((parsed.data.key === 'allowedDirectories' || parsed.data.key === 'blockedCommands') && 
          !Array.isArray(valueToStore)) {
        if (typeof valueToStore === 'string') {
          const originalString = valueToStore;
          try {
            const parsedValue = JSON.parse(originalString);
            valueToStore = parsedValue;
          } catch (parseError) {
            console.error(`Failed to parse string as array for ${parsed.data.key}: ${parseError}`);
            // If parsing failed and it's a single value, convert to an array with one item
            if (!originalString.includes('[')) {
              valueToStore = [originalString];
            }
          }
        } else if (valueToStore !== null) {
          // If not a string or array (and not null), convert to an array with one item
          valueToStore = [String(valueToStore)];
        }
        
        // Ensure the value is an array after all our conversions
        if (!Array.isArray(valueToStore)) {
          console.error(`Value for ${parsed.data.key} is still not an array, converting to array`);
          valueToStore = [String(valueToStore)];
        }
      }

      await configManager.setValue(parsed.data.key, valueToStore);
      // Get the updated configuration to show the user
      const updatedConfig = await configManager.getConfig();
      console.error(`setConfigValue: Successfully set ${parsed.data.key} to ${JSON.stringify(valueToStore)}`);
      return {
        content: [{
          type: "text",
          text: `Successfully set ${parsed.data.key} to ${JSON.stringify(valueToStore, null, 2)}\n\nUpdated configuration:\n${JSON.stringify(updatedConfig, null, 2)}`
        }],
      };
    } catch (saveError: any) {
      console.error(`Error saving config: ${saveError.message}`);
      // Continue with in-memory change but report error
      return {
        content: [{
          type: "text", 
          text: `Value changed in memory but couldn't be saved to disk: ${saveError.message}`
        }],
        isError: true
      };
    }
  } catch (error) {
    console.error(`Error in setConfigValue: ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
    return {
      content: [{
        type: "text",
        text: `Error setting value: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}