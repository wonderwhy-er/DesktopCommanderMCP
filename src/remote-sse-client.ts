import { logger } from './utils/logger.js';

export interface RemoteSSEClientConfig {
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

export class RemoteSSEClient {
  private eventSource: EventSource | null = null;
  private config: RemoteSSEClientConfig;
  private isConnected = false;
  private isAuthenticated = false;
  private deviceId: string | null = null;
  private pendingRequests = new Map<string | number, {
    resolve: (value: MCPResponse) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: RemoteSSEClientConfig) {
    this.config = {
      retryInterval: 5000,
      maxRetries: 5,
      ...config
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const sseUrl = `${this.config.serverUrl}/sse?deviceToken=${encodeURIComponent(this.config.deviceToken)}`;
        logger.info(`Connecting to Remote MCP Server via SSE: ${sseUrl}`);

        // Check if EventSource is available (Node.js environment needs polyfill)
        if (typeof EventSource === 'undefined') {
          // For Node.js environment, we'll use a different approach
          this.connectWithFetch(sseUrl, resolve, reject);
          return;
        }

        this.eventSource = new EventSource(sseUrl);

        this.eventSource.onopen = () => {
          logger.info('SSE connection opened');
          this.isConnected = true;
          this.reconnectAttempts = 0;
        };

        this.eventSource.onmessage = (event) => {
          this.handleSSEMessage('message', event.data);
        };

        this.eventSource.addEventListener('connected', (event) => {
          this.handleSSEMessage('connected', event.data);
          this.isAuthenticated = true;
          resolve();
        });

        this.eventSource.addEventListener('mcp_response', (event) => {
          this.handleSSEMessage('mcp_response', event.data);
        });

        this.eventSource.addEventListener('heartbeat', (event) => {
          this.handleSSEMessage('heartbeat', event.data);
        });

        this.eventSource.onerror = (event) => {
          logger.error('SSE connection error:', event);
          if (!this.isAuthenticated) {
            reject(new Error('Failed to connect to Remote MCP Server via SSE'));
          } else {
            this.handleReconnect();
          }
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  private async connectWithFetch(sseUrl: string, resolve: Function, reject: Function): Promise<void> {
    try {
      // For Node.js environment, use fetch with streaming
      const fetch = (await import('cross-fetch')).default;
      
      const response = await fetch(sseUrl, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info('SSE connection established via fetch');

      // Handle the readable stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No readable stream available');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      // Process the stream
      const processStream = async () => {
        while (this.isConnected) {
          try {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            
            // Process complete SSE messages
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            let eventType = 'message';
            let eventData = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.substring(7);
              } else if (line.startsWith('data: ')) {
                eventData = line.substring(6);
              } else if (line === '' && eventData) {
                // Complete event received
                this.handleSSEMessage(eventType, eventData);
                
                // Resolve on first successful connection
                if (eventType === 'connected' && !this.isAuthenticated) {
                  this.isAuthenticated = true;
                  resolve();
                }
                
                eventType = 'message';
                eventData = '';
              }
            }
          } catch (error) {
            logger.error('Error reading SSE stream:', error);
            break;
          }
        }
      };

      processStream().catch(error => {
        logger.error('SSE stream processing error:', error);
        if (!this.isAuthenticated) {
          reject(error);
        } else {
          this.handleReconnect();
        }
      });

    } catch (error) {
      reject(error);
    }
  }

  private handleSSEMessage(eventType: string, data: string): void {
    try {
      const message = JSON.parse(data);
      
      switch (eventType) {
        case 'connected':
          this.deviceId = message.deviceId;
          logger.info(`Remote MCP SSE authentication successful! Device ID: ${this.deviceId}`);
          break;
          
        case 'mcp_response':
          // This shouldn't happen in our architecture since the local agent sends responses directly
          // But we can handle it for completeness
          logger.info('Received unexpected mcp_response via SSE');
          break;
          
        case 'heartbeat':
          // Silent heartbeat handling
          break;
          
        default:
          logger.info(`Received SSE event: ${eventType}`, message);
      }
    } catch (error) {
      logger.error('Error processing SSE message:', error);
    }
  }

  async sendMCPRequest(request: MCPRequest): Promise<MCPResponse> {
    if (!this.isConnected || !this.isAuthenticated) {
      throw new Error('Remote MCP SSE client not connected or authenticated');
    }

    // In the SSE architecture, we don't send requests directly via SSE
    // Instead, we send them via HTTP POST to the server's MCP endpoint
    return new Promise(async (resolve, reject) => {
      try {
        const fetch = (await import('cross-fetch')).default;
        
        const response = await fetch(`${this.config.serverUrl}/api/mcp/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.deviceToken}`
          },
          body: JSON.stringify({
            deviceToken: this.config.deviceToken,
            request: request
          })
        });

        if (!response.ok) {
          throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        resolve(result);

      } catch (error) {
        reject(error);
      }
    });
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= (this.config.maxRetries || 5)) {
      logger.error('Max SSE reconnection attempts reached. Giving up.');
      return;
    }

    this.isConnected = false;
    this.isAuthenticated = false;
    
    this.reconnectAttempts++;
    const delay = (this.config.retryInterval || 5000) * this.reconnectAttempts;
    
    logger.info(`Attempting to reconnect SSE in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error('SSE reconnection failed:', error);
        this.handleReconnect();
      }
    }, delay);
  }

  isConnectedAndAuthenticated(): boolean {
    return this.isConnected && this.isAuthenticated;
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

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    
    this.isConnected = false;
    this.isAuthenticated = false;
    this.deviceId = null;
  }

  getStatus(): { connected: boolean; authenticated: boolean; deviceId: string | null } {
    return {
      connected: this.isConnected,
      authenticated: this.isAuthenticated,
      deviceId: this.deviceId
    };
  }
}