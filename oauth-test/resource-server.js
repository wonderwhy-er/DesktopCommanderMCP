import express from 'express';

const app = express();
app.use(express.json());

// This is YOUR Desktop Commander server
// It has MCP tools that need protection

// Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: 'http://localhost:3002',
    authorization_servers: ['http://localhost:3001']
  });
});

// MCP Tools endpoint (protected)
app.post('/mcp/tools', async (req, res) => {
  const authHeader = req.headers.authorization;
  
  // Check if token is provided
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'No token provided',
      message: 'Please visit http://localhost:3001/authorize to login'
    });
  }
  
  const token = authHeader.substring(7);
  
  // Validate token with auth server
  try {
    const response = await fetch('http://localhost:3001/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    
    const result = await response.json();
    
    if (!result.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    // Token is valid! Execute the tool
    console.log(`✅ User ${result.username} accessing tool: ${req.body.tool_name}`);
    
    res.json({
      success: true,
      message: `Hello ${result.username}! Tool executed successfully.`,
      tool_name: req.body.tool_name,
      result: 'This is the protected data from Desktop Commander'
    });
    
  } catch (err) {
    res.status(500).json({ error: 'Could not validate token' });
  }
});

app.listen(3002, () => {
  console.log('🛠️  Resource Server (Desktop Commander) running on http://localhost:3002');
  console.log('📋 Try: curl http://localhost:3002/.well-known/oauth-protected-resource');
});
