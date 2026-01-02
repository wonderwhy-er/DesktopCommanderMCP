import express from 'express';
import { OAuthProcessor } from '../oauth/oauth-processor.js';
import { serverLogger } from '../../utils/logger.js';

/**
 * OAuth Routes
 * Handles all OAuth 2.0 related endpoints
 */
export function createOAuthRouter(serverUrl, supabase) {
    const router = express.Router();
    const oauthProcessor = new OAuthProcessor(serverUrl, supabase);

    // Helper functions for validation
    const validateAuthorizationRequest = (params) => {
        const {
            response_type,
            client_id,
            redirect_uri,
            code_challenge,
            code_challenge_method,
            resource
        } = params;

        if (!response_type || response_type !== 'code') {
            return { valid: false, error: 'unsupported_response_type', error_description: 'Only "code" response type is supported' };
        }

        if (!client_id || !redirect_uri) {
            return { valid: false, error: 'invalid_request', error_description: 'Missing required parameters: client_id or redirect_uri' };
        }

        if (resource && resource !== serverUrl) {
            return { valid: false, error: 'invalid_request', error_description: 'Invalid resource parameter' };
        }

        if (!code_challenge || !code_challenge_method) {
            return { valid: false, error: 'invalid_request', error_description: 'PKCE is required (code_challenge and code_challenge_method)' };
        }

        if (code_challenge_method !== 'S256') {
            return { valid: false, error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' };
        }

        return { valid: true };
    };

    const validateTokenRequest = (params) => {
        const {
            grant_type,
            code,
            redirect_uri,
            client_id,
            code_verifier,
            resource
        } = params;

        if (grant_type !== 'authorization_code') {
            return { valid: false, error: 'unsupported_grant_type', error_description: 'Only authorization_code grant type is supported' };
        }

        if (!code || !redirect_uri || !client_id) {
            return { valid: false, error: 'invalid_request', error_description: 'Missing required parameters: code, redirect_uri, or client_id' };
        }

        if (!code_verifier) {
            return { valid: false, error: 'invalid_request', error_description: 'code_verifier is required for PKCE' };
        }

        if (resource && resource !== serverUrl) {
            return { valid: false, error: 'invalid_request', error_description: 'Invalid resource parameter' };
        }

        return { valid: true };
    };

    const validateRegistrationRequest = (params) => {
        const { client_name, redirect_uris } = params;

        if (!client_name || !redirect_uris) {
            return { valid: false, error: 'invalid_client_metadata', error_description: 'Missing required parameters: client_name or redirect_uris' };
        }

        return { valid: true };
    };

    // Helper functions for responses
    const sendErrorResponse = (res, error, errorDescription, statusCode = 400) => {
        serverLogger.warn(`❌ OAuth error: ${error}`, { error, description: errorDescription });
        return res.status(statusCode).json({ error, error_description: errorDescription });
    };

    const sendRedirectResponse = (res, redirectUrl) => {
        serverLogger.debug('🔄 OAuth redirect', { to: redirectUrl });
        return res.redirect(redirectUrl);
    };

    const sendTokenResponse = (res, tokenData) => {
        serverLogger.debug('✅ Token response sent', { type: tokenData.token_type });
        return res.json(tokenData);
    };

    const sendRegistrationResponse = (res, clientInfo) => {
        serverLogger.info('📝 Client registered', { id: clientInfo.client_id, name: clientInfo.client_name });
        return res.json(clientInfo);
    };

    const handleCallbackRedirect = (res, result) => {
        const { redirect_uri, state, error, error_description, access_token, refresh_token, client_id, client_name } = result;

        if (!redirect_uri) {
            if (error) return sendErrorResponse(res, error, error_description);
            return res.json({ access_token, refresh_token, token_type: 'Bearer', expires_in: 86400 });
        }

        try {
            const url = new URL(redirect_uri);

            if (error) {
                url.searchParams.set('error', error);
                if (error_description) url.searchParams.set('error_description', error_description);
            } else {
                url.searchParams.set('access_token', access_token);
                if (refresh_token) url.searchParams.set('refresh_token', refresh_token);
                url.searchParams.set('code', access_token); // Legacy support

                // Add client information for client-agnostic UI
                if (client_id) url.searchParams.set('client_id', client_id);
                if (client_name) url.searchParams.set('client_name', client_name);
            }

            if (state) url.searchParams.set('state', state);

            return sendRedirectResponse(res, url.toString());

        } catch (e) {
            serverLogger.error('Invalid redirect URI', { redirect_uri }, e);
            return sendErrorResponse(res, 'invalid_request', 'Invalid redirect_uri format');
        }
    };

    // OAuth 2.0 Discovery endpoints
    router.get('/.well-known/oauth-authorization-server', (req, res) => {
        serverLogger.info('🔍 OAuth Discovery Request', {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            serverUrl: oauthProcessor.serverUrl
        });

        const discovery = {
            issuer: serverUrl,
            authorization_endpoint: `${serverUrl}/authorize`,
            token_endpoint: `${serverUrl}/token`,
            registration_endpoint: `${serverUrl}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['mcp:tools'],
            token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
            resource_indicators_supported: true,
            require_request_uri_registration: false,
            request_object_signing_alg_values_supported: ['none'],
            claims_supported: ['sub', 'aud', 'exp', 'iat'],
            subject_types_supported: ['public']
        };

        res.json(discovery);
    });

    router.get('/.well-known/oauth-protected-resource', (req, res) => {
        serverLogger.info('🛡️ Protected Resource Discovery Request', {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            serverUrl: oauthProcessor.serverUrl
        });

        const resourceInfo = {
            resource_server: serverUrl,
            authorization_servers: [serverUrl],
            scopes_supported: ['mcp:tools'],
            bearer_methods_supported: ['header'],
            resource_documentation: `${serverUrl}/docs`
        };

        res.json(resourceInfo);
    });

    // OAuth 2.0 Authorization endpoint
    router.get('/authorize', (req, res) => {
        serverLogger.info('🔐 OAuth Authorization Request', {
            clientId: req.query.client_id,
            redirectUri: req.query.redirect_uri,
            scope: req.query.scope,
            resource: req.query.resource,
            hasCodeChallenge: !!req.query.code_challenge,
            ip: req.ip
        });

        const validation = validateAuthorizationRequest(req.query);
        if (!validation.valid) {
            return sendErrorResponse(res, validation.error, validation.error_description);
        }

        try {
            const { authUrl } = oauthProcessor.processAuthorizationRequest(req.query);
            sendRedirectResponse(res, authUrl);
        } catch (error) {
            serverLogger.error('Authorization request processing failed', null, error);
            sendErrorResponse(res, 'server_error', 'Failed to process authorization request', 500);
        }
    });

    // OAuth 2.0 Token endpoint
    router.post('/token', express.json(), async (req, res) => {
        try {
            serverLogger.info('🎟️ Token Exchange Request', {
                grantType: req.body.grant_type,
                clientId: req.body.client_id,
                redirectUri: req.body.redirect_uri,
                hasCode: !!req.body.code,
                ip: req.ip
            });

            const validation = validateTokenRequest(req.body);
            if (!validation.valid) {
                return sendErrorResponse(res, validation.error, validation.error_description);
            }

            try {
                const { tokenResponse } = await oauthProcessor.processTokenExchange(req.body);
                sendTokenResponse(res, tokenResponse);
            } catch (processingError) {
                serverLogger.error('❌ Token exchange processing failed', { clientId: req.body.client_id }, processingError);

                if (processingError.message.includes('PKCE validation failed') ||
                    processingError.message.includes('Invalid authorization code')) {
                    return sendErrorResponse(res, 'invalid_grant', processingError.message);
                }

                return sendErrorResponse(res, 'server_error', 'Failed to process token exchange', 500);
            }
        } catch (error) {
            serverLogger.error('❌ Token endpoint error', null, error);
            sendErrorResponse(res, 'server_error', 'Internal server error', 500);
        }
    });

    // OAuth 2.0 Client Registration endpoint
    router.post('/register', express.json(), (req, res) => {
        serverLogger.info('📝 Client Registration Request', {
            clientName: req.body.client_name,
            redirectUris: req.body.redirect_uris,
            ip: req.ip
        });

        const validation = validateRegistrationRequest(req.body);
        if (!validation.valid) {
            return sendErrorResponse(res, validation.error, validation.error_description);
        }

        try {
            const clientInfo = oauthProcessor.processClientRegistration(req.body);
            sendRegistrationResponse(res, clientInfo);
        } catch (error) {
            serverLogger.error('Client registration processing failed', null, error);
            sendErrorResponse(res, 'server_error', 'Failed to process client registration', 500);
        }
    });

    // OAuth callback handler
    router.get('/auth/callback', async (req, res) => {
        serverLogger.info('🔄 OAuth Callback Received', {
            hasAccessToken: !!req.query.access_token,
            error: req.query.error,
            authId: req.query.auth_id
        });

        try {
            const result = await oauthProcessor.processCallback(req.query);

            handleCallbackRedirect(res, {
                ...result,
                redirect_uri: req.query.redirect_uri,
                state: req.query.state,
                client_id: req.query.client_id,
                client_name: req.query.client_name
            });
        } catch (callbackError) {
            serverLogger.error('OAuth callback processing failed', null, callbackError);

            handleCallbackRedirect(res, {
                error: 'invalid_token',
                error_description: callbackError.message,
                redirect_uri: req.query.redirect_uri,
                state: req.query.state
            });
        }
    });

    return router;
}
