import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware - CRITICAL for web clients
app.use((req, res, next) => {
  console.log(`\n🔍 ${req.method} ${req.path}`);
  console.log('Headers:', req.headers.authorization ? `Bearer ${req.headers.authorization.substring(7, 20)}...` : 'None');
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MCP_VERSION = '2024-11-05';

// In-memory storage
const users = new Map([['admin', 'password123']]);
const codes = new Map();
const clients = new Map();

// Generate RSA keys for JWT
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// ==================== JWT HELPERS ====================
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

// ==================== OAUTH METADATA ENDPOINTS ====================

// Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    jwks_uri: `${BASE_URL}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts']
  });
});

// Protected Resource Metadata (RFC 9728)
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
    bearer_methods_supported: ['header']
  });
});

// JWKS endpoint
app.get('/.well-known/jwks.json', (req, res) => {
  res.json({
    keys: [{
      kty: 'RSA',
      use: 'sig',
      kid: 'key-1',
      alg: 'RS256',
      n: publicKey.split('\n').slice(1, -2).join(''),
      e: 'AQAB'
    }]
  });
});

// ==================== OAUTH ENDPOINTS ====================

// Dynamic Client Registration (RFC 7591)
app.post('/register', (req, res) => {
  const { redirect_uris, client_name } = req.body;
  
  if (!redirect_uris || !Array.isArray(redirect_uris)) {
    return res.status(400).json({ 
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be an array'
    });
  }
  
  const clientId = crypto.randomUUID();
  
  clients.set(clientId, {
    client_id: clientId,
    client_name: client_name || 'MCP Client',
    redirect_uris: redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code']
  });
  
  console.log(`✅ Registered client: ${clientId} (${client_name})`);
  
  res.status(201).json({
    client_id: clientId,
    client_name: client_name || 'MCP Client',
    redirect_uris: redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
});

// Authorization page (GET - show login form)
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method, scope } = req.query;
  
  let client = clients.get(client_id);
  
  // Auto-register client if not found (for easier testing)
  if (!client) {
    client = {
      client_id: client_id,
      client_name: 'Auto-registered MCP Client',
      redirect_uris: [redirect_uri],
      grant_types: ['authorization_code'],
      response_types: ['code']
    };
    clients.set(client_id, client);
    console.log(`✅ Auto-registered client: ${client_id}`);
  }
  
  if (!client.redirect_uris.includes(redirect_uri)) {
    // Add redirect_uri if not already in list
    client.redirect_uris.push(redirect_uri);
    console.log(`✅ Added redirect_uri: ${redirect_uri}`);
  }
  
  res.send(`
    <html>
      <head>
        <title>Desktop Commander - Login</title>
        <style>
          body { font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px; }
          input { width: 100%; padding: 12px; margin: 10px 0; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #0066cc; color: white; border: none; cursor: pointer; }
          button:hover { background: #0052a3; }
          .info { background: #f0f0f0; padding: 10px; margin: 20px 0; border-radius: 5px; font-size: 14px; }
        </style>
      </head>
      <body>
        <h2>🔐 Login to Desktop Commander</h2>
        <div class="info">
          <strong>Client:</strong> ${client.client_name}<br>
          <strong>Requesting:</strong> ${scope || 'mcp:tools'}
        </div>
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
        <p style="text-align: center; color: #666; font-size: 14px;">
          Demo credentials: <strong>admin</strong> / <strong>password123</strong>
        </p>
      </body>
    </html>
  `);
});

// Process login (POST)
app.post('/authorize', (req, res) => {
  const { username, password, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body;
  
  if (users.get(username) !== password) {
    return res.send(`
      <html><body>
        <h2>❌ Invalid credentials</h2>
        <a href="/authorize?${new URLSearchParams(req.body)}">Try again</a>
      </body></html>
    `);
  }
  
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, {
    username,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope: scope || 'mcp:tools',
    expiresAt: Date.now() + 600000 // 10 minutes
  });
  
  console.log(`✅ User ${username} authorized client ${client_id}`);
  
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  
  res.redirect(redirectUrl.toString());
});

// Token endpoint
app.post('/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;
  
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
      return res.status(400).json({ 
        error: 'invalid_grant',
        error_description: 'code_verifier required'
      });
    }
    
    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    
    if (hash !== codeData.code_challenge) {
      return res.status(400).json({ 
        error: 'invalid_grant',
        error_description: 'Invalid code_verifier'
      });
    }
  }
  
  codes.delete(code);
  
  const accessToken = createJWT({
    sub: codeData.username,
    client_id: codeData.client_id,
    scope: codeData.scope
  });
  
  console.log(`✅ Issued token for user: ${codeData.username}`);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: codeData.scope
  });
});

// ==================== MCP ENDPOINT ====================

app.post('/mcp', async (req, res) => {
  const auth = req.headers.authorization;
  
  // Check authentication
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authorization required' },
        id: null
      });
  }
  
  // Validate token
  const validation = validateToken(auth.substring(7));
  if (!validation.valid) {
    return res.status(401)
      .set('WWW-Authenticate', 'Bearer error="invalid_token"')
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or expired token' },
        id: null
      });
  }
  
  const msg = req.body;
  
  // Handle MCP methods
  if (msg.method === 'initialize') {
    console.log(`✅ MCP initialized: ${validation.username}`);
    return res.json({
      jsonrpc: '2.0',
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: { 
          tools: { listChanged: true },
          resources: {},
          prompts: {}
        },
        serverInfo: { name: 'Desktop Commander OAuth Test', version: '1.0.0' },
        // Include tools directly in initialize for clients that expect it
        tools: [
          {
            name: 'get_user_info',
            description: 'Get authenticated user information',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'echo',
            description: 'Echo back a message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string', description: 'Message to echo' } },
              required: ['message']
            }
          }
        ]
      },
      id: msg.id
    });
  }
  
  if (msg.method === 'tools/list') {
    console.log(`📋 Listing tools for: ${validation.username}`);
    return res.json({
      jsonrpc: '2.0',
      result: {
        tools: [
          {
            name: 'get_user_info',
            description: 'Get authenticated user information',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'echo',
            description: 'Echo back a message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string', description: 'Message to echo' } },
              required: ['message']
            }
          }
        ]
      },
      id: msg.id
    });
  }
  
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    
    console.log(`🛠️  Tool called: ${name} by ${validation.username}`);
    
    if (name === 'get_user_info') {
      return res.json({
        jsonrpc: '2.0',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              username: validation.username,
              client_id: validation.client_id,
              scope: validation.scope,
              message: '🎉 OAuth authentication successful!'
            }, null, 2)
          }]
        },
        id: msg.id
      });
    }
    
    if (name === 'echo') {
      return res.json({
        jsonrpc: '2.0',
        result: {
          content: [{ type: 'text', text: `Echo from ${validation.username}: ${args.message}` }]
        },
        id: msg.id
      });
    }
    
    return res.json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Unknown tool: ${name}` },
      id: msg.id
    });
  }
  
  // Unknown method
  res.json({
    jsonrpc: '2.0',
    error: { code: -32601, message: `Method not found: ${msg.method}` },
    id: msg.id
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Unified MCP OAuth Server running on ${BASE_URL}`);
  console.log('');
  console.log('📍 Endpoints:');
  console.log(`   OAuth Metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`   MCP Metadata:   ${BASE_URL}/.well-known/oauth-protected-resource`);
  console.log(`   MCP Endpoint:   ${BASE_URL}/mcp`);
  console.log(`   Login:          ${BASE_URL}/authorize`);
  console.log('');
  console.log('✅ CORS enabled for web clients');
  console.log('✅ Ready for Claude.ai and ChatGPT!');
  console.log('');
  console.log('🔐 Demo credentials: admin / password123');
});
