import express from 'express';
import { createServer } from 'http';
import open from 'open';
import readline from 'readline';

export class AgentAuthenticator {
  constructor(baseServerUrl) {
    this.baseServerUrl = baseServerUrl;
  }

  async authenticate() {
    // Detect environment
    const isDesktop = this.isDesktopEnvironment();
    
    console.log(`🔐 Starting authentication (${isDesktop ? 'desktop' : 'headless'} mode)...`);
    
    if (isDesktop) {
      return this.authenticateDesktop();
    } else {
      return this.authenticateHeadless();
    }
  }

  isDesktopEnvironment() {
    // Check if we're in a desktop environment
    return process.platform === 'darwin' || 
           process.platform === 'win32' || 
           (process.platform === 'linux' && process.env.DISPLAY);
  }

  async authenticateDesktop() {
    const app = express();
    const callbackPort = 8080;
    const callbackUrl = `http://localhost:${callbackPort}/callback`;
    
    return new Promise((resolve, reject) => {
      let server;
      
      // Setup callback handler
      app.get('/callback', (req, res) => {
        const { access_token, code, error, error_description } = req.query;
        
        // Extract the actual token (could be in access_token or code parameter)
        const token = access_token || code;
        
        console.log('🔍 Callback received:', {
          hasAccessToken: !!access_token,
          hasCode: !!code,
          hasError: !!error,
          queryParams: Object.keys(req.query)
        });
        
        if (error) {
          res.send(`
            <h2>Authentication Failed</h2>
            <p>Error: ${error}</p>
            <p>Description: ${error_description || 'Unknown error'}</p>
            <p>You can close this window.</p>
          `);
          server.close();
          reject(new Error(`${error}: ${error_description}`));
        } else if (token) {
          res.send(`
            <h2>Authentication Successful!</h2>
            <p>Your agent is now connected.</p>
            <p>You can close this window.</p>
          `);
          server.close();
          console.log('✅ Authentication successful, token received');
          resolve(token);
        } else {
          console.log('❌ No token found in callback:', req.query);
          res.send(`
            <h2>Authentication Failed</h2>
            <p>No access token received</p>
            <p>Received parameters: ${Object.keys(req.query).join(', ')}</p>
            <p>You can close this window.</p>
          `);
          server.close();
          reject(new Error('No access token received'));
        }
      });

      // Start callback server
      server = createServer(app);
      server.listen(callbackPort, (err) => {
        if (err) {
          reject(new Error(`Failed to start callback server: ${err.message}`));
          return;
        }

        // Generate OAuth URL with callback
        const authUrl = `${this.baseServerUrl}/auth.html?redirect_uri=${encodeURIComponent(callbackUrl)}&agent=true`;
        
        console.log('🌐 Opening browser for authentication...');
        console.log(`If browser doesn't open, visit: ${authUrl}`);
        
        // Open browser
        open(authUrl).catch(() => {
          console.log('Could not open browser automatically.');
          console.log(`Please visit: ${authUrl}`);
        });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (server.listening) {
          server.close();
          reject(new Error('Authentication timeout - no response received'));
        }
      }, 5 * 60 * 1000);
    });
  }

  async authenticateHeadless() {
    console.log('\n🔗 Manual Authentication Required:');
    console.log('─'.repeat(50));
    console.log(`1. Open this URL in a browser: ${this.baseServerUrl}/auth.html`);
    console.log('2. Complete the authentication process');
    console.log('3. Copy the access_token from the result');
    console.log('4. Paste it below');
    console.log('─'.repeat(50));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve, reject) => {
      rl.question('\n🔑 Enter Access Token: ', (token) => {
        rl.close();
        
        const trimmedToken = token.trim();
        if (!trimmedToken) {
          reject(new Error('Empty token provided'));
        } else if (trimmedToken.length < 10) {
          reject(new Error('Invalid token format (too short)'));
        } else {
          resolve(trimmedToken);
        }
      });
    });
  }
}