import { Transport, JSONRPCMessage } from "./transport-interface.js";
import express from "express";
import { Express, Request, Response } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { configManager } from "./config-manager.js";
import { capture } from "./utils/capture.js";
import { findAvailablePort } from "./utils/port-utils.js";

/**
 * SSEServerTransport implementation for Desktop Commander MCP
 * Implements Server-Sent Events transport protocol according to MCP specification
 */
export class SSEServerTransport implements Transport {
  private app: Express;
  private server: any;
  private port: number;
  private clients: Map<
    string,
    { close: () => void }
  > = new Map();
  private responseMap = new Map<string, Response>(); // Store response objects for each session
  private onMessage: ((message: string) => Promise<void>) | null = null;
  private ssePath: string;
  private _isRunning: boolean = false;
  private messagesPath: string;

  /**
   * Create a new SSE transport
   * @param port The port to listen on
   * @param ssePath The path for SSE connections
   */
  constructor(port: number = 5000, ssePath: string = "/sse") {
    this.port = port;
    this.ssePath = ssePath;
    // Make sure ssePath doesn't have trailing slash
    this.ssePath = this.ssePath.endsWith('/') ? this.ssePath.slice(0, -1) : this.ssePath;

    // Set up messages path according to MCP SSE specification
    this.messagesPath = "/messages"; // Use root-level messages endpoint as per spec

    this.app = express();

    // Configure Express middleware
    this.app.use(cors());
    this.app.use(bodyParser.json());

    // Setup SSE endpoint
    this.app.get(this.ssePath, this.handleSSEConnection.bind(this));

    // Setup message endpoint for client-to-server communication
    this.app.post(this.messagesPath, this.handlePostMessage.bind(this));

    // Add basic health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', message: 'Desktop Commander MCP Server is running' });
    });
  }

  /**
   * Start the SSE server with auto port fallback
   * @param maxRetries Maximum number of alternative ports to try if the initial port is busy
   */
  async start(maxRetries: number = 5): Promise<void> {
    try {
      // First, try to find an available port using the port utility
      const availablePort = await findAvailablePort(this.port, maxRetries);

      if (!availablePort) {
        throw new Error(`Failed to find an available port after ${maxRetries} retries`);
      }

      // If we found a different port than requested, log it
      if (availablePort !== this.port) {
        console.log(`Port ${this.port} is in use, using alternative port ${availablePort}`);
        this.port = availablePort;
      }

      // Now bind to the available port
      await this.bindToPort(this.port);
      this._isRunning = true;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to start SSE server: ${errorMsg}`);
      capture('sse_server_start_failed', { error: errorMsg });
      throw error;
    }
  }

  /**
   * Bind the server to a specific port
   */
  private bindToPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, () => {
          console.log(`SSE transport server started on port ${port}`);
          console.log(`SSE endpoint available at http://localhost:${port}${this.ssePath}`);
          console.log(`Messages endpoint at http://localhost:${port}${this.messagesPath}`);
          capture('sse_server_started', { port: port });
          resolve();
        });

        // Handle server errors
        this.server.on('error', (err: Error) => {
          reject(err);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Stop the SSE server
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.responseMap.clear();

    // Close the server if it's running
    if (this.server && this._isRunning) {
      return new Promise((resolve, reject) => {
        try {
          this.server.close((err?: Error) => {
            if (err) {
              console.error('Error closing SSE server:', err);
              reject(err);
            } else {
              console.log('SSE server stopped');
              this._isRunning = false;
              resolve();
            }
          });
        } catch (error) {
          console.error('Error during server shutdown:', error);
          this._isRunning = false;
          resolve(); // Resolve anyway to allow cleanup to continue
        }
      });
    } else {
      // Server wasn't running, nothing to do
      return Promise.resolve();
    }
  }

  /**
   * Handle SSE connection request
   */
  private handleSSEConnection(req: Request, res: Response): void {
    const sessionId = this.generateSessionId();

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Store the response object for later use
    this.responseMap.set(sessionId, res);

    // Add client to the map of active connections
    const client = {
      close: () => {
        res.end();
      }
    };
    this.clients.set(sessionId, client);

    // Build a full URL for the message endpoint according to MCP spec
    const fullEndpointUrl = `http://localhost:${this.port}${this.messagesPath}/?session_id=${sessionId}`;

    console.log(`Client ${sessionId} connected, sending endpoint: ${fullEndpointUrl}`);

    // Send endpoint as an SSE event following the MCP protocol
    // The event name must be 'endpoint' and the data must be just the URL
    res.write(`event: endpoint\ndata: ${fullEndpointUrl}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`SSE client ${sessionId} disconnected`);
      this.clients.delete(sessionId);
      this.responseMap.delete(sessionId); // Clean up the response reference
      capture('sse_client_disconnected', { sessionId });
    });

    console.log(`SSE client ${sessionId} connected`);
    capture('sse_client_connected', { sessionId });
  }

  /**
   * Handle POST message from client
   */
  private async handlePostMessage(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.query.session_id as string;

      // Validate session ID
      if (!sessionId || !this.clients.has(sessionId)) {
        res.status(400).json({ error: 'Invalid session ID' });
        capture('sse_invalid_session', { sessionId });
        return;
      }

      // Process the message
      const message = req.body;

      if (this.onMessage) {
        const messageStr = JSON.stringify(message);
        await this.onMessage(messageStr);
        res.status(200).json({ status: 'ok' });
        capture('sse_message_received');
      } else {
        res.status(500).json({ error: 'Server not ready to receive messages' });
        capture('sse_server_not_ready');
      }
    } catch (error) {
      console.error('Error handling POST message:', error);
      res.status(500).json({ error: 'Internal server error' });
      capture('sse_message_error', { error: String(error) });
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 15) +
           Math.random().toString(36).substring(2, 15);
  }

  /**
   * Set the message handler callback
   */
  setOnMessage(callback: (message: string) => Promise<void>): void {
    this.onMessage = callback;
  }

  /**
   * Send a JSON-RPC message to all connected clients
   * Implements the Transport interface required by MCP SDK
   */
  async send(message: JSONRPCMessage): Promise<void> {
    // Convert to string for SSE
    const messageStr = JSON.stringify(message);

    // Send to all clients
    return this.sendMessage(messageStr);
  }

  /**
   * Close the transport - alias for stop()
   * Implements the Transport interface required by MCP SDK
   */
  async close(): Promise<void> {
    return this.stop();
  }

  /**
   * Send a message to all connected clients
   */
  async sendMessage(message: string): Promise<void> {
    // For SSE, we need to write directly to each client's response
    for (const [sessionId] of this.clients.entries()) {
      try {
        // Get the response object for this session
        const res = this.responseMap.get(sessionId);
        if (res) {
          // Send in SSE format: data: message\n\n
          res.write(`data: ${message}\n\n`);
        }
      } catch (error) {
        console.error(`Failed to send message to client ${sessionId}:`, error);
      }
    }
  }

  /**
   * Get the actual port the server is running on
   */
  getPort(): number {
    return this.port;
  }
}
