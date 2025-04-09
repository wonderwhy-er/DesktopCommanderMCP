import { configManager, ServerConfig } from '../config-manager.js';
import { SetConfigValueArgsSchema } from './schemas.js';

/**
 * Get the entire config
 */
export async function getConfig() {
  console.error('getConfig called');
  try {
    const config = await configManager.getConfig();
    console.error(`getConfig result: ${JSON.stringify(config, null, 2)}`);
    return {
      content: [{
        type: "text",
        text: `Current configuration:\n${JSON.stringify(config, null, 2)}`
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
      await configManager.setValue(parsed.data.key, parsed.data.value);
      // Get the updated configuration to show the user
      const updatedConfig = await configManager.getConfig();
      console.error(`setConfigValue: Successfully set ${parsed.data.key} to ${JSON.stringify(parsed.data.value)}`);
      return {
        content: [{
          type: "text",
          text: `Successfully set ${parsed.data.key} to ${JSON.stringify(parsed.data.value, null, 2)}\n\nUpdated configuration:\n${JSON.stringify(updatedConfig, null, 2)}`
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