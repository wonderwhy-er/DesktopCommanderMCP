import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// CORS middleware - CRITICAL for MCP Inspector
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  res.header('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Session-Id');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const MCP_VERSION = '2024-11-05';

// Protected Resource Metadata (RFC 9728)
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: 'http://localhost:3002',
    authorization_servers: ['http://localhost:3001'],
    scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
    bearer_methods_supported: ['header']
  });
});

// Validate token helper
async function validateToken(token) {
  try {
    const response = await fetch('http://localhost:3001/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    return await response.json();
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// MCP endpoint
app.post('/mcp', async (req, res) => {
  const authHeader = req.headers.authorization;
  
  // Check auth
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401)
      .set('WWW-Authenticate', 
        'Bearer resource_metadata="http://localhost:3002/.well-known/oauth-protected-resource"')
      .json({
        jsonrpc: '2.0',
        error: { 
          code: -32001, 
          message: 'Authorization required',
          data: { 
            hint: 'Visit http://localhost:3001/authorize to login' 
          }
        },
        id: null
      });
  }
  
  const token = authHeader.substring(7);
  const validation = await validateToken(token);
  
  if (!validation.valid) {
    return res.status(401)
      .set('WWW-Authenticate', 
        'Bearer error="invalid_token", error_description="Token validation failed"')
      .json({
        jsonrpc: '2.0',
        error: { 
          code: -32001, 
          message: 'Invalid or expired token'
        },
        id: null
      });
  }
  
  const message = req.body;
  
  // Handle MCP methods
  if (message.method === 'initialize') {
    console.log(`✅ MCP client initialized (user: ${validation.username})`);
    return res.json({
      jsonrpc: '2.0',
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: 'Desktop Commander OAuth Test',
          version: '1.0.0'
        }
      },
      id: message.id
    });
  }
  
  if (message.method === 'tools/list') {
    console.log(`📋 Listing tools for user: ${validation.username}`);
    return res.json({
      jsonrpc: '2.0',
      result: {
        tools: [
          {
            name: 'get_user_info',
            description: 'Get information about the authenticated user',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'echo',
            description: 'Echo back a message',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Message to echo' }
              },
              required: ['message']
            }
          }
        ]
      },
      id: message.id
    });
  }
  
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    
    console.log(`🛠️  Tool called: ${name} by user: ${validation.username}`);
    
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
              message: 'You are successfully authenticated with OAuth!'
            }, null, 2)
          }]
        },
        id: message.id
      });
    }
    
    if (name === 'echo') {
      return res.json({
        jsonrpc: '2.0',
        result: {
          content: [{
            type: 'text',
            text: `Echo from ${validation.username}: ${args.message}`
          }]
        },
        id: message.id
      });
    }
    
    return res.json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: `Unknown tool: ${name}`
      },
      id: message.id
    });
  }
  
  // Unknown method
  return res.json({
    jsonrpc: '2.0',
    error: {
      code: -32601,
      message: `Method not found: ${message.method}`
    },
    id: message.id
  });
});

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`🛠️  MCP Resource Server running on http://localhost:${PORT}`);
  console.log('');
  console.log('✅ CORS enabled for MCP Inspector');
  console.log('✅ Ready for MCP clients!');
});
