import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage (minimal!)
const users = new Map([
  ['admin', 'password123'] // username: password
]);
const codes = new Map(); // authorization codes
const tokens = new Map(); // access tokens

// STEP 1: Client asks "where do I get authorization?"
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    authorization_endpoint: 'http://localhost:3001/authorize',
    token_endpoint: 'http://localhost:3001/token'
  });
});

// STEP 2: User sees login page
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  
  res.send(`
    <html>
      <head><title>Login</title></head>
      <body>
        <h2>Login to Auth Server</h2>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="state" value="${state}">
          <input type="text" name="username" placeholder="Username" required><br>
          <input type="password" name="password" placeholder="Password" required><br>
          <button type="submit">Login & Authorize</button>
        </form>
        <p><small>Try: admin / password123</small></p>
      </body>
    </html>
  `);
});

// STEP 3: User submits login, get authorization code
app.post('/authorize', (req, res) => {
  const { username, password, client_id, redirect_uri, state } = req.body;
  
  // Check credentials
  if (users.get(username) !== password) {
    return res.send('Invalid username or password. <a href="/authorize">Try again</a>');
  }
  
  // Generate authorization code (short-lived)
  const code = crypto.randomBytes(16).toString('hex');
  codes.set(code, {
    username,
    client_id,
    redirect_uri,
    expiresAt: Date.now() + 60000 // 1 minute
  });
  
  console.log(`✅ Generated code: ${code} for user: ${username}`);
  
  // Redirect back to client with code
  const redirectUrl = `${redirect_uri}?code=${code}&state=${state}`;
  res.redirect(redirectUrl);
});

// STEP 4: Client exchanges code for access token
app.post('/token', (req, res) => {
  const { code, client_id, redirect_uri } = req.body;
  
  const codeData = codes.get(code);
  
  if (!codeData) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  if (codeData.expiresAt < Date.now()) {
    codes.delete(code);
    return res.status(400).json({ error: 'expired_code' });
  }
  
  if (codeData.client_id !== client_id || codeData.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  // Delete code (single use!)
  codes.delete(code);
  
  // Generate access token
  const accessToken = crypto.randomBytes(32).toString('hex');
  tokens.set(accessToken, {
    username: codeData.username,
    client_id,
    expiresAt: Date.now() + 3600000 // 1 hour
  });
  
  console.log(`✅ Generated token: ${accessToken} for user: ${codeData.username}`);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600
  });
});

// BONUS: Validate token endpoint (for resource server)
app.post('/validate', (req, res) => {
  const { token } = req.body;
  const tokenData = tokens.get(token);
  
  if (!tokenData || tokenData.expiresAt < Date.now()) {
    return res.status(401).json({ valid: false });
  }
  
  res.json({
    valid: true,
    username: tokenData.username,
    client_id: tokenData.client_id
  });
});

app.listen(3001, () => {
  console.log('🔐 Auth Server running on http://localhost:3001');
  console.log('📋 Try: curl http://localhost:3001/.well-known/oauth-authorization-server');
});
