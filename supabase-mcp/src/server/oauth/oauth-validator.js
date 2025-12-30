/**
 * OAuth Request Validation Utilities
 * Handles validation of OAuth 2.0 parameters and PKCE requirements
 */

import { serverLogger } from '../../utils/logger.js';

export class OAuthValidator {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
  }

  /**
   * Validate OAuth authorization request parameters
   */
  validateAuthorizationRequest(params) {
    const { 
      response_type, 
      client_id, 
      redirect_uri, 
      scope, 
      code_challenge, 
      code_challenge_method,
      resource
    } = params;

    // Validate required OAuth parameters
    if (!response_type || response_type !== 'code') {
      return {
        valid: false,
        error: 'unsupported_response_type',
        error_description: 'Only "code" response type is supported'
      };
    }

    if (!client_id || !redirect_uri) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'Missing required parameters: client_id or redirect_uri'
      };
    }

    // MCP compliance: Validate resource parameter
    if (resource && resource !== this.serverUrl) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'Invalid resource parameter'
      };
    }

    // PKCE validation for public clients (required for MCP)
    if (!code_challenge || !code_challenge_method) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'PKCE is required (code_challenge and code_challenge_method)'
      };
    }

    if (code_challenge_method !== 'S256') {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'Only S256 code_challenge_method is supported'
      };
    }

    return { valid: true };
  }

  /**
   * Validate OAuth token request parameters
   */
  validateTokenRequest(params) {
    const { 
      grant_type, 
      code, 
      redirect_uri, 
      client_id, 
      code_verifier, 
      resource
    } = params;

    if (grant_type !== 'authorization_code') {
      return {
        valid: false,
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant type is supported'
      };
    }

    // Validate required parameters
    if (!code || !redirect_uri || !client_id) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'Missing required parameters: code, redirect_uri, or client_id'
      };
    }

    // PKCE validation (required for MCP)
    if (!code_verifier) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'code_verifier is required for PKCE'
      };
    }

    // MCP compliance: Validate resource parameter
    if (resource && resource !== this.serverUrl) {
      return {
        valid: false,
        error: 'invalid_request',
        error_description: 'Invalid resource parameter'
      };
    }

    return { valid: true };
  }

  /**
   * Validate PKCE code_verifier against stored code_challenge
   */
  async validatePKCE(codeVerifier, storedChallenge) {
    try {
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update(codeVerifier).digest();
      const computedChallenge = hash.toString('base64url');
      
      const isValid = computedChallenge === storedChallenge;
      
      if (!isValid) {
        serverLogger.warn('PKCE validation failed', {
          expectedChallenge: storedChallenge.substring(0, 10) + '...',
          computedChallenge: computedChallenge.substring(0, 10) + '...'
        });
      }
      
      return isValid;
    } catch (error) {
      serverLogger.error('PKCE validation error', null, error);
      return false;
    }
  }

  /**
   * Validate client registration request
   */
  validateRegistrationRequest(params) {
    const { client_name, redirect_uris } = params;

    if (!client_name || !redirect_uris) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        error_description: 'Missing required parameters: client_name or redirect_uris'
      };
    }

    return { valid: true };
  }
}