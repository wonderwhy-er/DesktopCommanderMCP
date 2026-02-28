/**
 * Streamable HTTP transport for DesktopCommanderMCP with OAuth 2.1 support.
 *
 * Allows Claude Web (claude.ai) to connect to this MCP server over HTTP.
 * Intended to sit behind an nginx reverse proxy that handles TLS termination.
 *
 * OAuth flow (handled automatically by Claude Web):
 *   1. Client POSTs to /mcp, gets 401
 *   2. Client discovers metadata at /.well-known/oauth-protected-resource/mcp
 *   3. Client gets auth server metadata at /.well-known/oauth-authorization-server
 *   4. Client registers via DCR at /register (or uses pre-configured client_id/secret)
 *   5. Client redirects user to /authorize
 *   6. Server auto-approves and redirects back with auth code
 *   7. Client exchanges code for token at /token
 *   8. Client uses Bearer token for /mcp requests
 *
 * Usage:
 *   node dist/index.js http
 *   PUBLIC_URL=https://serea.xyz OAUTH_CLIENT_ID=... OAUTH_CLIENT_SECRET=... node dist/index.js http
 */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
// @ts-ignore - express types not installed
import type { Response } from 'express';
import { createServer } from './server.js';
import { configManager } from './config-manager.js';
import { featureFlagManager } from './utils/feature-flags.js';

const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = '127.0.0.1';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID!;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET!;

if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
  console.error('[http] OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET env vars are required.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Pre-registered client store (no DCR — only known client_id can connect)
// ---------------------------------------------------------------------------

class PreRegisteredClientsStore implements OAuthRegisteredClientsStore {
  private client: OAuthClientInformationFull;

  constructor(clientId: string, clientSecret: string) {
    this.client = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Claude Web',
    } as OAuthClientInformationFull;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (clientId === this.client.client_id) {
      return this.client;
    }
    return undefined;
  }

  // No registerClient method = DCR disabled
}

class AutoApproveOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PreRegisteredClientsStore;
  private codes = new Map<string, { client: OAuthClientInformationFull; params: AuthorizationParams }>();
  private tokens = new Map<string, { token: string; clientId: string; scopes: string[]; expiresAt: number; resource?: URL }>();

  constructor(clientId: string, clientSecret: string) {
    this.clientsStore = new PreRegisteredClientsStore(clientId, clientSecret);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const code = randomUUID();
    this.codes.set(code, { client, params });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) {
      searchParams.set('state', params.state);
    }

    // Auto-approve: redirect immediately with auth code
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    console.log(`[oauth] Auto-approved authorization for client ${client.client_id}`);
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error('Invalid authorization code');
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error('Invalid authorization code');
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    this.codes.delete(authorizationCode);

    const token = randomUUID();
    this.tokens.set(token, {
      token,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt: Date.now() + 3600000, // 1 hour
      resource: codeData.params.resource,
    });

    console.log(`[oauth] Issued access token for client ${client.client_id}`);
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      scope: (codeData.params.scopes || []).join(' '),
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    throw new Error('Refresh tokens not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.tokens.get(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new Error('Invalid or expired token');
    }
    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }
}

// ---------------------------------------------------------------------------
// Active MCP transports keyed by session ID
// ---------------------------------------------------------------------------
const sessions = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Load configuration
  try {
    await configManager.loadConfig();
    await featureFlagManager.initialize();
  } catch (err) {
    console.error('[http] Failed to load config, continuing with defaults:', err);
  }

  const issuerUrl = new URL(PUBLIC_URL);
  const mcpServerUrl = new URL('/mcp', PUBLIC_URL);

  const provider = new AutoApproveOAuthProvider(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);

  const publicHostname = new URL(PUBLIC_URL).hostname;
  const app = createMcpExpressApp({ host: HOST, allowedHosts: [publicHostname, HOST, 'localhost'] });

  // Trust the nginx reverse proxy (fixes express-rate-limit X-Forwarded-For error)
  app.set('trust proxy', 1);

  // ---------- OAuth routes (authorize, token, register, metadata) ----------
  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: mcpServerUrl,
    scopesSupported: ['mcp:tools'],
    resourceName: 'DesktopCommanderMCP',
  }));

  // ---------- Bearer auth middleware for /mcp ----------
  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
  });

  // ---------- POST /mcp ----------
  app.post('/mcp', authMiddleware, async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          console.log(`[http] Session initialized: ${sid}`);
          sessions.set(sid, transport);
        },
      });

      const server = createServer();

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          console.log(`[http] Session closed: ${sid}`);
          sessions.delete(sid);
        }
        transport.close().catch(() => {});
        server.close().catch(() => {});
      };

      await server.connect(transport);
    } else {
      res.status(400).json({ error: 'Bad Request: no valid session. Send an initialize request first.' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ---------- GET /mcp (SSE) ----------
  app.get('/mcp', authMiddleware, async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Bad Request: invalid or missing session ID.' });
      return;
    }
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // ---------- DELETE /mcp ----------
  app.delete('/mcp', authMiddleware, async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Bad Request: invalid or missing session ID.' });
      return;
    }
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // ---------- Health check ----------
  app.get('/health', (_req: any, res: any) => {
    res.json({ status: 'ok', sessions: sessions.size });
  });

  // ---------- Start listening ----------
  const httpServer = createHttpServer(app);
  httpServer.listen(PORT, HOST, () => {
    console.log(`[http] MCP server listening on http://${HOST}:${PORT}`);
    console.log(`[http] Public URL: ${PUBLIC_URL}`);
    console.log(`[http] MCP endpoint: ${mcpServerUrl.href}`);
    console.log(`[http] Health check: ${PUBLIC_URL}/health`);
    console.log(`[http] OAuth metadata: ${PUBLIC_URL}/.well-known/oauth-authorization-server`);
    console.log(`[http] OAuth authorize: ${PUBLIC_URL}/authorize`);
    console.log(`[http] OAuth token: ${PUBLIC_URL}/token`);
    console.log(`[http] OAuth client ID: ${OAUTH_CLIENT_ID}`);
    console.log(`[http] DCR disabled — only pre-registered client can connect`);
  });

  // ---------- Graceful shutdown ----------
  const shutdown = async (signal: string) => {
    console.log(`[http] Received ${signal}, shutting down...`);
    for (const [sid, transport] of sessions) {
      try { await transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[http] Fatal error:', err);
  process.exit(1);
});
