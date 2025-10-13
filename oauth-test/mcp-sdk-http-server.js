import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';

// Configuration
const MCP_PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${MCP_PORT}`;
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== 'false';

console.log(`🚀 Starting MCP SDK Server`);
console.log(`   Port: ${MCP_PORT}`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Auth: ${REQUIRE_AUTH ? 'ENABLED' : 'DISABLED'}`);

// Create an MCP server
const getServer = () => {
  const server = new McpServer({
    name: 'Desktop Commander OAuth Test',
    version: '1.0.0',
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  // Register get_user_info tool
  server.registerTool('get_user_info', {
    title: 'Get User Info',
    description: 'Get authenticated user information',
    inputSchema: {}
  }, async () => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            username: 'anonymous',
            mode: REQUIRE_AUTH ? 'authenticated' : 'testing',
            message: REQUIRE_AUTH ? '🎉 OAuth authentication successful!' : '⚠️  Running without auth (testing mode)'
          }, null, 2)
        }
      ]
    };
  });

  // Register echo tool
  server.registerTool('echo', {
    title: 'Echo',
    description: 'Echo back a message',
    inputSchema: {
      message: z.string().describe('Message to echo')
    }
  }, async ({ message }) => {
    return {
      content: [
        {
          type: 'text',
          text: `Echo: ${message}`
        }
      ]
    };
  });

  return server;
};

const app = express();
app.use(express.json());

// CORS - allow all origins
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id']
}));

// Map to store transports by session ID
const transports = {};

// MCP POST endpoint
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`\n📥 POST /mcp`);
  console.log(`   Session ID: ${sessionId || 'none'}`);
  console.log(`   Method: ${req.body?.method}`);
  
  try {
    let transport;
    
    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      console.log(`   Using existing transport`);
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      console.log(`   Creating new transport`);
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sid) => {
          console.log(`✅ Session initialized: ${sid}`);
          transports[sid] = transport;
        }
      });
      
      // Clean up on close
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`🔴 Session closed: ${sid}`);
          delete transports[sid];
        }
      };
      
      // Connect transport to server
      const server = getServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      // Invalid request
      console.log(`   ❌ Invalid request: no session ID or not initialization`);
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided'
        },
        id: null
      });
      return;
    }
    
    // Handle request with existing transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('❌ Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

// MCP GET endpoint (for SSE)
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`\n📥 GET /mcp (SSE)`);
  console.log(`   Session ID: ${sessionId || 'none'}`);
  
  if (!sessionId || !transports[sessionId]) {
    console.log(`   ❌ Invalid or missing session ID`);
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  
  const lastEventId = req.headers['last-event-id'];
  if (lastEventId) {
    console.log(`   Resuming from event: ${lastEventId}`);
  }
  
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// MCP DELETE endpoint (session termination)
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`\n📥 DELETE /mcp`);
  console.log(`   Session ID: ${sessionId || 'none'}`);
  
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  
  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('❌ Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
});

// Start server
app.listen(MCP_PORT, (error) => {
  if (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
  console.log(`\n✅ MCP SDK Server running on ${BASE_URL}/mcp`);
  console.log(`\n📍 Ready for connections!`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing session ${sessionId}:`, error);
    }
  }
  console.log('✅ Server shutdown complete');
  process.exit(0);
});
