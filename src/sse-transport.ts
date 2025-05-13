import { Transport, JSONRPCMessage } from "./transport-interface.js";
import express from "express";
import { Express, Request, Response } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { configManager } from "./config-manager.js";
import { capture } from "./utils/capture.js";
import { findAvailablePort } from "./utils/port-utils.js";
import { VERSION } from "./version.js";

/**
 * SSEServerTransport implementation for Desktop Commander MCP
 * Implements Server-Sent Events transport protocol according to MCP specification
 *
 * Initialization flow:
 * 1. Constructor sets up Express server and routes
 * 2. start() method is called to bind to a port and start listening (sets _isRunning=true)
 * 3. When MCP SDK connects to this transport, it calls setOnMessage() (only sets the callback)
 * 4. Client connects to SSE endpoint and gets a session_id
 * 5. Client sends initialize request which is always handled, even before MCP SDK is ready
 * 6. Server responds to initialize with 202 status and sends JSON-RPC response via SSE
 * 7. Client sends 'notifications/initialized' notification (sets _isReady=true)
 * 8. Other client requests are only processed when both _isRunning and _isReady are true
 * 9. If client sends non-initialize requests before server is ready,
 *    they get a 503 error with code -32002 indicating they should retry
 */
export class SSEServerTransport implements Transport {
  private app: Express;
  private server: any;
  private port: number;
  private clients: Map<string, { close: () => void }> = new Map();
  private responseMap = new Map<string, Response>(); // Store response objects for each session
  private onMessage: ((message: string) => Promise<void>) | null = null;
  private ssePath: string;
  private _isRunning: boolean = false;
  private _isReady: boolean = false; // Flag indicating if server is ready to receive non-initialize messages
  private messagesPath: string;

  // Store MCP protocol information
  private protocolVersion: string = "2024-11-05"; // Latest MCP protocol version
  private supportedClientCapabilities: any = {};

  /**
   * Create a new SSE transport
   * @param port The port to listen on
   * @param ssePath The path for SSE connections
   */
  constructor(port: number = 5000, ssePath: string = "/sse") {
    this.port = port;
    this.ssePath = ssePath;
    // Make sure ssePath doesn't have trailing slash
    this.ssePath = this.ssePath.endsWith("/")
      ? this.ssePath.slice(0, -1)
      : this.ssePath;

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
    this.app.get("/health", (req: Request, res: Response) => {
      res
        .status(200)
        .json({
          status: "ok",
          message: "Desktop Commander MCP Server is running",
        });
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
        throw new Error(
          `Failed to find an available port after ${maxRetries} retries`
        );
      }

      // If we found a different port than requested, log it
      if (availablePort !== this.port) {
        console.log(
          `Port ${this.port} is in use, using alternative port ${availablePort}`
        );
        this.port = availablePort;
      }

      // Now bind to the available port
      await this.bindToPort(this.port);
      this._isRunning = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to start SSE server: ${errorMsg}`);
      capture("sse_server_start_failed", { error: errorMsg });
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
          console.log(
            `SSE endpoint available at http://localhost:${port}${this.ssePath}`
          );
          console.log(
            `Messages endpoint at http://localhost:${port}${this.messagesPath}`
          );
          capture("sse_server_started", { port: port });
          resolve();
        });

        // Handle server errors
        this.server.on("error", (err: Error) => {
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
              console.error("Error closing SSE server:", err);
              reject(err);
            } else {
              console.log("SSE server stopped");
              this._isRunning = false;
              resolve();
            }
          });
        } catch (error) {
          console.error("Error during server shutdown:", error);
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
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Store the response object for later use
    this.responseMap.set(sessionId, res);

    // Add client to the map of active connections
    const client = {
      close: () => {
        res.end();
      },
    };
    this.clients.set(sessionId, client);

    // Build a full URL for the message endpoint according to MCP spec
    const fullEndpointUrl = `http://localhost:${this.port}${this.messagesPath}/?session_id=${sessionId}`;

    console.log(
      `Client ${sessionId} connected, sending endpoint: ${fullEndpointUrl}`
    );

    // Send endpoint as an SSE event following the MCP protocol
    // The event name must be 'endpoint' and the data must be just the URL
    res.write(`event: endpoint\ndata: ${fullEndpointUrl}\n\n`);

    // Handle client disconnect
    req.on("close", () => {
      console.log(`SSE client ${sessionId} disconnected`);
      this.clients.delete(sessionId);
      this.responseMap.delete(sessionId); // Clean up the response reference
      capture("sse_client_disconnected", { sessionId });
    });

    console.log(`SSE client ${sessionId} connected`);
    capture("sse_client_connected", { sessionId });
  }

  /**
   * Handle POST message from client
   */
  private async handlePostMessage(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.query.session_id as string;

      // Validate session ID
      if (!sessionId || !this.clients.has(sessionId)) {
        res.status(400).json({ error: "Invalid session ID" });
        capture("sse_invalid_session", { sessionId });
        return;
      }

      // Process the message - should be a JSON-RPC message
      const message = req.body;
      console.log("Received message:", JSON.stringify(message, null, 2));

      // Check if this is a special case: notifications/cancelled for an initialize request
      if (
        message.method === "notifications/cancelled" &&
        message.jsonrpc === "2.0" &&
        message.params &&
        message.params.requestId === 0
      ) {
        console.log(
          "Received initialize cancellation notification, sending 200 OK"
        );
        // Always respond with 200 OK for cancellation of initialize
        res.status(200).end();
        return;
      }

      // Check if this is the initialized notification from the client
      if (
        message.method === "notifications/initialized" &&
        message.jsonrpc === "2.0"
      ) {
        console.log(
          `Client ${sessionId} sent 'initialized' notification - now fully ready`
        );

        // Set the server as ready to receive messages
        this._isReady = true;

        // Log the ready state for debugging
        console.log(
          `Server ready state after initialized notification: _isRunning=${this._isRunning}, _isReady=${this._isReady}`
        );

        // Always respond with 200 OK for notifications
        res.status(200).end();
        capture("sse_initialized_notification_received", { sessionId });
        return;
      }

      // Check if this is an initialize request
      if (message.method === "initialize" && message.jsonrpc === "2.0") {
        // Handle initialization directly
        await this.handleInitializeRequest(sessionId, message, res);
        return;
      }

      // Check if this is a notification or system message
      const isNotification =
        message.jsonrpc === "2.0" && message.method && message.id === undefined;
      const isSystemMessage =
        message.jsonrpc === "2.0" &&
        message.method &&
        (message.method.startsWith("notifications/") ||
          message.method.startsWith("$/"));

      // Handle system messages differently - these don't need to go through the MCP SDK
      if (isSystemMessage) {
        // Log the system message with detailed information
        console.log(`Received system message: ${message.method}`);
        console.log(
          `System message details:
  - Has ID: ${message.id !== undefined}
  - ID value: ${message.id}
  - Is notification: ${isNotification}
  - Request params:`,
          JSON.stringify(message.params || {}, null, 2)
        );

        // For notifications without ID, we just return 200 OK without content
        if (message.id === undefined) {
          console.log(`Responding to notification with 200 OK (no content)`);
          res.status(200).end();
        } else {
          // For messages with ID, we need to return a proper JSON-RPC response
          const response = {
            jsonrpc: "2.0",
            id: message.id,
            result: null, // Success with null result
          };
          console.log(
            `Responding to system message with ID with:`,
            JSON.stringify(response, null, 2)
          );
          res.status(200).json(response);
        }

        capture("sse_system_message_received", {
          method: message.method,
          hasId: message.id !== undefined,
        });
        return;
      }

      // Forward other messages to the onMessage handler if server is ready
      if (this.onMessage && this._isReady) {
        console.log(
          `Forwarding message to MCP SDK handler: ${message.method} (ready=${
            this._isReady
          }, hasHandler=${!!this.onMessage})`
        );
        const messageStr = JSON.stringify(message);
        await this.onMessage(messageStr);
        res.status(200).json({ status: "ok" });
        capture("sse_message_received");
      } else {
        // If server isn't ready but this is a valid JSON-RPC message with an id
        // respond with a more specific error
        console.warn(
          "SSE transport received message before fully initialized:",
          JSON.stringify(message, null, 2)
        );
        console.warn(
          `Ready state: _isRunning=${this._isRunning}, _isReady=${
            this._isReady
          }, hasOnMessage=${!!this.onMessage}`
        );

        // For notifications (no id), we just return 200 OK to acknowledge receipt
        if (isNotification) {
          console.log(
            `Sending 200 OK for notification while not ready: ${message.method}`
          );
          res.status(200).end();
          return;
        }

        // For regular requests, return a proper error
        res.status(503).json({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32002, // Custom error code for "not ready yet"
            message: "Server initializing, please retry request",
          },
        });
        capture("sse_message_server_not_ready", {
          method: message.method,
          id: message.id,
          hasOnMessage: !!this.onMessage,
          isReady: this._isReady,
        });
      }
    } catch (error) {
      console.error("Error handling POST message:", error);
      res.status(500).json({ error: "Internal server error" });
      capture("sse_message_error", { error: String(error) });
    }
  }

  /**
   * Handle MCP initialize request
   * According to the MCP protocol, server should:
   * 1. Respond to initialize with 202 status code (empty body) for HTTP+SSE transport
   * 2. Send back the initialization response as a separate message
   * 3. Wait for the client to send the 'initialized' notification before sending other messages
   */
  private async handleInitializeRequest(
    sessionId: string,
    message: any,
    res: Response
  ): Promise<void> {
    try {
      // Extract client capabilities and protocol version
      const { protocolVersion, capabilities, clientInfo } =
        message.params || {};

      // Log initialization info
      console.log(`Client ${sessionId} initializing:`);
      console.log(`- Protocol Version: ${protocolVersion}`);
      console.log(`- Client: ${clientInfo?.name} v${clientInfo?.version}`);

      // Store this information
      this.protocolVersion = protocolVersion || this.protocolVersion;
      this.supportedClientCapabilities = capabilities || {};

      // Prepare server info to send back
      const serverInfo = {
        name: "Desktop Commander MCP",
        version: VERSION,
      };

      // Prepare server capabilities
      const serverCapabilities = {
        tools: {
          listChanged: true,
        },
        resources: {
          listChanged: true,
        },
      };

      // Create JSON-RPC response to be sent back as a separate message
      const initResponse = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          serverInfo,
          capabilities: serverCapabilities,
          protocolVersion: this.protocolVersion,
        },
      };

      // First, send 202 Accepted status with no content - this follows the MCP HTTP+SSE protocol
      res.status(202).end();

      // Then send the actual response as a separate message to the client via the SSE connection
      await this.sendMessage(JSON.stringify(initResponse));

      // Log success
      console.log(`Client ${sessionId} initialization response sent`);
      capture("sse_client_initialize_response_sent", {
        sessionId,
        protocolVersion,
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version,
      });
    } catch (error) {
      console.error("Error handling initialize request:", error);

      // In case of error, respond with a proper JSON-RPC error via the SSE channel
      const errorResponse = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603, // Internal error code
          message: `Failed to initialize: ${error}`,
        },
      };

      // Send error via SSE channel
      await this.sendMessage(JSON.stringify(errorResponse));

      // Also respond to the HTTP request with an error
      res.status(500).json(errorResponse);

      capture("sse_initialize_error", {
        sessionId,
        error: String(error),
      });
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  /**
   * Set the message handler callback
   * According to the MCP protocol, we should handle onMessage separately from readiness,
   * but the SDK expects this to set ready flag
   */
  setOnMessage(callback: (message: string) => Promise<void>): void {
    console.log(
      "SSE transport setOnMessage called - setting up message handler"
    );

    // Store the timestamp when onMessage is set
    const timestamp = new Date().toISOString();

    this.onMessage = callback;

    // For compatibility with the MCP SDK, which expects setOnMessage to make the transport ready
    // We'll set _isReady=true here too, even though the proper MCP flow is to wait for 'initialized'
    this._isReady = true;

    console.log(
      `SSE transport handler set at ${timestamp} - server is now ready to process messages`
    );
  }

  /**
   * Check if the server is running and ready to receive messages
   */
  isReady(): boolean {
    return this._isRunning && this._isReady;
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
