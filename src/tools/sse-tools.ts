import { ServerResult } from "../types.js";
import { configManager } from "../config-manager.js";
import { capture } from "../utils/capture.js";
import { SSEConfigArgs } from "./sse-config.js";

/**
 * Handles configuration of the SSE transport
 */
export async function configureSSE(args: SSEConfigArgs): Promise<ServerResult> {
  try {
    const { action, port, path } = args;
    const config = await configManager.getConfig();
    let result = "";

    switch (action) {
      case "status":
        // Return current SSE configuration status
        const enabled = config.sseEnabled === true;
        const currentPort = config.ssePort || 3000;
        const currentPath = config.ssePath || "/sse";

        result = `SSE Transport Status:
- Enabled: ${enabled ? "Yes" : "No"}
- Port: ${currentPort}
- Path: ${currentPath}
- URL (when enabled): http://localhost:${currentPort}${currentPath}`;

        capture("sse_status_check");
        break;

      case "enable":
        // Enable SSE transport
        await configManager.setValue("sseEnabled", true);

        // Update port if provided
        if (port !== undefined) {
          await configManager.setValue("ssePort", port);
        }

        // Update path if provided
        if (path !== undefined) {
          await configManager.setValue("ssePath", path);
        }

        const enabledPort = port || config.ssePort || 3000;
        const enabledPath = path || config.ssePath || "/sse";

        result = `SSE Transport Enabled:
- Port: ${enabledPort}
- Path: ${enabledPath}
- URL: http://localhost:${enabledPort}${enabledPath}

NOTE: You need to restart the server for this change to take effect.
Run restart action to apply changes immediately: sse_config({ "action": "restart" })`;

        capture("sse_transport_enabled", {
          port: enabledPort,
          path: enabledPath,
        });
        break;

      case "disable":
        // Disable SSE transport
        await configManager.setValue("sseEnabled", false);

        result = `SSE Transport Disabled.

NOTE: You need to restart the server for this change to take effect.
Run restart action to apply changes immediately: sse_config({ "action": "restart" })`;

        capture("sse_transport_disabled");
        break;

      case "restart":
        // This will only change the configuration values
        // The actual server restart will need to be handled by the user
        // or through a more complex mechanism like spawning a new process

        // Update config if port or path are provided
        if (port !== undefined) {
          await configManager.setValue("ssePort", port);
        }

        if (path !== undefined) {
          await configManager.setValue("ssePath", path);
        }

        const restartEnabled = config.sseEnabled === true;
        const restartPort = port || config.ssePort || 3000;
        const restartPath = path || config.ssePath || "/sse";

        result = `SSE Transport configuration updated:
- Enabled: ${restartEnabled ? "Yes" : "No"}
- Port: ${restartPort}
- Path: ${restartPath}

NOTE: The server needs to be restarted manually for these changes to take effect.
You need to exit Claude and restart the Desktop Commander for changes to apply.`;

        capture("sse_config_restart_requested", {
          enabled: restartEnabled,
          port: restartPort,
          path: restartPath,
        });
        break;
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture("sse_config_error", { error: errorMessage });

    return {
      content: [
        {
          type: "text",
          text: `Error configuring SSE transport: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}
