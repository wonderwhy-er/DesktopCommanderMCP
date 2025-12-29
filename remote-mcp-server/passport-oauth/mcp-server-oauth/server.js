#!/usr/bin/env node

/**
 * MCP Server with SSE and Built-in OAuth Authentication
 * 
 * This implements a production-ready MCP server that:
 * - Provides /sse endpoint for direct Claude Desktop connection
 * - Uses MCP SDK's mcpAuthRouter for automatic OAuth handling
 * - Integrates with our existing passport-oauth server
 * - Follows MCP Authorization specification
 * - Triggers browser auth automatically before tool calls
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema,
  InitializeRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PassportOAuthProvider } from './oauth-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Bearer token authentication middleware
 */
function authenticateBearer(oauthProvider) {
  return async (req, res, next) => {
    const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
    const endpoint = req.path;
    
    console.log(`[Auth] 🔐 Authentication attempt for ${endpoint} from ${clientIP}`);
    
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log(`[Auth] ❌ No Bearer token provided`);
        console.log(`[Auth] 📋 Available headers:`, Object.keys(req.headers));
        console.log(`[Auth] 🌐 Client User-Agent:`, req.headers['user-agent'] || 'unknown');
        console.log(`[Auth] 📡 Request Method:`, req.method);
        console.log(`[Auth] 🎯 Request URL:`, req.url);
        
        const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
        
        // Set proper WWW-Authenticate HTTP header (RFC 6750)
        const wwwAuthenticateHeader = `Bearer realm="MCP Server", authorization_uri="${oauthServerUrl}/authorize", error="invalid_request", error_description="Bearer token required for MCP SSE endpoint"`;
        res.set('WWW-Authenticate', wwwAuthenticateHeader);
        
        console.log(`[Auth] 🔧 Setting WWW-Authenticate header:`, wwwAuthenticateHeader);
        
        const challenge = {
          error: 'unauthorized',
          error_description: 'Bearer token required for MCP SSE endpoint',
          oauth_authorization_url: `${oauthServerUrl}/authorize`,
          oauth_discovery_url: `${oauthServerUrl}/.well-known/oauth-authorization-server`,
          oauth_registration_url: `${oauthServerUrl}/register`,
          // MCP specific OAuth info
          mcp_oauth_flow: 'authorization_code_pkce',
          mcp_scopes_required: ['mcp:tools'],
          mcp_specification: '2024-11-05'
        };
        
        console.log(`[Auth] 🔄 Sending OAuth challenge response:`, JSON.stringify(challenge, null, 2));
        console.log(`[Auth] 🌍 Expected redirect to:`, `${oauthServerUrl}/authorize`);
        console.log(`[Auth] 🔍 If Claude Desktop doesn't redirect, check MCP protocol compliance`);
        
        return res.status(401).json(challenge);
      }

      const token = authHeader.substring(7); // Remove 'Bearer '
      console.log(`[Auth] 🔍 Validating Bearer token: ${token.substring(0, 20)}...`);
      
      // Validate token with OAuth provider
      const tokenData = await oauthProvider.validateToken(token);
      console.log(`[Auth] 📊 Token validation result:`, JSON.stringify({
        active: tokenData.active,
        client_id: tokenData.client_id,
        sub: tokenData.sub,
        scope: tokenData.scope,
        exp: tokenData.exp
      }, null, 2));
      
      if (!tokenData.active) {
        console.log(`[Auth] ❌ Token is not active`);
        
        const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
        const wwwAuthenticateHeader = `Bearer realm="MCP Server", authorization_uri="${oauthServerUrl}/authorize", error="invalid_token", error_description="Token is not active or expired"`;
        res.set('WWW-Authenticate', wwwAuthenticateHeader);
        
        console.log(`[Auth] 🔧 Setting WWW-Authenticate header for inactive token:`, wwwAuthenticateHeader);
        
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'Token is not active or expired',
          oauth_authorization_url: `${oauthServerUrl}/authorize`
        });
      }

      console.log(`[Auth] ✅ Authentication successful for user: ${tokenData.sub}`);

      // Attach token data to request
      req.oauth = tokenData;
      next();

    } catch (error) {
      console.error(`[Auth] ❌ Token validation failed:`, error.message);
      console.error(`[Auth] 🔍 Error details:`, error);
      
      const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
      const wwwAuthenticateHeader = `Bearer realm="MCP Server", authorization_uri="${oauthServerUrl}/authorize", error="invalid_token", error_description="Token validation failed"`;
      res.set('WWW-Authenticate', wwwAuthenticateHeader);
      
      console.log(`[Auth] 🔧 Setting WWW-Authenticate header for validation error:`, wwwAuthenticateHeader);
      
      res.status(401).json({
        error: 'invalid_token',
        error_description: error.message,
        oauth_authorization_url: `${oauthServerUrl}/authorize`
      });
    }
  };
}

/**
 * SSE Transport implementation for MCP
 */
class SSETransport {
  constructor() {
    this.connections = new Map(); // connectionId -> { res, lastHeartbeat }
    this.messageHandlers = new Map();
    
    // Heartbeat every 30 seconds
    setInterval(() => this.sendHeartbeat(), 30000);
    
    // Cleanup stale connections every 5 minutes
    setInterval(() => this.cleanupConnections(), 5 * 60 * 1000);
  }

  /**
   * Handle SSE connection
   */
  handleConnection(req, res) {
    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    console.log(`[SSE] 🔌 New connection attempt from ${clientIP}`);
    console.log(`[SSE] 📱 User-Agent: ${userAgent}`);
    console.log(`[SSE] 🔑 OAuth User: ${req.oauth?.sub || 'none'}`);
    console.log(`[SSE] 📋 Headers:`, JSON.stringify({
      authorization: req.headers.authorization ? '***Bearer token present***' : 'none',
      host: req.headers.host,
      origin: req.headers.origin,
      'accept': req.headers.accept,
      'cache-control': req.headers['cache-control']
    }, null, 2));
    
    // Set SSE headers
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control, Authorization',
      'X-MCP-Version': '2024-11-05',
      'X-Connection-ID': connectionId
    };
    
    console.log(`[SSE] 📤 Setting response headers:`, JSON.stringify(headers, null, 2));
    res.writeHead(200, headers);

    // Store connection
    this.connections.set(connectionId, {
      res,
      lastHeartbeat: Date.now(),
      oauth: req.oauth,
      clientIP,
      userAgent,
      connectedAt: new Date().toISOString()
    });

    console.log(`[SSE] ✅ Connection established: ${connectionId}`);
    console.log(`[SSE] 📊 Total active connections: ${this.connections.size}`);

    // Send initial connected event
    const connectData = {
      connectionId,
      timestamp: new Date().toISOString(),
      user_id: req.oauth?.sub,
      server: 'mcp-server-oauth',
      version: '1.0.0'
    };
    
    console.log(`[SSE] 🚀 Sending connected event:`, JSON.stringify(connectData, null, 2));
    this.sendEvent(connectionId, 'connected', connectData);

    // Handle client disconnect
    req.on('close', () => {
      const connection = this.connections.get(connectionId);
      console.log(`[SSE] 🔌 Connection closed: ${connectionId}`);
      console.log(`[SSE] ⏰ Connection duration: ${connection ? Date.now() - new Date(connection.connectedAt).getTime() : 'unknown'}ms`);
      console.log(`[SSE] 📊 Remaining connections: ${this.connections.size - 1}`);
      this.connections.delete(connectionId);
    });

    req.on('error', (error) => {
      console.error(`[SSE] ❌ Connection error: ${connectionId}`, error.message);
      console.error(`[SSE] 🔍 Error details:`, error);
      console.log(`[SSE] 📊 Remaining connections: ${this.connections.size - 1}`);
      this.connections.delete(connectionId);
    });

    res.on('error', (error) => {
      console.error(`[SSE] ❌ Response error: ${connectionId}`, error.message);
      this.connections.delete(connectionId);
    });

    return connectionId;
  }

  /**
   * Handle MCP message over SSE
   */
  async handleMessage(connectionId, message) {
    console.log(`[SSE] 📨 Received message from ${connectionId}`);
    console.log(`[SSE] 📝 Message content:`, JSON.stringify(message, null, 2));
    
    try {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        console.error(`[SSE] ❌ Connection not found: ${connectionId}`);
        throw new Error('Connection not found');
      }

      // Parse JSON-RPC message
      const request = typeof message === 'string' ? JSON.parse(message) : message;
      console.log(`[SSE] 🔄 Parsed JSON-RPC request:`, JSON.stringify(request, null, 2));
      
      // Validate JSON-RPC format
      if (!request.jsonrpc || request.jsonrpc !== '2.0') {
        console.error(`[SSE] ❌ Invalid JSON-RPC version: ${request.jsonrpc}`);
        throw new Error('Invalid JSON-RPC version');
      }

      // Get handler for method
      const handler = this.messageHandlers.get(request.method);
      if (!handler) {
        console.error(`[SSE] ❌ Unknown method: ${request.method}`);
        console.log(`[SSE] 📋 Available methods:`, Array.from(this.messageHandlers.keys()));
        throw new Error(`Unknown method: ${request.method}`);
      }

      console.log(`[SSE] ✅ Found handler for method: ${request.method}`);

      // Execute handler
      const result = await handler(request.params, connection.oauth);

      // Send response
      const response = {
        jsonrpc: '2.0',
        id: request.id,
        result
      };

      this.sendEvent(connectionId, 'message', response);

    } catch (error) {
      console.error('[SSE] Message handling error:', error);
      
      const errorResponse = {
        jsonrpc: '2.0',
        id: message.id || null,
        error: {
          code: -32603,
          message: error.message
        }
      };

      this.sendEvent(connectionId, 'error', errorResponse);
    }
  }

  /**
   * Send SSE event
   */
  sendEvent(connectionId, event, data) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const eventData = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    
    try {
      connection.res.write(eventData);
      connection.lastHeartbeat = Date.now();
    } catch (error) {
      console.error(`[SSE] Failed to send event to ${connectionId}:`, error);
      this.connections.delete(connectionId);
    }
  }

  /**
   * Send heartbeat to all connections
   */
  sendHeartbeat() {
    for (const [connectionId] of this.connections) {
      this.sendEvent(connectionId, 'heartbeat', {
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Cleanup stale connections
   */
  cleanupConnections() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    for (const [connectionId, connection] of this.connections) {
      if (now - connection.lastHeartbeat > timeout) {
        console.log(`[SSE] Cleaning up stale connection: ${connectionId}`);
        try {
          connection.res.end();
        } catch (error) {
          // Ignore errors when closing stale connections
        }
        this.connections.delete(connectionId);
      }
    }
  }

  /**
   * Register message handler
   */
  setMessageHandler(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  /**
   * Get connection stats
   */
  getStats() {
    return {
      total_connections: this.connections.size,
      connections: Array.from(this.connections.entries()).map(([id, conn]) => ({
        id,
        user_id: conn.oauth?.sub,
        last_heartbeat: new Date(conn.lastHeartbeat).toISOString()
      }))
    };
  }
}

/**
 * Main MCP Server with OAuth
 */
class MCPServerWithOAuth {
  constructor() {
    console.log(`[MCP OAuth] 🔧 Initializing MCP Server with OAuth...`);
    
    // Configuration
    this.port = parseInt(process.env.MCP_OAUTH_PORT) || 3005;
    this.httpsPort = parseInt(process.env.MCP_OAUTH_HTTPS_PORT) || 3006;
    this.host = process.env.MCP_OAUTH_HOST || 'localhost';
    this.enableHttps = process.env.ENABLE_HTTPS === 'true';
    
    // OAuth configuration
    this.oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
    this.mcpServerUrl = this.enableHttps 
      ? process.env.MCP_OAUTH_BASE_URL || `https://${this.host}:${this.httpsPort}`
      : process.env.MCP_OAUTH_BASE_URL || `http://${this.host}:${this.port}`;

    // Log configuration
    console.log(`[MCP OAuth] ⚙️  Configuration:`);
    console.log(`[MCP OAuth] 📊 HTTP Port: ${this.port}`);
    console.log(`[MCP OAuth] 🔒 HTTPS Port: ${this.httpsPort}`);
    console.log(`[MCP OAuth] 🌐 Host: ${this.host}`);
    console.log(`[MCP OAuth] 🔐 HTTPS Enabled: ${this.enableHttps}`);
    console.log(`[MCP OAuth] 🔗 OAuth Server: ${this.oauthServerUrl}`);
    console.log(`[MCP OAuth] 📡 MCP Server URL: ${this.mcpServerUrl}`);

    // Check certificates if HTTPS is enabled
    if (this.enableHttps) {
      const certPath = path.join(__dirname, '../certs/server.crt');
      const keyPath = path.join(__dirname, '../certs/server.key');
      console.log(`[MCP OAuth] 🔍 Checking certificates...`);
      console.log(`[MCP OAuth] 📜 Cert path: ${certPath}`);
      console.log(`[MCP OAuth] 🔑 Key path: ${keyPath}`);
      console.log(`[MCP OAuth] ✅ Cert exists: ${fs.existsSync(certPath)}`);
      console.log(`[MCP OAuth] ✅ Key exists: ${fs.existsSync(keyPath)}`);
    }
    
    // Initialize components
    this.oauthProvider = new PassportOAuthProvider({
      oauthServerUrl: this.oauthServerUrl,
      mcpServerUrl: this.mcpServerUrl
    });
    
    this.sseTransport = new SSETransport();
    
    // Create MCP server
    this.server = new Server(
      {
        name: 'mcp-server-oauth',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
    console.log(`[MCP OAuth] Server initializing...`);
    console.log(`[MCP OAuth] OAuth Server: ${this.oauthServerUrl}`);
    console.log(`[MCP OAuth] MCP Server: ${this.mcpServerUrl}`);
  }

  /**
   * Setup MCP message handlers
   */
  setupHandlers() {
    // Initialize handler
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      console.log('[MCP] Initialize request received');
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'mcp-server-oauth',
          version: '1.0.0'
        }
      };
    });

    // Tools list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      console.log('[MCP] Tools list requested');
      
      return {
        tools: [
          {
            name: 'oauth_status',
            description: 'Get OAuth authentication status and server info',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'test_tool',
            description: 'Test tool that requires OAuth authentication',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Test message to echo back'
                }
              },
              required: ['message']
            }
          },
          {
            name: 'connection_stats',
            description: 'Get SSE connection statistics',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      };
    });

    // Tool call handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      console.log(`[MCP] Tool call: ${name}`);

      switch (name) {
        case 'oauth_status':
          return await this.handleOAuthStatus();
          
        case 'test_tool':
          return await this.handleTestTool(args);
          
        case 'connection_stats':
          return await this.handleConnectionStats();
          
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });

    // Register SSE handlers
    this.sseTransport.setMessageHandler('initialize', async (params, oauth) => {
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-oauth', version: '1.0.0' }
      };
    });

    this.sseTransport.setMessageHandler('tools/list', async (params, oauth) => {
      const response = await this.server.handleRequest({ 
        jsonrpc: '2.0', 
        id: 1, 
        method: 'tools/list', 
        params 
      });
      return response.result;
    });

    this.sseTransport.setMessageHandler('tools/call', async (params, oauth) => {
      const response = await this.server.handleRequest({ 
        jsonrpc: '2.0', 
        id: 1, 
        method: 'tools/call', 
        params 
      });
      return response.result;
    });
  }

  /**
   * Handle OAuth status tool
   */
  async handleOAuthStatus() {
    const metadata = this.oauthProvider.getMetadata();
    
    return {
      content: [
        {
          type: 'text',
          text: `🔐 OAuth Status Report\n\n` +
                `Server: MCP Server with OAuth\n` +
                `Version: 1.0.0\n` +
                `Endpoint: ${this.mcpServerUrl}/sse\n\n` +
                `OAuth Configuration:\n` +
                `- Authorization Server: ${metadata.authorization_server}\n` +
                `- PKCE Required: ${metadata.pkce_required}\n` +
                `- Supported Scopes: ${metadata.scopes_supported.join(', ')}\n` +
                `- Grant Types: ${metadata.grant_types_supported.join(', ')}\n\n` +
                `✅ OAuth authentication is working!\n` +
                `🌊 SSE connections: ${this.sseTransport.connections.size}`
        }
      ]
    };
  }

  /**
   * Handle test tool
   */
  async handleTestTool(args) {
    const { message = 'Hello from MCP OAuth server!' } = args;
    
    return {
      content: [
        {
          type: 'text',
          text: `✅ Test tool executed successfully!\n\n` +
                `Message: ${message}\n` +
                `Timestamp: ${new Date().toISOString()}\n` +
                `Server: ${this.mcpServerUrl}\n\n` +
                `🔐 This tool required OAuth authentication to execute.`
        }
      ]
    };
  }

  /**
   * Handle connection stats tool
   */
  async handleConnectionStats() {
    const stats = this.sseTransport.getStats();
    
    return {
      content: [
        {
          type: 'text',
          text: `📊 SSE Connection Statistics\n\n` +
                `Total Connections: ${stats.total_connections}\n\n` +
                `Active Connections:\n` +
                stats.connections.map(conn => 
                  `- ${conn.id} (user: ${conn.user_id || 'unknown'}, last: ${conn.last_heartbeat})`
                ).join('\n') || 'No active connections'
        }
      ]
    };
  }

  /**
   * Start the server
   */
  async start() {
    const app = express();

    // CORS configuration
    app.use(cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Parse JSON
    app.use(express.json());

    // Security headers
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-MCP-Version', '2024-11-05');
      next();
    });

    // Basic request logging
    app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
      next();
    });

    // Comprehensive Request/Response logging middleware
    app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const startTime = Date.now();
      
      // Log incoming request with all details
      console.log(`\n🔵 [${timestamp}] INCOMING REQUEST [${requestId}]`);
      console.log(`📍 ${req.method} ${req.url}`);
      console.log(`🌐 Client: ${req.ip || req.connection?.remoteAddress || 'unknown'}`);
      console.log(`📱 User-Agent: ${req.headers['user-agent'] || 'unknown'}`);
      
      // Log headers (filter sensitive data)
      const safeHeaders = { ...req.headers };
      if (safeHeaders.authorization) {
        const authHeader = safeHeaders.authorization;
        if (authHeader.startsWith('Bearer ')) {
          safeHeaders.authorization = `Bearer ${authHeader.substring(7, 27)}...`;
        }
      }
      console.log(`📋 Headers:`, JSON.stringify(safeHeaders, null, 2));
      
      // Log query parameters
      if (Object.keys(req.query).length > 0) {
        console.log(`🔍 Query:`, JSON.stringify(req.query, null, 2));
      }
      
      // Log request body (for POST/PUT requests)
      if (req.body && Object.keys(req.body).length > 0) {
        console.log(`📝 Body:`, JSON.stringify(req.body, null, 2));
      }

      // Override res.send and res.json to capture response data
      const originalSend = res.send;
      const originalJson = res.json;
      let responseBody = null;
      let responseType = 'unknown';

      res.send = function(data) {
        responseBody = data;
        responseType = 'send';
        return originalSend.call(this, data);
      };

      res.json = function(data) {
        responseBody = data;
        responseType = 'json';
        return originalJson.call(this, data);
      };

      // Log response when finished
      res.on('finish', () => {
        const endTime = Date.now();
        const duration = endTime - startTime;
        const statusCode = res.statusCode;
        const statusEmoji = statusCode >= 400 ? '🔴' : statusCode >= 300 ? '🟡' : '🟢';
        
        console.log(`\n${statusEmoji} [${new Date().toISOString()}] RESPONSE [${requestId}]`);
        console.log(`📊 Status: ${statusCode} ${res.statusMessage || ''}`);
        console.log(`⏱️  Duration: ${duration}ms`);
        
        // Log response headers
        const responseHeaders = res.getHeaders();
        if (Object.keys(responseHeaders).length > 0) {
          console.log(`📤 Response Headers:`, JSON.stringify(responseHeaders, null, 2));
        }
        
        // Log response body (with size limit and JSON formatting)
        if (responseBody !== null) {
          try {
            const bodyString = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
            const bodySize = Buffer.byteLength(bodyString, 'utf8');
            
            console.log(`📦 Response Type: ${responseType}`);
            console.log(`📏 Response Size: ${bodySize} bytes`);
            
            // Limit response body logging to avoid huge logs
            if (bodySize > 2000) {
              const truncated = bodyString.substring(0, 2000) + '...[truncated]';
              console.log(`📄 Response Body (truncated):`, truncated);
            } else {
              // Pretty print JSON responses
              try {
                const parsedBody = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
                console.log(`📄 Response Body:`, JSON.stringify(parsedBody, null, 2));
              } catch (e) {
                console.log(`📄 Response Body:`, bodyString);
              }
            }
          } catch (error) {
            console.log(`📄 Response Body: [Error logging response: ${error.message}]`);
          }
        }
        
        console.log(`─────────────────────────────────────────────────────────────`);
      });

      next();
    });

    // OAuth callback endpoint
    app.get('/oauth/callback', async (req, res) => {
      await this.oauthProvider.handleCallback(req, res);
    });

    // MCP authorization metadata endpoint
    app.get('/.well-known/mcp-server', (req, res) => {
      res.json({
        version: '2025-06-18', // Support Claude Desktop's expected protocol version
        server: {
          name: 'mcp-server-oauth',
          version: '1.0.0'
        },
        capabilities: {
          tools: {},
          logging: {}
        },
        transport: {
          sse: {
            endpoint: '/sse',
            authentication_required: true,
            methods: ['GET', 'POST'] // Support both GET (SSE) and POST (JSON-RPC)
          }
        },
        authentication: {
          type: 'oauth2',
          ...this.oauthProvider.getMetadata()
        }
      });
    });

    // OAuth discovery endpoint
    app.get('/oauth/discovery', (req, res) => {
      res.json(this.oauthProvider.getMetadata());
    });

    // RFC 8414 - OAuth 2.0 Authorization Server Metadata (proxy to actual OAuth server)
    app.get('/.well-known/oauth-authorization-server', async (req, res) => {
      try {
        console.log(`[OAuth Discovery] 🔍 Authorization server metadata requested`);
        
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`${this.oauthServerUrl}/.well-known/oauth-authorization-server`);
        
        if (!response.ok) {
          throw new Error(`OAuth server metadata unavailable: ${response.status}`);
        }
        
        const metadata = await response.json();
        console.log(`[OAuth Discovery] ✅ Proxying authorization server metadata`);
        
        res.json(metadata);
        
      } catch (error) {
        console.error('[OAuth Discovery] ❌ Authorization server discovery failed:', error.message);
        
        res.status(503).json({
          error: 'service_unavailable',
          error_description: 'OAuth authorization server discovery failed',
          details: error.message
        });
      }
    });

    // RFC 8705 - OAuth 2.0 Protected Resource Metadata
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      console.log(`[OAuth Discovery] 🔍 Protected resource metadata requested`);
      
      const baseUrl = this.mcpServerUrl || `http://localhost:${this.port}`;
      
      const metadata = {
        // Resource server identity
        resource: baseUrl,
        authorization_servers: [this.oauthServerUrl],
        
        // Supported scopes for this protected resource
        scopes_supported: [
          'mcp:tools',
          'mcp:admin', 
          'openid',
          'profile',
          'email'
        ],
        
        // Bearer token methods supported
        bearer_methods_supported: [
          'header'  // Authorization: Bearer <token>
        ],
        
        // MCP-specific metadata
        mcp_specification_version: '2025-06-18',
        mcp_server_info: {
          name: 'mcp-server-oauth',
          version: '1.0.0'
        },
        
        // Supported MCP transports with authentication requirements
        mcp_transports: [
          {
            type: 'sse',
            endpoint: '/sse',
            authentication_required: true,
            methods: ['GET', 'POST']
          }
        ],
        
        // OAuth client registration info
        client_registration: {
          endpoint: `${this.oauthServerUrl}/register`,
          supported: true
        },
        
        // Resource capabilities requiring authentication
        capabilities: [
          'tools',
          'logging',
          'sse_streaming'
        ]
      };
      
      console.log(`[OAuth Discovery] ✅ Sending protected resource metadata`);
      res.json(metadata);
    });

    // Debug endpoint for troubleshooting
    app.get('/debug', (req, res) => {
      res.json({
        server: 'mcp-server-oauth',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        config: {
          https_enabled: this.enableHttps,
          http_port: this.port,
          https_port: this.httpsPort,
          host: this.host,
          oauth_server: this.oauthServerUrl,
          mcp_server_url: this.mcpServerUrl
        },
        connections: {
          active_sse_connections: this.sseTransport.connections.size,
          connection_details: Array.from(this.sseTransport.connections.entries()).map(([id, conn]) => ({
            id,
            connected_at: conn.connectedAt,
            client_ip: conn.clientIP,
            user_agent: conn.userAgent,
            user_id: conn.oauth?.sub
          }))
        },
        endpoints: {
          sse: '/sse',
          message: '/message',
          metadata: '/.well-known/mcp-server',
          health: '/health',
          debug: '/debug',
          oauth_callback: '/oauth/callback',
          oauth_discovery: '/oauth/discovery'
        }
      });
    });

    // SSE endpoint with authentication (GET for SSE connection)
    app.get('/sse', 
      (req, res, next) => {
        console.log(`[Server] 🌊 SSE endpoint accessed (GET)`);
        console.log(`[Server] 🔗 Client: ${req.ip || 'unknown'}`);
        console.log(`[Server] 📱 User-Agent: ${req.headers['user-agent'] || 'unknown'}`);
        next();
      },
      authenticateBearer(this.oauthProvider), 
      (req, res) => {
        console.log(`[Server] ✅ Authentication passed, establishing SSE connection`);
        const connectionId = this.sseTransport.handleConnection(req, res);
        console.log(`[Server] 🆔 Connection ID: ${connectionId}`);
        
        // Handle incoming messages (if any - typically via POST)
        req.on('data', async (chunk) => {
          try {
            console.log(`[Server] 📨 Received data on SSE connection: ${chunk.toString()}`);
            const message = JSON.parse(chunk.toString());
            await this.sseTransport.handleMessage(connectionId, message);
          } catch (error) {
            console.error('[Server] ❌ Message parsing error:', error);
          }
        });
      }
    );

    // SSE endpoint for MCP JSON-RPC messages (POST for protocol messages)
    app.post('/sse', authenticateBearer(this.oauthProvider), async (req, res) => {
      try {
        console.log(`[Server] 📨 MCP message received via POST /sse`);
        console.log(`[Server] 🔗 Client: ${req.ip || 'unknown'}`);
        console.log(`[Server] 📱 User-Agent: ${req.headers['user-agent'] || 'unknown'}`);
        
        const request = req.body;
        console.log(`[Server] 📝 MCP Request:`, JSON.stringify(request, null, 2));
        
        // Validate JSON-RPC
        if (!request.jsonrpc || request.jsonrpc !== '2.0') {
          console.log(`[Server] ❌ Invalid JSON-RPC version: ${request.jsonrpc}`);
          return res.status(400).json({
            jsonrpc: '2.0',
            id: request.id || null,
            error: {
              code: -32600,
              message: 'Invalid Request',
              data: 'JSON-RPC version must be 2.0'
            }
          });
        }

        let response;

        // Handle different MCP methods
        switch (request.method) {
          case 'initialize':
            console.log(`[Server] 🚀 Handling initialize request`);
            console.log(`[Server] 📋 Protocol Version: ${request.params?.protocolVersion}`);
            console.log(`[Server] 👤 Client Info:`, JSON.stringify(request.params?.clientInfo, null, 2));
            
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: '2025-06-18', // Support the version Claude Desktop expects
                capabilities: {
                  tools: {},
                  logging: {}
                },
                serverInfo: {
                  name: 'mcp-server-oauth',
                  version: '1.0.0'
                },
                instructions: 'MCP Server with OAuth 2.1 authentication ready for tool calls.'
              }
            };
            break;

          case 'tools/list':
            console.log(`[Server] 🛠️  Handling tools/list request`);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                tools: [
                  {
                    name: 'oauth_status',
                    description: 'Check OAuth authentication status and server configuration',
                    inputSchema: {
                      type: 'object',
                      properties: {},
                      required: []
                    }
                  },
                  {
                    name: 'test_tool',
                    description: 'Test tool that requires OAuth authentication',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        message: {
                          type: 'string',
                          description: 'Test message to echo back'
                        }
                      },
                      required: ['message']
                    }
                  },
                  {
                    name: 'connection_stats',
                    description: 'Get SSE connection statistics',
                    inputSchema: {
                      type: 'object',
                      properties: {},
                      required: []
                    }
                  }
                ]
              }
            };
            break;

          case 'tools/call':
            console.log(`[Server] ⚡ Handling tools/call request for: ${request.params?.name}`);
            const toolName = request.params?.name;
            const toolArgs = request.params?.arguments || {};

            switch (toolName) {
              case 'oauth_status':
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({
                          oauth_server: this.oauthServerUrl,
                          authenticated: true,
                          user_id: req.oauth?.sub,
                          client_id: req.oauth?.client_id,
                          scope: req.oauth?.scope,
                          server_info: {
                            name: 'mcp-server-oauth',
                            version: '1.0.0',
                            protocol_version: '2025-06-18'
                          }
                        }, null, 2)
                      }
                    ]
                  }
                };
                break;

              case 'test_tool':
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: `Echo: ${toolArgs.message || 'No message provided'}\n\nAuthenticated as: ${req.oauth?.sub || 'unknown'}\nClient: ${req.oauth?.client_id || 'unknown'}`
                      }
                    ]
                  }
                };
                break;

              case 'connection_stats':
                const stats = {
                  active_connections: this.sseTransport.connections.size,
                  server_uptime: process.uptime(),
                  memory_usage: process.memoryUsage(),
                  connections: Array.from(this.sseTransport.connections.entries()).map(([id, conn]) => ({
                    id,
                    connected_at: conn.connectedAt,
                    client_ip: conn.clientIP,
                    user_agent: conn.userAgent
                  }))
                };

                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(stats, null, 2)
                      }
                    ]
                  }
                };
                break;

              default:
                console.log(`[Server] ❌ Unknown tool: ${toolName}`);
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  error: {
                    code: -32601,
                    message: 'Method not found',
                    data: `Unknown tool: ${toolName}`
                  }
                };
            }
            break;

          default:
            console.log(`[Server] ❌ Unknown method: ${request.method}`);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: 'Method not found',
                data: `Unknown method: ${request.method}`
              }
            };
        }

        console.log(`[Server] 📤 Sending response:`, JSON.stringify(response, null, 2));
        res.json(response);

      } catch (error) {
        console.error('[Server] ❌ MCP message handling error:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          }
        });
      }
    });

    // HTTP message endpoint for MCP requests
    app.post('/message', authenticateBearer(this.oauthProvider), async (req, res) => {
      try {
        const request = req.body;
        
        // Validate JSON-RPC
        if (!request.jsonrpc || request.jsonrpc !== '2.0') {
          return res.status(400).json({
            jsonrpc: '2.0',
            id: request.id || null,
            error: {
              code: -32600,
              message: 'Invalid Request'
            }
          });
        }

        // Handle with MCP server
        const response = await this.server.handleRequest(request);
        res.json(response);

      } catch (error) {
        console.error('[HTTP] Message handling error:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: -32603,
            message: error.message
          }
        });
      }
    });

    // Health endpoint
    app.get('/health', (req, res) => {
      const stats = this.sseTransport.getStats();
      
      res.json({
        status: 'healthy',
        server: 'mcp-server-oauth',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        oauth: {
          server: this.oauthServerUrl,
          metadata_endpoint: `${this.mcpServerUrl}/.well-known/mcp-server`
        },
        sse: {
          endpoint: '/sse',
          connections: stats.total_connections
        },
        endpoints: {
          sse: '/sse',
          message: '/message',
          metadata: '/.well-known/mcp-server',
          oauth_callback: '/oauth/callback',
          oauth_discovery: '/oauth/discovery'
        }
      });
    });

    // Root endpoint
    app.get('/', (req, res) => {
      res.json({
        server: 'MCP Server with OAuth Authentication',
        version: '1.0.0',
        protocol_version: '2025-06-18',  // Updated to match Claude Desktop's expected version
        oauth_required: true,
        endpoints: {
          sse: '/sse',
          message: '/message',
          metadata: '/.well-known/mcp-server',
          oauth_callback: '/oauth/callback',
          health: '/health'
        },
        documentation: 'https://modelcontextprotocol.io/specification/draft/basic/authorization'
      });
    });

    // Root POST endpoint for MCP JSON-RPC (Claude Desktop compatibility)
    app.post('/', authenticateBearer(this.oauthProvider), async (req, res) => {
      try {
        console.log(`[Server] 🔄 POST / - MCP JSON-RPC Request`);
        console.log(`[Server] 👤 OAuth User: ${req.oauth?.sub}`);
        console.log(`[Server] 🔑 OAuth Client: ${req.oauth?.client_id}`);
        
        const request = req.body;
        
        if (!request || typeof request !== 'object') {
          console.log(`[Server] ❌ Invalid JSON-RPC request format`);
          return res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32600,
              message: 'Invalid Request',
              data: 'Request body must be valid JSON-RPC'
            },
            id: request?.id || null
          });
        }

        console.log(`[Server] 📨 JSON-RPC Method: ${request.method}`);
        console.log(`[Server] 🆔 Request ID: ${request.id}`);

        let response;

        // Handle different MCP methods
        switch (request.method) {
          case 'initialize':
            console.log(`[Server] 🚀 Handling initialize request`);
            console.log(`[Server] 📋 Protocol Version: ${request.params?.protocolVersion}`);
            console.log(`[Server] 👤 Client Info:`, JSON.stringify(request.params?.clientInfo, null, 2));
            
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: '2025-06-18', // Support the version Claude Desktop expects
                capabilities: {
                  tools: {},
                  logging: {}
                },
                serverInfo: {
                  name: 'mcp-server-oauth',
                  version: '1.0.0'
                },
                instructions: 'MCP Server with OAuth 2.1 authentication ready for tool calls.'
              }
            };
            break;

          case 'tools/list':
            console.log(`[Server] 🛠️  Handling tools/list request`);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                tools: [
                  {
                    name: 'oauth_status',
                    description: 'Check OAuth authentication status and server configuration',
                    inputSchema: {
                      type: 'object',
                      properties: {},
                      required: []
                    }
                  },
                  {
                    name: 'test_tool',
                    description: 'Test tool that requires OAuth authentication',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        message: {
                          type: 'string',
                          description: 'Test message to echo back'
                        }
                      },
                      required: ['message']
                    }
                  },
                  {
                    name: 'connection_stats',
                    description: 'Get SSE connection statistics',
                    inputSchema: {
                      type: 'object',
                      properties: {},
                      required: []
                    }
                  }
                ]
              }
            };
            break;

          case 'tools/call':
            console.log(`[Server] ⚡ Handling tools/call request for: ${request.params?.name}`);
            const toolName = request.params?.name;
            const toolArgs = request.params?.arguments || {};

            switch (toolName) {
              case 'oauth_status':
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({
                          oauth_server: this.oauthServerUrl,
                          authenticated: true,
                          user_id: req.oauth?.sub,
                          client_id: req.oauth?.client_id,
                          scope: req.oauth?.scope,
                          server_info: {
                            name: 'mcp-server-oauth',
                            version: '1.0.0',
                            protocol_version: '2025-06-18'
                          }
                        }, null, 2)
                      }
                    ]
                  }
                };
                break;

              case 'test_tool':
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: `Echo: ${toolArgs.message || 'No message provided'}\n\nAuthenticated as: ${req.oauth?.sub || 'unknown'}\nClient: ${req.oauth?.client_id || 'unknown'}`
                      }
                    ]
                  }
                };
                break;

              case 'connection_stats':
                const stats = {
                  active_connections: this.sseTransport?.connections?.size || 0,
                  server_uptime: process.uptime(),
                  memory_usage: process.memoryUsage(),
                  oauth_authenticated: true,
                  user_id: req.oauth?.sub,
                  client_id: req.oauth?.client_id
                };

                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(stats, null, 2)
                      }
                    ]
                  }
                };
                break;

              default:
                console.log(`[Server] ❌ Unknown tool: ${toolName}`);
                response = {
                  jsonrpc: '2.0',
                  id: request.id,
                  error: {
                    code: -32601,
                    message: 'Method not found',
                    data: `Unknown tool: ${toolName}`
                  }
                };
            }
            break;

          default:
            console.log(`[Server] ❌ Unknown method: ${request.method}`);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: 'Method not found',
                data: `Unknown method: ${request.method}`
              }
            };
        }

        console.log(`[Server] ✅ Sending JSON-RPC response for ${request.method}`);
        res.json(response);

      } catch (error) {
        console.error(`[Server] ❌ Error processing POST / request:`, error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          },
          id: req.body?.id || null
        });
      }
    });

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({
        error: 'not_found',
        message: `Endpoint ${req.method} ${req.path} not found`
      });
    });

    // Error handler
    app.use((err, req, res, next) => {
      console.error('[Server] Error:', err);
      res.status(500).json({
        error: 'server_error',
        message: err.message
      });
    });

    const servers = [];

    if (this.enableHttps) {
      // Start HTTPS server (primary for Claude Desktop)
      try {
        const certPath = path.join(__dirname, '../certs/server.crt');
        const keyPath = path.join(__dirname, '../certs/server.key');
        
        if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
          const httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
          };

          const httpsServer = https.createServer(httpsOptions, app);
          httpsServer.listen(this.httpsPort, this.host, () => {
            console.log(`🚀 MCP Server with OAuth started`);
            console.log(`📡 HTTPS Server: https://${this.host}:${this.httpsPort}`);
            console.log(`🌊 SSE Endpoint: https://${this.host}:${this.httpsPort}/sse`);
            console.log(`🔐 OAuth Server: ${this.oauthServerUrl}`);
            console.log(`📋 Health: https://${this.host}:${this.httpsPort}/health`);
            console.log(`📚 Metadata: https://${this.host}:${this.httpsPort}/.well-known/mcp-server`);
            console.log(`✅ MCP OAuth Server ready for Claude Desktop!`);
          });
          
          servers.push(httpsServer);
          
          // Also start HTTP for fallback
          const httpServer = app.listen(this.port, this.host, () => {
            console.log(`📡 HTTP Fallback: http://${this.host}:${this.port}`);
          });
          servers.push(httpServer);
          
        } else {
          console.warn(`⚠️  HTTPS enabled but certificates not found at ${certPath} or ${keyPath}`);
          console.warn(`⚠️  Starting HTTP server only`);
          this.enableHttps = false;
        }
      } catch (error) {
        console.error(`❌ Failed to start HTTPS server: ${error.message}`);
        console.warn(`⚠️  Starting HTTP server only`);
        this.enableHttps = false;
      }
    }
    
    if (!this.enableHttps) {
      // Start HTTP server
      const httpServer = app.listen(this.port, this.host, () => {
        console.log(`🚀 MCP Server with OAuth started`);
        console.log(`📡 HTTP Server: http://${this.host}:${this.port}`);
        console.log(`🌊 SSE Endpoint: http://${this.host}:${this.port}/sse`);
        console.log(`🔐 OAuth Server: ${this.oauthServerUrl}`);
        console.log(`📋 Health: http://${this.host}:${this.port}/health`);
        console.log(`📚 Metadata: http://${this.host}:${this.port}/.well-known/mcp-server`);
        console.log(`⚠️  Note: Claude Desktop requires HTTPS for /sse endpoint in production`);
        console.log(`✅ MCP OAuth Server ready!`);
      });
      servers.push(httpServer);
    }

    // Graceful shutdown
    const gracefulShutdown = () => {
      console.log('\n🛑 Shutting down MCP OAuth Server...');
      let closed = 0;
      
      servers.forEach(server => {
        server.close(() => {
          closed++;
          if (closed === servers.length) {
            console.log('✅ MCP OAuth Server closed');
            process.exit(0);
          }
        });
      });
      
      // Force exit after 5 seconds
      setTimeout(() => {
        console.log('⚠️  Force exit after timeout');
        process.exit(1);
      }, 5000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    return servers[0];
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new MCPServerWithOAuth();
  server.start().catch(error => {
    console.error('❌ Failed to start MCP OAuth server:', error);
    process.exit(1);
  });
}

export default MCPServerWithOAuth;