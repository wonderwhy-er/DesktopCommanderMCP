import WebSocket from 'ws';
import { logger } from './utils/logger.js';

export interface RemoteClientConfig {
  serverUrl: string;
  deviceToken: string;
  retryInterval?: number;
  maxRetries?: number;
}

export interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export class RemoteClient {
  private ws: WebSocket | null = null;
  private config: RemoteClientConfig;
  private isAuthenticated = false;
  private deviceId: string | null = null;
  private pendingRequests = new Map<string | number, {
    resolve: (value: MCPResponse) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: RemoteClientConfig) {
    this.config = {
      retryInterval: 5000,
      maxRetries: 5,
      ...config
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info(`Connecting to Remote MCP Server: ${this.config.serverUrl}`);
        this.ws = new WebSocket(this.config.serverUrl);

        this.ws.on('open', () => {
          logger.info('Connected to Remote MCP Server');
          this.reconnectAttempts = 0;
          
          // Send authentication
          this.sendMessage({
            id: 'auth-1',
            type: 'auth',
            payload: { deviceToken: this.config.deviceToken },
            timestamp: Date.now()
          });
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
            
            // Resolve connection promise on successful auth
            if (message.type === 'auth' && message.payload?.success && !this.isAuthenticated) {
              this.isAuthenticated = true;
              this.deviceId = message.payload.deviceId;
              logger.info(`Remote MCP authentication successful! Device ID: ${this.deviceId}`);
              resolve();
            }
          } catch (error) {
            logger.error('Error processing remote message:', error);
          }
        });

        this.ws.on('close', (code, reason) => {
          logger.info(`Remote MCP connection closed (${code}): ${reason}`);
          this.isAuthenticated = false;
          this.deviceId = null;
          this.handleReconnect();
        });

        this.ws.on('error', (error) => {
          logger.error('Remote MCP WebSocket error:', error.message);
          if (!this.isAuthenticated) {
            reject(new Error(`Failed to connect to Remote MCP Server: ${error.message}`));
          }
        });

        // Set up heartbeat
        setInterval(() => {
          if (this.isConnected()) {
            this.sendMessage({
              id: `heartbeat-${Date.now()}`,
              type: 'heartbeat',
              payload: { timestamp: Date.now() },
              timestamp: Date.now()
            });
          }
        }, 30000);

      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(message: any): void {
    if (message.type === 'mcp_response') {
      // Handle MCP response
      const request = this.pendingRequests.get(message.payload.id);
      if (request) {
        clearTimeout(request.timeout);
        this.pendingRequests.delete(message.payload.id);
        request.resolve(message.payload);
      }
    } else if (message.type === 'heartbeat') {
      // Respond to heartbeat
      this.sendMessage({
        id: message.id,
        type: 'heartbeat',
        payload: { timestamp: Date.now() },
        timestamp: Date.now()
      });
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= (this.config.maxRetries || 5)) {
      logger.error('Max reconnection attempts reached. Giving up.');
      return;
    }

    this.reconnectAttempts++;
    const delay = (this.config.retryInterval || 5000) * this.reconnectAttempts;
    
    logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error('Reconnection failed:', error);
        this.handleReconnect();
      }
    }, delay);
  }

  private sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  async sendMCPRequest(request: MCPRequest): Promise<MCPResponse> {
    if (!this.isConnected() || !this.isAuthenticated) {
      throw new Error('Remote MCP client not connected or authenticated');
    }

    return new Promise((resolve, reject) => {
      const requestId = `mcp-${Date.now()}-${Math.random()}`;
      
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('Remote MCP request timeout'));
      }, 30000); // 30 second timeout

      this.pendingRequests.set(request.id, {
        resolve,
        reject,
        timeout
      });

      // Send MCP request to remote server
      this.sendMessage({
        id: requestId,
        type: 'mcp_request',
        payload: request,
        timestamp: Date.now()
      });
    });
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.isAuthenticated;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Clear pending requests
    this.pendingRequests.forEach(({ timeout, reject }) => {
      clearTimeout(timeout);
      reject(new Error('Client disconnecting'));
    });
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isAuthenticated = false;
    this.deviceId = null;
  }

  getStatus(): { connected: boolean; authenticated: boolean; deviceId: string | null } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN || false,
      authenticated: this.isAuthenticated,
      deviceId: this.deviceId
    };
  }
}