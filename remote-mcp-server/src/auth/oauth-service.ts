import { Configuration, FrontendApi, IdentityApi } from '@ory/client';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface OAuthConfig {
  hydraAdminUrl: string;
  hydraPublicUrl: string;
  kratosAdminUrl: string;
  kratosPublicUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface UserInfo {
  id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}

export class OAuthService {
  private config: OAuthConfig;
  private kratosAdmin: IdentityApi;
  private kratosFrontend: FrontendApi;

  constructor(config: OAuthConfig) {
    this.config = config;

    // Initialize Kratos clients
    const kratosAdminConfig = new Configuration({
      basePath: config.kratosAdminUrl,
    });
    const kratosPublicConfig = new Configuration({
      basePath: config.kratosPublicUrl,
    });

    this.kratosAdmin = new IdentityApi(kratosAdminConfig);
    this.kratosFrontend = new FrontendApi(kratosPublicConfig);
  }

  /**
   * Initialize OAuth client with Hydra
   */
  async initializeOAuthClient(): Promise<void> {
    try {
      // Check if client already exists
      const checkResponse = await axios.get(
        `${this.config.hydraAdminUrl}/admin/clients/${this.config.clientId}`,
        { validateStatus: () => true }
      );

      if (checkResponse.status === 404) {
        // Client doesn't exist, create it
        await this.createOAuthClient();
      } else if (checkResponse.status === 200) {
        logger.info('OAuth client already exists');
      } else {
        throw new Error(`Failed to check OAuth client: ${checkResponse.status}`);
      }
    } catch (error) {
      logger.error('Failed to initialize OAuth client:', error);
      throw error;
    }
  }

  /**
   * Create OAuth client in Hydra
   */
  private async createOAuthClient(): Promise<void> {
    const clientConfig = {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [this.config.redirectUri],
      scope: this.config.scopes.join(' '),
      client_name: 'Remote MCP Client',
      client_uri: 'http://localhost:3003',
      policy_uri: 'http://localhost:3003/privacy',
      tos_uri: 'http://localhost:3003/terms',
    };

    const response = await axios.post(
      `${this.config.hydraAdminUrl}/admin/clients`,
      clientConfig
    );

    if (response.status !== 201) {
      throw new Error(`Failed to create OAuth client: ${response.status}`);
    }

    logger.info('OAuth client created successfully');
  }

  /**
   * Generate authorization URL for OAuth flow
   */
  generateAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
    });

    if (state) {
      params.set('state', state);
    }

    return `${this.config.hydraPublicUrl}/oauth2/auth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in: number;
  }> {
    const tokenData = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    };

    const response = await axios.post(
      `${this.config.hydraPublicUrl}/oauth2/token`,
      new URLSearchParams(tokenData),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Get user information from access token
   */
  async getUserInfo(accessToken: string): Promise<UserInfo> {
    const response = await axios.get(
      `${this.config.hydraPublicUrl}/userinfo`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(`Failed to get user info: ${response.status}`);
    }

    const userInfo = response.data;

    return {
      id: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      firstName: userInfo.given_name,
      lastName: userInfo.family_name,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    const tokenData = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    };

    const response = await axios.post(
      `${this.config.hydraPublicUrl}/oauth2/token`,
      new URLSearchParams(tokenData),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Revoke access token
   */
  async revokeToken(token: string): Promise<void> {
    const revokeData = {
      token,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    };

    await axios.post(
      `${this.config.hydraPublicUrl}/oauth2/revoke`,
      new URLSearchParams(revokeData),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
  }

  /**
   * Handle login flow from Hydra
   */
  async handleLoginRequest(loginChallenge: string): Promise<{
    redirectTo: string;
  }> {
    // Get login request details
    const loginRequest = await axios.get(
      `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/login`,
      {
        params: { login_challenge: loginChallenge },
      }
    );

    // Redirect to Kratos login
    const kratosLoginUrl = `${this.config.kratosPublicUrl}/self-service/login/browser?return_to=${encodeURIComponent(
      `http://localhost:4433/auth/login/callback?login_challenge=${loginChallenge}`
    )}`;

    return {
      redirectTo: kratosLoginUrl,
    };
  }

  /**
   * Accept login request and redirect to consent
   */
  async acceptLoginRequest(
    loginChallenge: string,
    subject: string
  ): Promise<{ redirectTo: string }> {
    const acceptData = {
      subject,
      remember: true,
      remember_for: 3600,
    };

    const response = await axios.put(
      `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/login/accept`,
      acceptData,
      {
        params: { login_challenge: loginChallenge },
      }
    );

    return {
      redirectTo: response.data.redirect_to,
    };
  }

  /**
   * Handle consent flow from Hydra
   */
  async handleConsentRequest(consentChallenge: string): Promise<{
    redirectTo: string;
  }> {
    // Get consent request details
    const consentRequest = await axios.get(
      `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/consent`,
      {
        params: { consent_challenge: consentChallenge },
      }
    );

    const requestedScopes = consentRequest.data.requested_scope;
    const subject = consentRequest.data.subject;

    // Auto-accept consent for now (in production, show consent screen)
    const acceptData = {
      grant_scope: requestedScopes,
      grant_access_token_audience: consentRequest.data.requested_access_token_audience,
      session: {
        id_token: {
          email: subject, // Will be replaced with actual user data
        },
      },
    };

    const response = await axios.put(
      `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/consent/accept`,
      acceptData,
      {
        params: { consent_challenge: consentChallenge },
      }
    );

    return {
      redirectTo: response.data.redirect_to,
    };
  }
}

// Create singleton instance
export const createOAuthService = (): OAuthService => {
  const config: OAuthConfig = {
    hydraAdminUrl: process.env.HYDRA_ADMIN_URL!,
    hydraPublicUrl: process.env.HYDRA_PUBLIC_URL!,
    kratosAdminUrl: process.env.KRATOS_ADMIN_URL!,
    kratosPublicUrl: process.env.KRATOS_PUBLIC_URL!,
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
    redirectUri: process.env.OAUTH_REDIRECT_URI!,
    scopes: (process.env.OAUTH_SCOPES || 'openid email profile').split(' '),
  };

  return new OAuthService(config);
};