import crypto from 'crypto';

interface JWTPayload {
  sub: string;
  client_id: string;
  scope: string;
  [key: string]: any;
}

interface TokenValidation {
  valid: boolean;
  username?: string;
  client_id?: string;
  scope?: string;
  error?: string;
}

interface ClientData {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
}

interface AuthCodeData {
  username: string;
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope: string;
  expiresAt: number;
}

export class OAuthManager {
  private users = new Map<string, string>([['admin', 'password123']]);
  private codes = new Map<string, AuthCodeData>();
  private clients = new Map<string, ClientData>();
  private privateKey: string;
  private publicKey: string;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    
    // Generate RSA keys for JWT signing
    const keys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    
    console.log('🔐 OAuth Manager: JWT Keys generated');
    
    // Pre-register well-known clients for common AI tools
    // This survives server restarts as they use fixed IDs
    this.preRegisterWellKnownClients();
  }

  /**
   * Pre-register well-known OAuth clients with fixed IDs
   * This prevents issues when server restarts and clients still have cached IDs
   */
  private preRegisterWellKnownClients(): void {
    // ChatGPT client
    const chatgptClient: ClientData = {
      client_id: 'chatgpt-fixed-client-id',
      client_name: 'ChatGPT',
      redirect_uris: [
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'https://chat.openai.com/connector_platform_oauth_redirect'
      ],
      grant_types: ['authorization_code'],
      response_types: ['code']
    };
    this.clients.set(chatgptClient.client_id, chatgptClient);
    console.log(`🔐 Pre-registered: ${chatgptClient.client_name} (${chatgptClient.client_id})`);
    
    // Claude client
    const claudeClient: ClientData = {
      client_id: 'claude-fixed-client-id',
      client_name: 'Claude',
      redirect_uris: [
        'https://claude.ai/oauth/callback',
        'http://localhost:3000/callback'
      ],
      grant_types: ['authorization_code'],
      response_types: ['code']
    };
    this.clients.set(claudeClient.client_id, claudeClient);
    console.log(`🔐 Pre-registered: ${claudeClient.client_name} (${claudeClient.client_id})`);
  }

  /**
   * Create a JWT token with the given payload
   */
  createJWT(payload: JWTPayload): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: 'key-1' };
    const now = Math.floor(Date.now() / 1000);
    
    const claims = {
      ...payload,
      iat: now,
      exp: now + 3600, // 1 hour expiration
      iss: this.baseUrl,
      aud: this.baseUrl
    };
    
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.sign(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      this.privateKey
    );
    
    return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
  }

  /**
   * Validate a JWT token
   */
  validateToken(token: string): TokenValidation {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return { valid: false, error: 'Invalid token format' };
      }
      
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      
      // Check expiration
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        return { valid: false, error: 'Token expired' };
      }
      
      // Verify signature
      const signature = parts[2];
      const data = `${parts[0]}.${parts[1]}`;
      const valid = crypto.verify(
        'sha256',
        Buffer.from(data),
        this.publicKey,
        Buffer.from(signature, 'base64url')
      );
      
      if (!valid) {
        return { valid: false, error: 'Invalid signature' };
      }
      
      return {
        valid: true,
        username: payload.sub,
        client_id: payload.client_id,
        scope: payload.scope
      };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Register a new OAuth client
   */
  registerClient(redirect_uris: string[], client_name?: string): ClientData {
    const clientId = crypto.randomUUID();
    const client: ClientData = {
      client_id: clientId,
      client_name: client_name || 'MCP Client',
      redirect_uris,
      grant_types: ['authorization_code'],
      response_types: ['code']
    };
    
    this.clients.set(clientId, client);
    console.log(`🔐 OAuth Manager: Registered client ${clientId} (${client.client_name})`);
    
    return client;
  }

  /**
   * Get a client by ID
   */
  getClient(clientId: string): ClientData | undefined {
    return this.clients.get(clientId);
  }

  /**
   * List all registered client IDs (for debugging)
   */
  listClients(): string {
    const ids = Array.from(this.clients.keys());
    return ids.length > 0 ? ids.join(', ') : 'none';
  }

  /**
   * Validate user credentials
   */
  validateUser(username: string, password: string): boolean {
    return this.users.get(username) === password;
  }

  /**
   * Create an authorization code
   */
  createAuthCode(data: Omit<AuthCodeData, 'expiresAt'>): string {
    const code = crypto.randomBytes(32).toString('base64url');
    this.codes.set(code, {
      ...data,
      expiresAt: Date.now() + 600000 // 10 minutes
    });
    
    console.log(`🔐 OAuth Manager: Created auth code for user ${data.username}`);
    return code;
  }

  /**
   * Validate and consume an authorization code
   */
  validateAuthCode(
    code: string,
    client_id: string,
    redirect_uri: string,
    code_verifier?: string
  ): { valid: boolean; data?: AuthCodeData; error?: string } {
    const codeData = this.codes.get(code);
    
    if (!codeData) {
      return { valid: false, error: 'Invalid or expired code' };
    }
    
    if (codeData.expiresAt < Date.now()) {
      this.codes.delete(code);
      return { valid: false, error: 'Code expired' };
    }
    
    if (codeData.client_id !== client_id || codeData.redirect_uri !== redirect_uri) {
      return { valid: false, error: 'Client ID or redirect URI mismatch' };
    }
    
    // PKCE verification
    if (codeData.code_challenge) {
      if (!code_verifier) {
        return { valid: false, error: 'code_verifier required' };
      }
      
      const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      if (hash !== codeData.code_challenge) {
        return { valid: false, error: 'Invalid code_verifier' };
      }
    }
    
    // Delete code after use (one-time use)
    this.codes.delete(code);
    
    return { valid: true, data: codeData };
  }
}
