#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { server as baseServer } from './server.js';
import { configManager } from './config-manager.js';
import { OAuthManager, createOAuthRoutes, createAuthMiddleware } from './oauth/index.js';

// Configuration
const MCP_PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${MCP_PORT}`;
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

console.log(`🚀 Starting Desktop Commander HTTP Server`);
console.log(`   Port: ${MCP_PORT}`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Auth: ${REQUIRE_AUTH ? 'ENABLED (OAuth)' : 'DISABLED (development mode)'}`);

const app = express();

// Log ALL incoming requests for debugging
app.use((req, res, next) => {
  console.log(`\n🌐 ${req.method} ${req.path}`);
  if (Object.keys(req.query).length > 0) {
    console.log(`   Query:`, req.query);
  }
  if (req.headers.authorization) {
    console.log(`   Auth: Bearer token present`);
  }
  
  // Capture response
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);
  
  res.json = function(data) {
    console.log(`   📤 Response ${res.statusCode}:`, JSON.stringify(data, null, 2).substring(0, 500));
    return originalJson(data);
  };
  
  res.send = function(data) {
    if (typeof data === 'string' && data.length < 200) {
      console.log(`   📤 Response ${res.statusCode}: ${data.substring(0, 200)}`);
    } else {
      console.log(`   📤 Response ${res.statusCode}: [${typeof data}]`);
    }
    return originalSend(data);
  };
  
  res.end = function(data) {
    console.log(`   📤 Response ended: ${res.statusCode}`);
    return originalEnd(data);
  };
  
  next();
});

// Initialize OAuth if enabled
const oauthManager = REQUIRE_AUTH ? new OAuthManager(BASE_URL) : null;

// Middleware
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add OAuth routes if enabled
if (oauthManager) {
  const oauthRoutes = createOAuthRoutes(oauthManager, BASE_URL);
  app.use(oauthRoutes);
  console.log('🔐 OAuth routes registered');
}

// Create auth middleware
const authMiddleware = createAuthMiddleware(oauthManager, BASE_URL, REQUIRE_AUTH);

// Map to store transports by session ID (session-based mode like oauth-test)
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Desktop Commander HTTP Server',
    version: '0.3.0-alpha',
    status: 'ready',
    auth: REQUIRE_AUTH ? 'enabled' : 'disabled',
    mode: 'session-based',
    endpoints: {
      mcp: '/mcp',
      health: '/',
      ...(REQUIRE_AUTH ? {
        oauth_discovery: '/.well-known/oauth-authorization-server',
        resource_metadata: '/.well-known/oauth-protected-resource',
        register: '/register',
        authorize: '/authorize',
        token: '/token'
      } : {})
    }
  });
});

// MCP POST endpoint - handles initialization and tool calls
app.post('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  console.log(`\n📥 POST /mcp`);
  console.log(`   Session: ${sessionId || 'new'}`);
  console.log(`   Method: ${req.body?.method}`);
  if (req.auth) {
    console.log(`   User: ${req.auth.username} (${req.auth.client_id})`);
  }
  console.log(`   Headers:`, JSON.stringify({
    'content-type': req.headers['content-type'],
    'accept': req.headers['accept'],
    'mcp-session-id': req.headers['mcp-session-id'],
    'user-agent': req.headers['user-agent']
  }, null, 2));
  
  try {
    let transport: StreamableHTTPServerTransport;
    
    // Check if this is an existing session
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      console.log(`   ♻️  Using existing session`);
    } 
    // Check if this is a new initialize request
    else if (!sessionId && isInitializeRequest(req.body)) {
      console.log(`   🆕 Creating new session`);
      
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        enableJsonResponse: true,  // CRITICAL: Avoid SSE through cloudflare tunnel
        onsessioninitialized: (sid) => {
          console.log(`   ✅ Session initialized: ${sid}`);
          transports[sid] = transport;
        }
      });
      
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`   🔴 Session closed: ${sid}`);
          delete transports[sid];
        }
      };
      
      // Connect the shared base server to this transport
      // Note: MCP SDK allows one server to be connected to multiple transports
      await baseServer.connect(transport);
      await transport.handleRequest(req as any, res as any, req.body);
      return;
    } 
    // Invalid request
    else {
      console.log(`   ❌ Invalid request: no session ID and not an initialize request`);
      res.status(400).json({
        jsonrpc: '2.0',
        error: { 
          code: -32000, 
          message: 'Bad Request: No valid session ID or not an initialize request'
        },
        id: null
      });
      return;
    }
    
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (error) {
    console.error('❌ Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { 
          code: -32603, 
          message: 'Internal error',
          data: error instanceof Error ? error.message : String(error)
        },
        id: null
      });
    }
  }
});

// MCP GET endpoint - handles Server-Sent Events (SSE) for notifications
// DISABLED when using enableJsonResponse: true
app.get('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  console.log(`\n📥 GET /mcp (SSE) - Session: ${sessionId}`);
  console.log(`   ❌ SSE not supported in JSON-only mode`);
  
  // Return error - SSE not supported when using JSON-only mode
  return res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'SSE not supported. Use POST with mcp-session-id header for all requests.'
    },
    id: null
  });
});

// MCP DELETE endpoint - handles session termination
app.delete('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  console.log(`\n🗑️  DELETE /mcp - Session: ${sessionId}`);
  
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid session ID');
  }
  
  const transport = transports[sessionId];
  try {
    await transport.handleRequest(req as any, res as any);
  } catch (error) {
    console.error('❌ Error handling DELETE:', error);
    if (!res.headersSent) {
      res.status(500).send('Error terminating session');
    }
  }
});

// Start the server
async function startServer() {
  // Load configuration
  try {
    console.log('📁 Loading configuration...');
    await configManager.loadConfig();
    console.log('✅ Configuration loaded successfully');
  } catch (configError) {
    console.error('⚠️  Failed to load configuration:', configError instanceof Error ? configError.message : String(configError));
    console.log('   Continuing with default configuration...');
  }

  app.listen(MCP_PORT, () => {
    console.log(`\n✅ Desktop Commander HTTP Server listening on port ${MCP_PORT}`);
    console.log(`\n📋 Available endpoints:`);
    console.log(`   GET  /      - Health check`);
    console.log(`   POST /mcp   - MCP requests`);
    console.log(`   GET  /mcp   - Server-Sent Events (SSE)`);
    console.log(`   DELETE /mcp - Terminate session`);
    
    if (REQUIRE_AUTH) {
      console.log(`\n🔐 OAuth endpoints:`);
      console.log(`   GET  /.well-known/oauth-authorization-server  - Discovery`);
      console.log(`   GET  /.well-known/oauth-protected-resource    - Resource metadata`);
      console.log(`   POST /register   - Client registration`);
      console.log(`   GET  /authorize  - Authorization (login page)`);
      console.log(`   POST /token      - Token exchange`);
      console.log(`\n👤 Demo credentials: admin / password123`);
    }
    
    console.log(`\n🔗 Test with MCP Inspector:`);
    console.log(`   npx @modelcontextprotocol/inspector ${BASE_URL}/mcp`);
    console.log(`\n📝 Mode: Session-based ${REQUIRE_AUTH ? '(OAuth enabled)' : '(no auth)'}`);
    console.log(``);
  }).on('error', (error) => {
    console.error('❌ Failed to start HTTP server:', error);
    process.exit(1);
  });
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing ${sessionId}:`, error);
    }
  }
  process.exit(0);
});

// Start the server
startServer().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
