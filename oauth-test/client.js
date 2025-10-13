import express from 'express';
import { exec } from 'child_process';

const app = express();

// Client configuration
const CLIENT_ID = 'test-client';
const REDIRECT_URI = 'http://localhost:3000/callback';

let accessToken = null;

// STEP 1: Start OAuth flow
app.get('/start', (req, res) => {
  const authUrl = `http://localhost:3001/authorize?` + 
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `state=random-state-123`;
  
  console.log('🚀 Starting OAuth flow...');
  console.log('📝 Opening browser for user to login...');
  
  // Open browser automatically
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${command} "${authUrl}"`);
  
  res.send(`
    <html>
      <head><title>OAuth Client</title></head>
      <body>
        <h2>OAuth Flow Started</h2>
        <p>Browser should open automatically...</p>
        <p>If not, <a href="${authUrl}" target="_blank">click here to login</a></p>
        <p>After login, you'll be redirected back here.</p>
      </body>
    </html>
  `);
});

// STEP 2: Handle callback with authorization code
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.send('❌ Error: No authorization code received');
  }
  
  console.log(`✅ Received authorization code: ${code}`);
  console.log('🔄 Exchanging code for access token...');
  
  // Exchange code for token
  try {
    const response = await fetch('http://localhost:3001/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      return res.send(`❌ Error: ${data.error}`);
    }
    
    accessToken = data.access_token;
    console.log(`✅ Got access token: ${accessToken}`);
    
    res.send(`
      <html>
        <head><title>Success!</title></head>
        <body>
          <h2>✅ Authorization Successful!</h2>
          <p>Access token received: <code>${accessToken.substring(0, 20)}...</code></p>
          <p><a href="/use-tool">Click here to use the protected tool</a></p>
        </body>
      </html>
    `);
    
  } catch (err) {
    res.send(`❌ Error exchanging code: ${err.message}`);
  }
});

// STEP 3: Use the access token to call protected resource
app.get('/use-tool', async (req, res) => {
  if (!accessToken) {
    return res.send('❌ No access token. <a href="/start">Start OAuth flow first</a>');
  }
  
  console.log('🛠️  Calling protected resource with token...');
  
  try {
    const response = await fetch('http://localhost:3002/mcp/tools', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        tool_name: 'get_files',
        params: {}
      })
    });
    
    const data = await response.json();
    
    res.send(`
      <html>
        <head><title>Tool Result</title></head>
        <body>
          <h2>🎉 Protected Tool Executed!</h2>
          <pre>${JSON.stringify(data, null, 2)}</pre>
          <p><a href="/use-tool">Call again</a> | <a href="/start">Start new flow</a></p>
        </body>
      </html>
    `);
    
  } catch (err) {
    res.send(`❌ Error calling tool: ${err.message}`);
  }
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>OAuth Client</title></head>
      <body>
        <h2>Minimal OAuth Client Test</h2>
        <p><a href="/start">🚀 Start OAuth Flow</a></p>
      </body>
    </html>
  `);
});

app.listen(3000, () => {
  console.log('🌐 Client App running on http://localhost:3000');
  console.log('👉 Open browser to http://localhost:3000/start to test');
});
