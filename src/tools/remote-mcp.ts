import { RemoteSSEClient, RemoteSSEClientConfig } from '../remote-sse-client.js';
import { logger } from '../utils/logger.js';

let remoteClient: RemoteSSEClient | null = null;

export async function connectRemoteMCP(serverUrl: string, deviceToken: string): Promise<{ success: boolean; message: string; status?: any }> {
  try {
    // Disconnect existing client if any
    if (remoteClient) {
      logger.info('Disconnecting existing remote MCP client');
      remoteClient.disconnect();
    }

    // Create new client
    const config: RemoteSSEClientConfig = {
      serverUrl,
      deviceToken,
      retryInterval: 5000,
      maxRetries: 3
    };

    logger.info(`Connecting to Remote MCP Server via SSE: ${serverUrl}`);
    remoteClient = new RemoteSSEClient(config);
    
    await remoteClient.connect();
    
    const status = remoteClient.getStatus();
    logger.info('Remote MCP connection successful', status);

    return {
      success: true,
      message: `Connected to Remote MCP Server via SSE successfully. Device ID: ${status.deviceId}`,
      status
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to connect to Remote MCP Server:', errorMessage);
    
    return {
      success: false,
      message: `Failed to connect to Remote MCP Server: ${errorMessage}`
    };
  }
}

export function disconnectRemoteMCP(): { success: boolean; message: string } {
  try {
    if (remoteClient) {
      logger.info('Disconnecting Remote MCP client');
      remoteClient.disconnect();
      remoteClient = null;
      
      return {
        success: true,
        message: 'Disconnected from Remote MCP Server'
      };
    } else {
      return {
        success: true,
        message: 'No active Remote MCP connection to disconnect'
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Error disconnecting Remote MCP:', errorMessage);
    
    return {
      success: false,
      message: `Error disconnecting Remote MCP: ${errorMessage}`
    };
  }
}

export function getRemoteMCPStatus(): { connected: boolean; authenticated: boolean; deviceId: string | null; message: string } {
  if (!remoteClient) {
    return {
      connected: false,
      authenticated: false,
      deviceId: null,
      message: 'No Remote MCP client initialized'
    };
  }

  const status = remoteClient.getStatus();
  
  let message = 'Remote MCP Status: ';
  if (status.connected && status.authenticated) {
    message += `Connected and authenticated. Device ID: ${status.deviceId}`;
  } else if (status.connected) {
    message += 'Connected but not authenticated';
  } else {
    message += 'Not connected';
  }

  return {
    connected: status.connected,
    authenticated: status.authenticated,
    deviceId: status.deviceId,
    message
  };
}

export async function executeRemoteMCP(method: string, params?: any): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    if (!remoteClient) {
      throw new Error('Remote MCP client not initialized. Use connect_remote_mcp first.');
    }

    if (!remoteClient.isConnectedAndAuthenticated()) {
      throw new Error('Remote MCP SSE client not connected or authenticated. Check connection status.');
    }

    logger.info(`Executing remote MCP method: ${method}`, { params });

    // Create MCP request
    const mcpRequest = {
      jsonrpc: '2.0',
      id: `remote-${Date.now()}-${Math.random()}`,
      method,
      params: params || {}
    };

    // Send request and wait for response
    const response = await remoteClient.sendMCPRequest(mcpRequest);
    
    if (response.error) {
      logger.error(`Remote MCP method ${method} failed:`, response.error);
      return {
        success: false,
        error: `Remote MCP error: ${response.error.message} (code: ${response.error.code})`
      };
    }

    logger.info(`Remote MCP method ${method} completed successfully`);
    return {
      success: true,
      result: response.result
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to execute remote MCP method ${method}:`, errorMessage);
    
    return {
      success: false,
      error: `Failed to execute remote MCP: ${errorMessage}`
    };
  }
}

// Cleanup function to disconnect on process exit
process.on('exit', () => {
  if (remoteClient) {
    remoteClient.disconnect();
  }
});

process.on('SIGINT', () => {
  if (remoteClient) {
    remoteClient.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (remoteClient) {
    remoteClient.disconnect();
  }
  process.exit(0);
});