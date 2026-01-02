import express from 'express';
import { serverLogger } from '../../utils/logger.js';

/**
 * General Routes
 * Handles health checks, server info, and other utility endpoints
 */
export function createGeneralRouter(serverUrl) {
    const router = express.Router();

    // Server info (public)
    router.get('/', (req, res) => {
        res.json({
            service: 'Desktop Commander Remote Server',
            version: '1.0.0',
            protocol_version: '2024-11-05',
            transport: 'http',
            authentication: 'oauth2',
            endpoints: {
                mcp: '/mcp',
                authorize: '/authorize',
                token: '/token',
                register: '/register'
            },
            features: [
                'HTTP transport',
                'OAuth 2.0 with PKCE',
                'Supabase authentication',
                'User-scoped tool execution',
                'Session management',
                'Tool call logging'
            ],
            timestamp: new Date().toISOString()
        });
    });

    // MCP info API endpoint for web interface
    router.get('/api/mcp-info', (req, res) => {
        serverLogger.info('ℹ️ MCP Info Request', {
            ip: req.ip,
            userAgent: req.get('User-Agent')
        });

        const mcpInfo = {
            mcpServerUrl: serverUrl,
            supabaseUrl: process.env.SUPABASE_URL,
            supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
            redirectUrl: `${serverUrl}/auth/callback`,
            authorizationEndpoint: `${serverUrl}/authorize`,
            tokenEndpoint: `${serverUrl}/token`,
            discoveryEndpoint: `${serverUrl}/.well-known/oauth-authorization-server`
        };

        serverLogger.info('✅ MCP info response generated', {
            mcpServerUrl: mcpInfo.mcpServerUrl,
            redirectUrl: mcpInfo.redirectUrl,
            hasSupabaseConfig: !!(mcpInfo.supabaseUrl && mcpInfo.supabaseAnonKey)
        });

        res.json(mcpInfo);
    });

    return router;
}
