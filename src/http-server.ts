#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { server as createBaseServer } from './server.js';
import { configManager } from './config-manager.js';

// Configuration
const MCP_PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${MCP_PORT}`;

console.log(`🚀 Starting Desktop Commander HTTP Server (No Auth)`);
console.log(`   Port: ${MCP_PORT}`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Auth: DISABLED (development mode)`);

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Map to store transports by session ID (session-based mode like oauth-test)
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Desktop Commander HTTP Server',
    version: '0.3.0-alpha',
    status: 'ready',
    auth: 'disabled',
    mode: 'session-based',
    endpoints: {
      mcp: '/mcp',
      health: '/'
    }
  });
});

// MCP POST endpoint - handles initialization and tool calls
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  console.log(`\n📥 POST /mcp`);
  console.log(`   Session: ${sessionId || 'new'}`);
  console.log(`   Method: ${req.body?.method}`);
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
        enableJsonResponse: true,
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
      
      const server = createBaseServer;
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
    
    await transport.handleRequest(req, res, req.body);
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
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  console.log(`\n📥 GET /mcp (SSE) - Session: ${sessionId}`);
  
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid session ID');
  }
  
  const transport = transports[sessionId];
  try {
    await transport.handleRequest(req, res);
    console.log(`   📤 SSE connection established`);
  } catch (error) {
    console.error('❌ Error handling SSE:', error);
    if (!res.headersSent) {
      res.status(500).send('Error establishing SSE connection');
    }
  }
});

// MCP DELETE endpoint - handles session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  
  console.log(`\n🗑️  DELETE /mcp - Session: ${sessionId}`);
  
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid session ID');
  }
  
  const transport = transports[sessionId];
  try {
    await transport.handleRequest(req, res);
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
    console.log(`\n🔗 Test with MCP Inspector:`);
    console.log(`   npx @modelcontextprotocol/inspector ${BASE_URL}/mcp`);
    console.log(`\n📝 Mode: Session-based (like oauth-test working server)`);
    console.log(`\n🔒 Sessions are created per-client for better security`);
    console.log(``);
  });
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason);
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
