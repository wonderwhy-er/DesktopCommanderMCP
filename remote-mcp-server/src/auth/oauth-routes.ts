import { Router, Request, Response } from 'express';
import { createOAuthService, OAuthService } from './oauth-service';
import { UserModel, DeviceModel } from '../database/models';
import { generateToken } from './middleware';
import { logger } from '../utils/logger';

export const createOAuthRoutes = (): Router => {
  const router = Router();
  const oauthService: OAuthService = createOAuthService();

  /**
   * Start OAuth flow
   * GET /auth/login
   */
  router.get('/login', (req: Request, res: Response) => {
    try {
      const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const authUrl = oauthService.generateAuthorizationUrl(state);
      
      // Store state in session/cookie for security
      res.cookie('oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 10 * 60 * 1000, // 10 minutes
      });

      res.redirect(authUrl);
    } catch (error) {
      logger.error('OAuth login error:', error);
      res.status(500).json({ error: 'OAuth initialization failed' });
    }
  });

  /**
   * OAuth callback handler
   * GET /auth/callback
   */
  router.get('/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        logger.error('OAuth callback error:', error);
        return res.status(400).json({ error: `OAuth error: ${error}` });
      }

      if (!code) {
        return res.status(400).json({ error: 'Missing authorization code' });
      }

      // Verify state parameter
      const storedState = req.cookies.oauth_state;
      if (!storedState || storedState !== state) {
        return res.status(400).json({ error: 'Invalid state parameter' });
      }

      // Exchange code for tokens
      const tokens = await oauthService.exchangeCodeForToken(code as string);
      
      // Get user information
      const userInfo = await oauthService.getUserInfo(tokens.access_token);

      // Create or update user in database
      let user = await UserModel.findByEmail(userInfo.email);
      if (!user) {
        user = await UserModel.create({
          email: userInfo.email,
          name: userInfo.name || `${userInfo.firstName || ''} ${userInfo.lastName || ''}`.trim(),
          provider: 'oauth',
          provider_id: userInfo.id,
        });
        logger.info(`Created new user: ${user.email}`);
      } else {
        // Update user information
        await UserModel.update(user.id, {
          name: userInfo.name || user.name,
          provider: 'oauth',
          provider_id: userInfo.id,
        });
        logger.info(`Updated existing user: ${user.email}`);
      }

      // Generate JWT token for the user
      const jwtToken = generateToken(user.id);

      // Clear the state cookie
      res.clearCookie('oauth_state');

      // Store tokens in session or return them
      res.cookie('access_token', jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      });

      // Redirect to success page or return tokens
      res.redirect(`/auth/success?user=${encodeURIComponent(user.email)}`);
      
    } catch (error) {
      logger.error('OAuth callback processing error:', error);
      res.status(500).json({ 
        error: 'OAuth callback processing failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * Handle Hydra login challenge
   * GET /auth/login-challenge?login_challenge=...
   */
  router.get('/login-challenge', async (req: Request, res: Response) => {
    try {
      const { login_challenge } = req.query;

      if (!login_challenge) {
        return res.status(400).json({ error: 'Missing login challenge' });
      }

      const result = await oauthService.handleLoginRequest(login_challenge as string);
      res.redirect(result.redirectTo);
      
    } catch (error) {
      logger.error('Login challenge error:', error);
      res.status(500).json({ error: 'Login challenge handling failed' });
    }
  });

  /**
   * Handle login callback from Kratos
   * GET /auth/login/callback
   */
  router.get('/login/callback', async (req: Request, res: Response) => {
    try {
      const { login_challenge } = req.query;

      if (!login_challenge) {
        return res.status(400).json({ error: 'Missing login challenge' });
      }

      // Here you would typically verify the Kratos session
      // For now, we'll mock a successful login
      const subject = 'user@example.com'; // Replace with actual user from Kratos session

      const result = await oauthService.acceptLoginRequest(
        login_challenge as string,
        subject
      );
      
      res.redirect(result.redirectTo);
      
    } catch (error) {
      logger.error('Login callback error:', error);
      res.status(500).json({ error: 'Login callback handling failed' });
    }
  });

  /**
   * Handle Hydra consent challenge
   * GET /auth/consent?consent_challenge=...
   */
  router.get('/consent', async (req: Request, res: Response) => {
    try {
      const { consent_challenge } = req.query;

      if (!consent_challenge) {
        return res.status(400).json({ error: 'Missing consent challenge' });
      }

      const result = await oauthService.handleConsentRequest(consent_challenge as string);
      res.redirect(result.redirectTo);
      
    } catch (error) {
      logger.error('Consent challenge error:', error);
      res.status(500).json({ error: 'Consent challenge handling failed' });
    }
  });

  /**
   * Handle logout
   * GET /auth/logout
   */
  router.get('/logout', (req: Request, res: Response) => {
    res.clearCookie('access_token');
    res.redirect('/');
  });

  /**
   * Success page after OAuth login
   * GET /auth/success
   */
  router.get('/success', (req: Request, res: Response) => {
    const user = req.query.user;
    res.send(`
      <html>
        <head>
          <title>Remote MCP - Login Success</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 5px; }
            .info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; padding: 15px; border-radius: 5px; margin-top: 20px; }
            code { background: #f8f9fa; padding: 2px 5px; border-radius: 3px; }
          </style>
        </head>
        <body>
          <h1>🎉 Remote MCP Login Success</h1>
          <div class="success">
            <strong>Successfully authenticated!</strong><br>
            Welcome, ${user}
          </div>
          <div class="info">
            <h3>Next Steps:</h3>
            <ol>
              <li>Start your local agent with your device token</li>
              <li>Use the MCP server with Claude Desktop</li>
              <li>Control your remote machine through Claude!</li>
            </ol>
            <p>
              <a href="/dashboard">Go to Dashboard</a> | 
              <a href="/auth/logout">Logout</a>
            </p>
          </div>
        </body>
      </html>
    `);
  });

  /**
   * Get current user info (for authenticated requests)
   * GET /auth/me
   */
  router.get('/me', async (req: Request, res: Response) => {
    try {
      // This would use your existing JWT middleware
      const token = req.cookies.access_token || req.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return res.status(401).json({ error: 'No authentication token' });
      }

      // Verify token and get user info
      // Implementation depends on your existing JWT verification
      res.json({ message: 'User info endpoint - implement JWT verification' });
      
    } catch (error) {
      logger.error('Get user info error:', error);
      res.status(500).json({ error: 'Failed to get user info' });
    }
  });

  return router;
};