#!/usr/bin/env node

/**
 * Supabase OAuth MCP Server with HTTP Transport
 * 
 * This server provides MCP (Model Context Protocol) functionality with:
 * - OAuth 2.0 with PKCE authentication
 * - HTTP transport for MCP protocol
 * - User-specific tool execution
 * - Session management and logging
 * - OAuth discovery endpoints
 * - Official MCP SDK integration
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { createSupabaseServiceClient } from '../utils/supabase.js';
import { serverLogger, mcpLogger } from '../utils/logger.js';
import { authMiddleware } from './auth-middleware.js';
// import { getAllToolDefinitions, executeTool } from './tools/index.js';
import { OAuthValidator } from './oauth/oauth-validator.js';
import { OAuthProcessor } from './oauth/oauth-processor.js';
import { OAuthResponder } from './oauth/oauth-responder.js';
import { ToolDispatcher } from '../remote/tool-dispatcher.js';
import { z } from 'zod';
import { allTools } from './tools/remote-tools-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Configuration constants - MCP compliant
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || (process.env.NODE_ENV === 'production'
  ? 'https://your-production-domain.com'
  : 'http://localhost:3007');

// OAuth components will be initialized in constructor

/**
 * Main MCP Server class
 */
class SupabaseMCPServer {
  constructor() {
    this.app = express();
    this.port = parseInt(process.env.MCP_SERVER_PORT) || 3007;
    this.host = process.env.MCP_SERVER_HOST || 'localhost';
    this.serverUrl = MCP_SERVER_URL;

    // Initialize components
    // Use Service Client for server-side operations to bypass RLS
    this.supabase = createSupabaseServiceClient();

    // Initialize OAuth components
    this.oauthValidator = new OAuthValidator(this.serverUrl);
    this.oauthProcessor = new OAuthProcessor(this.serverUrl, this.supabase);
    this.oauthResponder = new OAuthResponder(this.serverUrl);

    // Initialize remote components
    this.toolDispatcher = new ToolDispatcher(this.supabase);

    // Initialize MCP SDK Server
    this.mcpServer = new McpServer(
      {
        name: 'supabase-mcp-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {
            listChanged: true
          },
          logging: {}
        }
      }
    );

    // Initialize MCP session management
    this.mcpEventStore = new InMemoryEventStore();
    this.mcpTransports = new Map(); // Track transports by session ID

    // Request tracking
    this.requestCount = 0;
    this.startTime = Date.now();

    this.setupMCPToolHandlers();
    this.setupChannelListeners();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();

    mcpLogger.info('✅ Supabase MCP Server initialization complete', {
      toolsRegistered: Object.keys(this.mcpServer._registeredTools || {}).length
    });

    serverLogger.info('Supabase MCP Server initialized with SDK', {
      port: this.port,
      host: this.host,
      environment: process.env.NODE_ENV || 'development'
    });
  }

  /**
   * Setup MCP tools using the McpServer API
   */
  setupMCPToolHandlers() {
    mcpLogger.info('🔧 setupMCPToolHandlers() called', {});

    // Register only the list_agents tool
    this.mcpServer.registerTool('list_agents', {
      description: 'List connected agents for the current user',
      inputSchema: z.object({})
    }, async (args, extra = {}) => {
      mcpLogger.info('📋 [TOOL] list_agents called');
      const user = this.getAuthenticatedUser(extra);

      try {
        const agents = await this.toolDispatcher.getUserAgents(user.id);
        mcpLogger.info('✅ [TOOL] list_agents successful', { count: agents.length });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(agents, null, 2)
          }]
        };
      } catch (error) {
        mcpLogger.error('❌ [TOOL] list_agents failed', { error: error.message });
        throw error;
      }
    });

    // Register remote tools from allTools configuration
    allTools.forEach(tool => {
      mcpLogger.info('Registering remote tool with MCP SDK', {
        toolName: tool.name
      });

      this.mcpServer.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema
        },
        async (args, extra = {}) => {
          mcpLogger.info('🔧 Remote Tool called', {
            toolName: tool.name,
            argsReceived: !!args
          });

          const user = this.getAuthenticatedUser(extra);
          mcpLogger.info('👤 [TOOL] Authenticated user:', { id: user.id });

          // Dispatch to remote agent
          try {
            mcpLogger.info('🚀 Dispatching to remote agent', {
              toolName: tool.name,
              userId: user.id
            });

            const result = await this.toolDispatcher.dispatchTool(
              user.id,
              tool.name, // Tool name on agent side matches server side
              args
            );

            mcpLogger.info('✅ Remote tool execution successful', {
              toolName: tool.name
            });
            return result;
          } catch (error) {
            mcpLogger.error('❌ Remote tool execution failed', {
              toolName: tool.name,
              error: error.message
            });
            throw error;
          }
        }
      );
    });

    mcpLogger.info('✅ Tool registration complete (list_agents + remote tools)');
    serverLogger.info(`MCP SDK registered ${allTools.length + 1} tools`);
  }

  /**
   * Get authenticated user from MCP request context
   */
  getAuthenticatedUser(extra) {
    const transport = extra.transport || this.mcpTransports.get(extra.sessionId);
    const authContext = transport?._authContext;
    const user = authContext?.user;

    if (!user) {
      throw new Error('User authentication required');
    }

    return user;
  }

  /**
   * Setup channel event listeners
   */
  /**
   * Setup channel event listeners
   */
  setupChannelListeners() {
    // Channel listeners are now handled internally by ToolDispatcher
    serverLogger.info('Channel listeners configured via ToolDispatcher');
  }


  /**
   * Get or create MCP transport for a session
   */
  async getOrCreateMCPTransport(sessionId, user) {
    let transport = sessionId ? this.mcpTransports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => Date.now().toString() + '-' + Math.random().toString(36).substring(2),
        eventStore: this.mcpEventStore,
        retryInterval: 2000,
        onsessioninitialized: (id) => {
          serverLogger.info('MCP session initialized', { sessionId: id, userId: user.id });
          this.mcpTransports.set(id, transport);
        }
      });

      // Store auth context for this transport
      transport._authContext = {
        user: user,
        supabase: this.supabase
      };

      // Connect the MCP server to the transport
      mcpLogger.info('🔗 Connecting MCP server to transport', {
        userId: user.id,
        sessionId
      });

      await this.mcpServer.connect(transport);

      mcpLogger.info('✅ MCP server connected to transport', {
        userId: user.id,
        sessionId
      });

      serverLogger.info('Created new MCP transport', { sessionId, userId: user.id });
    }

    // Update auth context for existing transport
    transport._authContext = {
      user: user,
      supabase: this.supabase
    };

    return transport;
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // Request tracking
    this.app.use((req, res, next) => {
      this.requestCount++;
      req.requestId = this.requestCount;
      req.startTime = Date.now();

      serverLogger.logRequest(req);
      next();
    });

    // CORS configuration (MCP compliant - single server URL)
    const corsOrigins = process.env.CORS_ORIGINS
      ? JSON.parse(process.env.CORS_ORIGINS)
      : [this.serverUrl]; // Use single MCP server URL

    serverLogger.info('CORS configuration', {
      corsOrigins,
      serverUrl: this.serverUrl
    });

    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Claude Desktop, etc.)
        if (!origin) return callback(null, true);

        if (corsOrigins.includes(origin)) {
          serverLogger.debug('✅ CORS origin allowed', { origin });
          callback(null, true);
        } else {
          serverLogger.warn('❌ CORS origin rejected', {
            origin,
            allowed: corsOrigins,
            serverUrl: this.serverUrl
          });
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    }));

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Serve static files from web/public
    const staticPath = path.join(__dirname, '..', 'web', 'public');
    this.app.use(express.static(staticPath));

    serverLogger.info('Static files served from', { path: staticPath });

    // Security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-MCP-Version', '2024-11-05');
      res.setHeader('X-Server-Type', 'Supabase-MCP-HTTP');
      next();
    });

    // Response logging
    this.app.use((req, res, next) => {
      const originalSend = res.json;
      res.json = function (data) {
        const duration = Date.now() - req.startTime;
        serverLogger.logResponse(req, res, duration);
        return originalSend.call(this, data);
      };
      next();
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Health check (public)
    this.app.get('/health', (req, res) => {
      const uptime = Date.now() - this.startTime;

      res.json({
        status: 'healthy',
        service: 'supabase-mcp-server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: {
          milliseconds: uptime,
          seconds: Math.floor(uptime / 1000),
          human: this._formatUptime(uptime)
        },
        requests: {
          total: this.requestCount,
          rate: Math.round((this.requestCount / (uptime / 1000)) * 100) / 100
        },
        environment: {
          node_version: process.version,
          platform: process.platform,
          arch: process.arch
        }
      });
    });

    // Server info (public)
    this.app.get('/', (req, res) => {
      res.json({
        service: 'Supabase MCP Server',
        version: '1.0.0',
        protocol_version: '2024-11-05',
        transport: 'http',
        authentication: 'oauth2',
        endpoints: {
          mcp: '/mcp',
          health: '/health',
          authorize: '/authorize',
          token: '/token',
          register: '/register'
        },
        features: [
          'HTTP transport',
          'OAuth 2.0 with PKCE',
          'Supabase authentication',
          'User-scoped tool execution',
          'Session management',
          'Tool call logging'
        ],
        timestamp: new Date().toISOString()
      });
    });

    // OAuth 2.0 Discovery endpoints (MCP compliant)
    this.app.get('/.well-known/oauth-authorization-server', (req, res) => {
      serverLogger.info('🔍 OAuth Discovery Request', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        serverUrl: this.serverUrl,
        timestamp: new Date().toISOString()
      });

      const discovery = this.oauthResponder.generateDiscoveryResponse();
      res.json(discovery);
    });

    this.app.get('/.well-known/oauth-protected-resource', (req, res) => {
      serverLogger.info('🛡️ Protected Resource Discovery Request', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        serverUrl: this.serverUrl
      });

      const resourceInfo = this.oauthResponder.generateProtectedResourceResponse();
      res.json(resourceInfo);
    });

    // OAuth 2.0 Authorization endpoint (MCP compliant)
    this.app.get('/authorize', (req, res) => {
      serverLogger.info('🔐 OAuth Authorization Request', {
        clientId: req.query.client_id,
        redirectUri: req.query.redirect_uri,
        scope: req.query.scope,
        resource: req.query.resource,
        hasCodeChallenge: !!req.query.code_challenge,
        codeChallengMethod: req.query.code_challenge_method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      // Validate request parameters
      const validation = this.oauthValidator.validateAuthorizationRequest(req.query);
      if (!validation.valid) {
        return this.oauthResponder.sendErrorResponse(res, validation.error, validation.error_description);
      }

      try {
        // Process authorization request
        const { authorizationId, authUrl } = this.oauthProcessor.processAuthorizationRequest(req.query);

        // Redirect to authentication page
        this.oauthResponder.sendRedirectResponse(res, authUrl);

      } catch (error) {
        serverLogger.error('Authorization request processing failed', null, error);
        this.oauthResponder.sendErrorResponse(res, 'server_error', 'Failed to process authorization request', 500);
      }
    });

    // OAuth 2.0 Token endpoint (MCP compliant)
    this.app.post('/token', express.json(), async (req, res) => {
      try {
        serverLogger.info('🎟️ Token Exchange Request', {
          grantType: req.body.grant_type,
          clientId: req.body.client_id,
          redirectUri: req.body.redirect_uri,
          resource: req.body.resource,
          hasCode: !!req.body.code,
          hasCodeVerifier: !!req.body.code_verifier,
          ip: req.ip
        });

        // Validate request parameters
        const validation = this.oauthValidator.validateTokenRequest(req.body);
        if (!validation.valid) {
          return this.oauthResponder.sendErrorResponse(res, validation.error, validation.error_description);
        }

        try {
          // Process token exchange
          const { tokenResponse, user } = await this.oauthProcessor.processTokenExchange(req.body);

          // Send successful token response
          this.oauthResponder.sendTokenResponse(res, tokenResponse);

        } catch (processingError) {
          serverLogger.error('❌ Token exchange processing failed', { clientId: req.body.client_id }, processingError);

          if (processingError.message.includes('PKCE validation failed')) {
            return this.oauthResponder.sendErrorResponse(res, 'invalid_grant', 'PKCE validation failed');
          }

          if (processingError.message.includes('Invalid authorization code')) {
            return this.oauthResponder.sendErrorResponse(res, 'invalid_grant', 'Invalid authorization code');
          }

          return this.oauthResponder.sendErrorResponse(res, 'server_error', 'Failed to process token exchange', 500);
        }

      } catch (error) {
        serverLogger.error('❌ Token endpoint error', null, error);
        this.oauthResponder.sendErrorResponse(res, 'server_error', 'Internal server error', 500);
      }
    });

    // OAuth 2.0 Client Registration endpoint
    this.app.post('/register', express.json(), (req, res) => {
      serverLogger.info('📝 Client Registration Request', {
        clientName: req.body.client_name,
        redirectUris: req.body.redirect_uris,
        scope: req.body.scope,
        ip: req.ip
      });

      // Validate request parameters
      const validation = this.oauthValidator.validateRegistrationRequest(req.body);
      if (!validation.valid) {
        return this.oauthResponder.sendErrorResponse(res, validation.error, validation.error_description);
      }

      try {
        // Process client registration
        const clientInfo = this.oauthProcessor.processClientRegistration(req.body);

        // Send registration response
        this.oauthResponder.sendRegistrationResponse(res, clientInfo);

      } catch (error) {
        serverLogger.error('Client registration processing failed', null, error);
        this.oauthResponder.sendErrorResponse(res, 'server_error', 'Failed to process client registration', 500);
      }
    });

    // MCP endpoint (authenticated) - using SDK (supports both GET and POST)
    this.app.all('/mcp',
      authMiddleware.validate,
      authMiddleware.rateLimit(100, 60000), // 100 requests per minute
      this.handleMCPMessageWithSDK.bind(this)
    );

    // Direct MCP endpoint without auth (for HTTP transport)
    this.app.all('/mcp-direct',
      express.json(),
      authMiddleware.rateLimit(100, 60000),
      async (req, res) => {
        // Handle direct MCP calls with Bearer token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({
            jsonrpc: '2.0',
            id: req.body?.id || null,
            error: {
              code: -32001,
              message: 'Missing or invalid authorization header'
            }
          });
        }

        const accessToken = authHeader.split(' ')[1];
        try {
          const { data: { user }, error: userError } = await this.supabase.auth.getUser(accessToken);

          if (userError) {
            return res.status(401).json({
              jsonrpc: '2.0',
              id: req.body?.id || null,
              error: {
                code: -32001,
                message: 'Invalid access token'
              }
            });
          }

          req.user = user;
          await this.handleMCPMessageWithSDK(req, res);

        } catch (error) {
          serverLogger.error('Direct MCP auth error', null, error);
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id || null,
            error: {
              code: -32603,
              message: 'Internal error'
            }
          });
        }
      }
    );

    // OAuth callback handler
    this.app.get('/auth/callback', async (req, res) => {
      serverLogger.info('🔄 OAuth Callback Received', {
        hasAccessToken: !!req.query.access_token,
        hasRefreshToken: !!req.query.refresh_token,
        error: req.query.error,
        clientId: req.query.client_id,
        redirectUri: req.query.redirect_uri,
        state: req.query.state,
        authId: req.query.auth_id,
        ip: req.ip
      });

      try {
        // Process OAuth callback
        const result = await this.oauthProcessor.processCallback(req.query);

        // Handle callback redirect response
        this.oauthResponder.handleCallbackRedirect(res, {
          ...result,
          redirect_uri: req.query.redirect_uri,
          state: req.query.state
        });

      } catch (callbackError) {
        serverLogger.error('OAuth callback processing failed', null, callbackError);

        // Handle callback error with redirect
        this.oauthResponder.handleCallbackRedirect(res, {
          error: 'invalid_token',
          error_description: callbackError.message,
          redirect_uri: req.query.redirect_uri,
          state: req.query.state
        });
      }
    });

    // DEBUG: Test endpoint to trigger remote_echo (development only)
    this.app.get('/debug/test-remote', express.json(), async (req, res) => {
      if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
      }

      try {
        serverLogger.info('🧪 DEBUG: Test remote_echo endpoint triggered', {
          body: req.body,
          ip: req.ip
        });

        // Create a mock authenticated user for testing
        const mockUser = {
          id: 'a6766832-9b4e-4efd-bfec-a53734bff5a3', // Use the user ID from the agent logs
          email: 'debug@test.com'
        };

        const text = req.body.text || 'Debug test message';


        // Directly call the tool dispatcher
        const result = await this.toolDispatcher.dispatchTool(mockUser.id, 'list_directory', { path: ".", depth: 1 });

        res.json({
          success: true,
          result,
          message: 'Tool dispatched successfully'
        });

      } catch (error) {
        serverLogger.error('🧪 DEBUG: Test endpoint failed', null, error);
        res.status(500).json({
          success: false,
          error: error.message,
          message: 'Tool dispatch failed'
        });
      }
    });

    // DEBUG: List all connected agents (development only)
    this.app.get('/debug/list-agents', async (req, res) => {
      if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
      }

      try {
        serverLogger.info('🧪 DEBUG: List agents endpoint triggered', {
          ip: req.ip
        });

        const { data: agents, error } = await this.supabase
          .from('mcp_agents')
          .select('*')
          .order('last_seen', { ascending: false });

        if (error) {
          throw error;
        }

        res.json({
          success: true,
          agents: agents || [],
          count: agents?.length || 0,
          message: 'All registered agents (online and offline)'
        });

      } catch (error) {
        serverLogger.error('🧪 DEBUG: List agents failed', null, error);
        res.status(500).json({
          success: false,
          error: error.message,
          message: 'Failed to list agents'
        });
      }
    });

    // DEBUG: Plain MCP endpoint without OAuth (development only)
    this.app.post('/mcp-test', express.json(), async (req, res) => {
      if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
      }

      try {
        console.log('🧪 [DEBUG] Plain MCP test endpoint triggered');
        console.log('🧪 [DEBUG] Request body:', req.body);

        // Create a mock authenticated user
        req.user = {
          id: 'a6766832-9b4e-4efd-bfec-a53734bff5a3',
          email: 'test@example.com'
        };

        // Handle as normal MCP request
        await this.handleMCPMessageWithSDK(req, res);

      } catch (error) {
        console.error('❌ [DEBUG] MCP test failed:', error);
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

    // MCP info API endpoint for web interface
    this.app.get('/api/mcp-info', (req, res) => {
      serverLogger.info('ℹ️ MCP Info Request', {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      const mcpInfo = this.oauthResponder.generateMCPInfoResponse();
      res.json(mcpInfo);
    });
  }

  /**
   * Handle MCP protocol messages using session-based transports
   */
  async handleMCPMessageWithSDK(req, res) {
    const startTime = Date.now();
    const userId = req.user.id;

    try {
      const requestBody = req.body;
      const sessionId = req.headers['mcp-session-id'];

      mcpLogger.logMCPMessage(userId, requestBody?.method, requestBody?.id, 'RECEIVED');

      mcpLogger.info('📨 Processing MCP request', {
        userId,
        sessionId,
        method: requestBody?.method,
        id: requestBody?.id,
        hasParams: !!requestBody?.params
      });

      // Get or create transport for this session
      const transport = await this.getOrCreateMCPTransport(sessionId, req.user);

      mcpLogger.info('🔌 Transport ready', {
        userId,
        sessionId,
        isNewTransport: !sessionId || !this.mcpTransports.has(sessionId)
      });

      // Handle the request using the session transport
      mcpLogger.info('🚀 Delegating to transport.handleRequest', {
        userId,
        sessionId,
        method: requestBody?.method
      });

      // Log registered tools when tools/list is requested
      if (requestBody?.method === 'tools/list') {
        const registeredTools = Object.keys(this.mcpServer._registeredTools || {});
        mcpLogger.info('📊 McpServer internal state for tools/list', {
          registeredToolCount: registeredTools.length,
          registeredToolNames: registeredTools,
          hasServer: !!this.mcpServer,
          serverConnected: this.mcpServer.isConnected()
        });
      }

      // Intercept response to log it
      const originalJson = res.json;
      const originalSend = res.send;
      let responseLogged = false;

      res.json = function (data) {
        if (!responseLogged && requestBody?.method === 'tools/list') {
          mcpLogger.info('📋 tools/list RESPONSE BODY', {
            tools: data?.result?.tools,
            toolCount: data?.result?.tools?.length || 0,
            fullResponse: data
          });
          responseLogged = true;
        }
        return originalJson.call(this, data);
      };

      res.send = function (data) {
        if (!responseLogged && requestBody?.method === 'tools/list') {
          try {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            mcpLogger.info('📋 tools/list RESPONSE BODY (send)', {
              tools: parsed?.result?.tools,
              toolCount: parsed?.result?.tools?.length || 0,
              fullResponse: parsed
            });
          } catch (e) {
            mcpLogger.info('📋 tools/list RESPONSE (raw)', { data });
          }
          responseLogged = true;
        }
        return originalSend.call(this, data);
      };

      await transport.handleRequest(req, res, requestBody);

      mcpLogger.info('✅ transport.handleRequest completed', {
        userId,
        sessionId,
        method: requestBody?.method
      });

      const duration = Date.now() - startTime;
      mcpLogger.logMCPMessage(userId, requestBody?.method, requestBody?.id, 'RESPONDED');
      mcpLogger.info('MCP SDK request completed', {
        userId,
        sessionId,
        method: requestBody?.method,
        duration: `${duration}ms`
      });

    } catch (error) {
      const duration = Date.now() - startTime;

      // Only send error response if headers haven't been sent yet
      if (!res.headersSent) {
        const errorResponse = {
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: this._getErrorCode(error),
            message: error.message,
            data: process.env.DEBUG_MODE === 'true' ? error.stack : undefined
          }
        };

        mcpLogger.error('MCP SDK request failed', {
          userId,
          method: req.body?.method,
          duration: `${duration}ms`,
          error: error.message
        });

        res.status(400).json(errorResponse);
      } else {
        mcpLogger.error('MCP SDK request failed (headers already sent)', {
          userId,
          method: req.body?.method,
          duration: `${duration}ms`,
          error: error.message
        });
      }
    }
  }

  /**
   * Get JSON-RPC error code for different error types
   */
  _getErrorCode(error) {
    if (error.message.includes('Unknown method')) return -32601;
    if (error.message.includes('Invalid Request')) return -32600;
    if (error.message.includes('Parse error')) return -32700;
    if (error.message.includes('Invalid params')) return -32602;
    return -32603; // Internal error
  }

  /**
   * Format uptime in human readable format
   */
  _formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Setup error handling
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      serverLogger.warn('Route not found', {
        method: req.method,
        url: req.url,
        ip: req.ip
      });

      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.url} not found`,
        available_endpoints: [
          'GET /',
          'GET /health',
          'GET /sse (authenticated)',
          'POST /mcp (authenticated)',
          'GET /tools (authenticated)',
          'GET /stats (authenticated)'
        ]
      });
    });

    // Error handler
    this.app.use((error, req, res, next) => {
      const duration = Date.now() - (req.startTime || Date.now());

      serverLogger.error('Express error handler', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        duration: `${duration}ms`,
        userId: req.user?.id
      }, error);

      // CORS errors
      if (error.message.includes('CORS')) {
        return res.status(403).json({
          error: 'CORS Error',
          message: 'Origin not allowed'
        });
      }

      // Generic error response
      res.status(error.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.DEBUG_MODE === 'true' ? error.message : 'An unexpected error occurred',
        request_id: req.requestId
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      serverLogger.error('Uncaught exception', null, error);
      this.shutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      serverLogger.error('Unhandled rejection', { promise }, new Error(reason));
      this.shutdown();
    });

    // Handle shutdown signals
    process.on('SIGINT', () => {
      serverLogger.info('Received SIGINT, shutting down gracefully');
      this.shutdown();
    });

    process.on('SIGTERM', () => {
      serverLogger.info('Received SIGTERM, shutting down gracefully');
      this.shutdown();
    });
  }

  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.port, this.host, (error) => {
        if (error) {
          serverLogger.error('Failed to start server', { port: this.port, host: this.host }, error);
          return reject(error);
        }

        serverLogger.info('🚀 Supabase MCP Server started', {
          server: `http://${this.host}:${this.port}`,
          health: `http://${this.host}:${this.port}/health`,
          sse: `http://${this.host}:${this.port}/sse`,
          mcp: `http://${this.host}:${this.port}/mcp`,
          environment: process.env.NODE_ENV || 'development'
        });

        this.server = server;
        resolve(server);
      });

      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          serverLogger.error(`Port ${this.port} is already in use`);
        } else {
          serverLogger.error('Server error', null, error);
        }
        reject(error);
      });
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    serverLogger.info('Starting graceful shutdown...');

    try {
      // Cleanup channel manager
      if (this.channelManager) {
        await this.channelManager.cleanup();
        serverLogger.info('Channel manager cleaned up');
      }

      // Close HTTP server
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
      }

      serverLogger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      serverLogger.error('Error during shutdown', null, error);
      process.exit(1);
    }
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new SupabaseMCPServer();
  server.start().catch((error) => {
    console.error('Failed to start Supabase MCP Server:', error);
    process.exit(1);
  });
}

export default SupabaseMCPServer;