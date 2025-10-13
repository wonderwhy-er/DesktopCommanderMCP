import express from 'express';

const app = express();
app.use(express.json());

// CORS - Required for MCP Inspector
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const MCP_VERSION = '2024-11-05';

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: 'http://localhost:3002',
    authorization_servers: ['http://localhost:3001'],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header']
  });
});

async function validateToken(token) {
  try {
    const r = await fetch('http://localhost:3001/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    return await r.json();
  } catch (e) {
    return { valid: false };
  }
}

app.post('/mcp', async (req, res) => {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).set('WWW-Authenticate', 
      'Bearer resource_metadata="http://localhost:3002/.well-known/oauth-protected-resource"'
    ).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authorization required' },
      id: null
    });
  }
  
  const v = await validateToken(auth.substring(7));
  if (!v.valid) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid token' },
      id: null
    });
  }
  
  const msg = req.body;
  
  if (msg.method === 'initialize') {
    console.log(`✅ Initialized: ${v.username}`);
    return res.json({
      jsonrpc: '2.0',
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'Desktop Commander', version: '1.0.0' }
      },
      id: msg.id
    });
  }
  
  if (msg.method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo a message',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message']
          }
        }]
      },
      id: msg.id
    });
  }
  
  if (msg.method === 'tools/call' && msg.params.name === 'echo') {
    return res.json({
      jsonrpc: '2.0',
      result: {
        content: [{ type: 'text', text: `${v.username}: ${msg.params.arguments.message}` }]
      },
      id: msg.id
    });
  }
  
  res.json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Method not found' },
    id: msg.id
  });
});

app.listen(3002, () => console.log('🛠️  MCP Server: http://localhost:3002 (CORS enabled)'));
