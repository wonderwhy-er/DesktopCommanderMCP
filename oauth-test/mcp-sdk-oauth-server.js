import express from 'express';
import { randomUUID } from 'node:crypto';
import crypto from 'crypto';
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

console.log(`🚀 Starting MCP SDK Server with OAuth`);
console.log(`   Port: ${MCP_PORT}`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Auth: ${REQUIRE_AUTH ? 'ENABLED' : 'DISABLED'}`);

// In-memory storage for OAuth
const users = new Map([['admin', 'password123']]);
const codes = new Map();
const tokens = new Map();
const clients = new Map();

// Generate RSA keys for JWT
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

console.log('🔐 JWT Keys generated');

// Helper: Create JWT
function createJWT(payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'key-1' };
  const now = Math.floor(Date.now() / 1000);
  
  const claims = {
    ...payload,
    iat: now,
    exp: now + 3600,
    iss: BASE_URL,
    aud: BASE_URL
  };
  
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), privateKey);
  
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

function validateToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false };
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, error: 'Token expired' };
    }
    
    const signature = parts[2];
    const data = `${parts[0]}.${parts[1]}`;
    const valid = crypto.verify('sha256', Buffer.from(data), publicKey, Buffer.from(signature, 'base64url'));
    
    if (!valid) return { valid: false, error: 'Invalid signature' };
    
    return {
      valid: true,
      username: payload.sub,
      client_id: payload.client_id,
      scope: payload.scope
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

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
app.use(express.urlencoded({ extended: true }));

// CORS - allow all origins
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id']
}));

// Log ALL requests
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
  res.json = function(data) {
    const preview = JSON.stringify(data, null, 2).substring(0, 300);
    console.log(`   📤 Response ${res.statusCode}: ${preview}${preview.length >= 300 ? '...' : ''}`);
    return originalJson(data);
  };
  
  next();
});

// ==================== OAUTH ENDPOINTS ====================

// Authorization Server Metadata
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  if (!REQUIRE_AUTH) {
    return res.status(404).json({ error: 'OAuth disabled' });
  }
  
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:tools']
  });
});

// Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  if (!REQUIRE_AUTH) {
    return res.status(404).json({ error: 'OAuth disabled' });
  }
  
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header']
  });
});

// MCP-specific Protected Resource Metadata (ChatGPT queries this)
app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  if (!REQUIRE_AUTH) {
    return res.status(404).json({ error: 'OAuth disabled' });
  }
  
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header']
  });
});

// Client Registration
app.post('/register', (req, res) => {
  const { redirect_uris, client_name } = req.body;
  
  console.log(`\n🔐 CLIENT REGISTRATION`);
  console.log(`   Client Name: ${client_name}`);
  
  if (!redirect_uris || !Array.isArray(redirect_uris)) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }
  
  const clientId = crypto.randomUUID();
  clients.set(clientId, {
    client_id: clientId,
    client_name: client_name || 'MCP Client',
    redirect_uris: redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code']
  });
  
  console.log(`✅ Registered: ${clientId}`);
  
  res.status(201).json({
    client_id: clientId,
    client_name: client_name || 'MCP Client',
    redirect_uris: redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
});

// Authorization page (GET)
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method, scope } = req.query;
  
  const client = clients.get(client_id);
  if (!client) {
    return res.status(400).send('Invalid client_id');
  }
  
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send('Invalid redirect_uri');
  }
  
  res.send(`
    <html>
      <head>
        <title>Desktop Commander - Login</title>
        <style>
          body { font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px; }
          input { width: 100%; padding: 12px; margin: 10px 0; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #0066cc; color: white; border: none; cursor: pointer; }
          .info { background: #f0f0f0; padding: 10px; margin: 20px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h2>🔐 Login to Desktop Commander</h2>
        <div class="info"><strong>Client:</strong> ${client.client_name}</div>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="response_type" value="${response_type}">
          <input type="hidden" name="state" value="${state || ''}">
          <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
          <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}">
          <input type="hidden" name="scope" value="${scope || 'mcp:tools'}">
          <input type="text" name="username" placeholder="Username" required autofocus>
          <input type="password" name="password" placeholder="Password" required>
          <button type="submit">Login & Authorize</button>
        </form>
        <p style="text-align: center; color: #666;">
          Demo: <strong>admin</strong> / <strong>password123</strong>
        </p>
      </body>
    </html>
  `);
});

// Process login (POST)
app.post('/authorize', (req, res) => {
  const { username, password, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body;
  
  if (users.get(username) !== password) {
    return res.send('<html><body><h2>❌ Invalid credentials</h2></body></html>');
  }
  
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, {
    username,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope: scope || 'mcp:tools',
    expiresAt: Date.now() + 600000
  });
  
  console.log(`✅ User ${username} authorized`);
  
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  
  res.redirect(redirectUrl.toString());
});

// Token endpoint
app.post('/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;
  
  console.log(`\n🎫 TOKEN REQUEST from ${client_id}`);
  
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  
  const codeData = codes.get(code);
  
  if (!codeData || codeData.expiresAt < Date.now()) {
    codes.delete(code);
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  if (codeData.client_id !== client_id || codeData.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  // PKCE verification
  if (codeData.code_challenge) {
    if (!code_verifier) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
    }
    
    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (hash !== codeData.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code_verifier' });
    }
  }
  
  codes.delete(code);
  
  const accessToken = createJWT({
    sub: codeData.username,
    client_id: codeData.client_id,
    scope: codeData.scope
  });
  
  console.log(`✅ Issued token for ${codeData.username}`);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: codeData.scope
  });
});

// ==================== MCP ENDPOINTS ====================

// Auth middleware
const authMiddleware = async (req, res, next) => {
  if (!REQUIRE_AUTH) {
    return next();
  }
  
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authorization required' },
        id: null
      });
  }
  
  const validation = validateToken(auth.substring(7));
  if (!validation.valid) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid token' },
      id: null
    });
  }
  
  req.auth = validation;
  next();
};

// Map to store transports by session ID
const transports = {};

// MCP POST endpoint
app.post('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`\n📥 POST /mcp`);
  console.log(`   Session: ${sessionId || 'new'}`);
  console.log(`   Method: ${req.body?.method}`);
  if (req.auth) console.log(`   User: ${req.auth.username}`);
  
  try {
    let transport;
    
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        enableJsonResponse: true,  // CRITICAL: Avoid SSE through cloudflare tunnel
        onsessioninitialized: (sid) => {
          console.log(`✅ Session initialized: ${sid}`);
          transports[sid] = transport;
        }
      });
      
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`🔴 Session closed: ${sid}`);
          delete transports[sid];
        }
      };
      
      const server = getServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null
      });
      return;
    }
    
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('❌ Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null
      });
    }
  }
});

// MCP GET endpoint (SSE)
app.get('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`\n📥 GET /mcp (SSE) - Session: ${sessionId}`);
  
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid session ID');
  }
  
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// MCP DELETE endpoint
app.delete('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`\n📥 DELETE /mcp - Session: ${sessionId}`);
  
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid session ID');
  }
  
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Start server
app.listen(MCP_PORT, (error) => {
  if (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
  console.log(`\n✅ MCP SDK Server + OAuth running on ${BASE_URL}/mcp`);
  console.log(`\n📍 OAuth Endpoints:`);
  console.log(`   Login: ${BASE_URL}/authorize`);
  console.log(`   Token: ${BASE_URL}/token`);
  console.log(`\n🔐 Credentials: admin / password123`);
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
