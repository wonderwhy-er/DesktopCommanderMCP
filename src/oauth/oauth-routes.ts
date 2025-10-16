import { Router, Request, Response } from 'express';
import { OAuthManager } from './oauth-manager.js';

export function createOAuthRoutes(oauthManager: OAuthManager, baseUrl: string): Router {
  const router = Router();

  // ==================== DISCOVERY ENDPOINTS ====================

  /**
   * OAuth Authorization Server Metadata
   * https://tools.ietf.org/html/rfc8414
   */
  router.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools']
    });
  });

  /**
   * MCP-specific OAuth Authorization Server Metadata
   * ChatGPT requires this endpoint with pre-registered client_id
   */
  router.get('/.well-known/oauth-authorization-server/mcp', (req: Request, res: Response) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools'],
      // MCP-specific: Pre-registered client for ChatGPT
      mcp: {
        client_id: 'chatgpt-fixed-client-id',
        redirect_uri: `${baseUrl}/callback`
      }
    });
  });

  /**
   * OAuth Protected Resource Metadata
   * https://tools.ietf.org/html/rfc8707
   */
  router.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header']
    });
  });

  /**
   * MCP-specific OAuth Protected Resource Metadata
   * ChatGPT queries this variant
   */
  router.get('/.well-known/oauth-protected-resource/mcp', (req: Request, res: Response) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header']
    });
  });

  // ==================== CLIENT REGISTRATION ====================

  /**
   * Dynamic Client Registration
   * https://tools.ietf.org/html/rfc7591
   */
  router.post('/register', (req: Request, res: Response) => {
    const { redirect_uris, client_name } = req.body;
    
    console.log(`\n🔐 CLIENT REGISTRATION`);
    console.log(`   Client Name: ${client_name || 'Unnamed'}`);
    console.log(`   Redirect URIs:`, redirect_uris);
    
    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array'
      });
    }
    
    // Check if this looks like ChatGPT
    const isChatGPT = redirect_uris.some(uri => 
      uri.includes('chatgpt.com') || uri.includes('openai.com')
    );
    
    // Check if this looks like Claude
    const isClaude = redirect_uris.some(uri => 
      uri.includes('claude.ai') || uri.includes('anthropic.com')
    );
    
    let client;
    
    if (isChatGPT) {
      // Return pre-registered ChatGPT client
      client = oauthManager.getClient('chatgpt-fixed-client-id');
      console.log(`✅ Using pre-registered ChatGPT client`);
      
      // Add any new redirect URIs they're using
      redirect_uris.forEach(uri => {
        if (!client!.redirect_uris.includes(uri)) {
          client!.redirect_uris.push(uri);
          console.log(`   📝 Added redirect_uri: ${uri}`);
        }
      });
    } else if (isClaude) {
      // Return pre-registered Claude client
      client = oauthManager.getClient('claude-fixed-client-id');
      console.log(`✅ Using pre-registered Claude client`);
      
      // Add any new redirect URIs they're using
      redirect_uris.forEach(uri => {
        if (!client!.redirect_uris.includes(uri)) {
          client!.redirect_uris.push(uri);
          console.log(`   📝 Added redirect_uri: ${uri}`);
        }
      });
    } else {
      // Register new client for other tools
      client = oauthManager.registerClient(redirect_uris, client_name);
      console.log(`✅ Registered new client: ${client.client_id}`);
    }
    
    res.status(201).json({
      client_id: client!.client_id,
      client_name: client!.client_name,
      redirect_uris: client!.redirect_uris,
      grant_types: client!.grant_types,
      response_types: client!.response_types,
      token_endpoint_auth_method: 'none'
    });
  });

  // ==================== AUTHORIZATION ====================

  /**
   * Authorization Endpoint (GET) - Display login page
   */
  router.get('/authorize', (req: Request, res: Response) => {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method, scope } = req.query;
    
    console.log(`\n🔐 AUTHORIZATION REQUEST`);
    console.log(`   Client ID: ${client_id}`);
    console.log(`   Redirect URI: ${redirect_uri}`);
    console.log(`   Response Type: ${response_type}`);
    console.log(`   State: ${state}`);
    console.log(`   Code Challenge: ${code_challenge ? 'present' : 'missing'}`);
    console.log(`   Scope: ${scope}`);
    
    // Validate client
    const client = oauthManager.getClient(client_id as string);
    if (!client) {
      console.log(`❌ Client ${client_id} not found. Was /register called?`);
      console.log(`   Registered clients: ${oauthManager.listClients()}`);
      return res.status(400).send(`
        <html>
          <head><title>Error</title></head>
          <body style="font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px;">
            <h2>❌ Invalid Client</h2>
            <p>The client_id <code>${client_id}</code> is not recognized.</p>
            <p><small>The client must register at <code>/register</code> first.</small></p>
          </body>
        </html>
      `);
    }
    
    console.log(`✅ Client validated: ${client.client_name}`);
    
    // Validate redirect_uri
    if (!client.redirect_uris.includes(redirect_uri as string)) {
      console.log(`❌ Invalid redirect_uri: ${redirect_uri}`);
      console.log(`   Registered URIs:`, client.redirect_uris);
      return res.status(400).send(`
        <html>
          <head><title>Error</title></head>
          <body style="font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px;">
            <h2>❌ Invalid Redirect URI</h2>
            <p>The redirect_uri <code>${redirect_uri}</code> is not registered for this client.</p>
            <p><strong>Registered URIs for ${client.client_name}:</strong></p>
            <ul>
              ${client.redirect_uris.map(uri => `<li><code>${uri}</code></li>`).join('')}
            </ul>
          </body>
        </html>
      `);
    }
    
    // Display login page
    res.send(`
      <html>
        <head>
          <title>Desktop Commander - Login</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              max-width: 400px;
              margin: 50px auto;
              padding: 20px;
              background: #f5f5f5;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h2 {
              margin-top: 0;
              color: #333;
            }
            .info {
              background: #f0f0f0;
              padding: 15px;
              margin: 20px 0;
              border-radius: 5px;
              font-size: 14px;
            }
            input {
              width: 100%;
              padding: 12px;
              margin: 10px 0;
              box-sizing: border-box;
              border: 1px solid #ddd;
              border-radius: 5px;
              font-size: 16px;
            }
            button {
              width: 100%;
              padding: 14px;
              background: #0066cc;
              color: white;
              border: none;
              border-radius: 5px;
              cursor: pointer;
              font-size: 16px;
              font-weight: 600;
            }
            button:hover {
              background: #0052a3;
            }
            .demo-creds {
              text-align: center;
              color: #666;
              margin-top: 20px;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>🔐 Login to Desktop Commander</h2>
            <div class="info">
              <strong>Client:</strong> ${client.client_name}
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
            <div class="demo-creds">
              Demo credentials:<br>
              <strong>admin</strong> / <strong>password123</strong>
            </div>
          </div>
        </body>
      </html>
    `);
  });

  /**
   * Authorization Endpoint (POST) - Process login
   */
  router.post('/authorize', (req: Request, res: Response) => {
    const {
      username,
      password,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      scope
    } = req.body;
    
    console.log(`\n🔐 PROCESSING LOGIN`);
    console.log(`   Username: ${username}`);
    console.log(`   Client ID: ${client_id}`);
    
    // Validate credentials
    if (!oauthManager.validateUser(username, password)) {
      return res.send(`
        <html>
          <head><title>Login Failed</title></head>
          <body style="font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px;">
            <h2>❌ Invalid Credentials</h2>
            <p>The username or password is incorrect.</p>
            <a href="/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&state=${state || ''}&code_challenge=${code_challenge || ''}&code_challenge_method=${code_challenge_method || ''}&scope=${scope || 'mcp:tools'}">Try Again</a>
          </body>
        </html>
      `);
    }
    
    // Create authorization code
    const code = oauthManager.createAuthCode({
      username,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope: scope || 'mcp:tools'
    });
    
    console.log(`✅ User ${username} authorized, redirecting...`);
    
    // Redirect back to client with authorization code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }
    
    res.redirect(redirectUrl.toString());
  });

  // ==================== TOKEN ENDPOINT ====================

  /**
   * Callback endpoint - for compatibility with MCP discovery
   * This redirects to the client's actual redirect_uri with the code
   */
  router.get('/callback', (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query;
    
    console.log(`\n🔄 CALLBACK`);
    console.log(`   Code: ${code ? 'present' : 'missing'}`);
    console.log(`   State: ${state}`);
    
    if (error) {
      return res.send(`
        <html>
          <head><title>OAuth Error</title></head>
          <body style="font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px;">
            <h2>❌ OAuth Error</h2>
            <p><strong>Error:</strong> ${error}</p>
            <p><strong>Description:</strong> ${error_description || 'No description provided'}</p>
          </body>
        </html>
      `);
    }
    
    // This endpoint shouldn't really be called directly
    // It's here for compatibility with the MCP discovery document
    res.send(`
      <html>
        <head><title>OAuth Callback</title></head>
        <body style="font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px;">
          <h2>✅ Authorization Successful</h2>
          <p>You can close this window and return to the application.</p>
        </body>
      </html>
    `);
  });

  /**
   * Token Endpoint - Exchange authorization code for access token
   */
  router.post('/token', (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;
    
    console.log(`\n🎫 TOKEN REQUEST`);
    console.log(`   Grant Type: ${grant_type}`);
    console.log(`   Client ID: ${client_id}`);
    
    // Validate grant type
    if (grant_type !== 'authorization_code') {
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant type is supported'
      });
    }
    
    // Validate authorization code
    const validation = oauthManager.validateAuthCode(code, client_id, redirect_uri, code_verifier);
    
    if (!validation.valid) {
      console.log(`❌ Token request failed: ${validation.error}`);
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: validation.error
      });
    }
    
    // Create access token
    const accessToken = oauthManager.createJWT({
      sub: validation.data!.username,
      client_id: validation.data!.client_id,
      scope: validation.data!.scope
    });
    
    console.log(`✅ Issued token for ${validation.data!.username}`);
    
    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: validation.data!.scope
    });
  });

  return router;
}
