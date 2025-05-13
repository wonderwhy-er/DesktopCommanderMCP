import { Transport } from './transport-interface.js';
import { configManager } from './config-manager.js';
import { SSEServerTransport } from './sse-transport.js';
import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server } from './server.js';
import { capture } from './utils/capture.js';

/**
 * Parse command line arguments
 */
function parseArguments(): Record<string, any> {
  const args: Record<string, any> = {
    transport: 'stdio',
    ssePort: 5000,
    ssePath: '/sse',
    sseEnabled: false,
    sseMaxPortRetries: 5 // Maximum number of alternative ports to try
  };

  // Process command line arguments
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--transport' || arg === '-t') {
      if (i + 1 < process.argv.length) {
        args.transport = process.argv[++i];
      }
    } else if (arg === '--sse-port' || arg === '-p') {
      if (i + 1 < process.argv.length) {
        const portValue = parseInt(process.argv[++i], 10);
        if (!isNaN(portValue)) {
          args.ssePort = portValue;
        }
      }
    } else if (arg === '--sse-path') {
      if (i + 1 < process.argv.length) {
        args.ssePath = process.argv[++i];
      }
    } else if (arg === '--sse-enabled') {
      args.sseEnabled = true;
    } else if (arg === '--sse-no-port-fallback') {
      args.sseMaxPortRetries = 0; // Disable port fallback
    } else if (arg === '--sse-max-port-retries') {
      if (i + 1 < process.argv.length) {
        const retries = parseInt(process.argv[++i], 10);
        if (!isNaN(retries)) {
          args.sseMaxPortRetries = retries;
        }
      }
    }
  }

  return args;
}

/**
 * Create and configure transport based on configuration and CLI arguments
 */
export async function createTransport(): Promise<Transport> {
  // Parse command-line arguments
  const args = parseArguments();

  // Load configuration
  await configManager.loadConfig();
  const config = await configManager.getConfig();

  // Determine if SSE should be enabled
  const sseEnabled = args.sseEnabled || config.sseEnabled || false;

  // If SSE is enabled, create SSE transport
  if (sseEnabled || args.transport === 'sse') {
    const ssePort = args.ssePort || config.ssePort || 5000;
    const ssePath = args.ssePath || config.ssePath || '/sse';
    const maxPortRetries = args.sseMaxPortRetries ?? 5; // Default to 5 retries

    console.log(`Starting Desktop Commander with SSE transport on port ${ssePort} at path ${ssePath}`);

    try {
      // Create SSE transport
      const sseTransport = new SSEServerTransport(ssePort, ssePath);

      // Start the transport with port fallback
      await sseTransport.start(maxPortRetries);

      // Log the actual port that was used (may be different if fallback was used)
      const actualPort = sseTransport.getPort();
      if (actualPort !== ssePort) {
        console.log(`Using alternative port ${actualPort} due to port conflict`);
      }

      // Capture telemetry event if enabled
      if (config.telemetryEnabled !== false) {
        capture('server_start_sse', {
          requestedPort: ssePort,
          actualPort: actualPort,
          path: ssePath
        });
      }

      // Return the transport
      return sseTransport;
    } catch (error) {
      console.error('Failed to start SSE transport:', error);
      console.log('Falling back to stdio transport');
      capture('sse_fallback_to_stdio', {
        error: String(error)
      });
      return new FilteredStdioServerTransport();
    }
  } else {
    // Default to stdio transport
    console.log('Starting Desktop Commander with stdio transport');
    return new FilteredStdioServerTransport();
  }
}

/**
 * Handle server shutdown gracefully
 */
export async function shutdownTransport(transport: Transport): Promise<void> {
  if (transport instanceof SSEServerTransport) {
    try {
      console.log('Shutting down SSE server...');
      await transport.stop();
    } catch (error) {
      console.error('Error during shutdown:', error);
      // We still want to continue with the shutdown process
    }
  }
}
