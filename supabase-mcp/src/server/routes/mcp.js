import express from 'express';
import { RemoteMcp } from '../remote-mcp/remote-mcp.js';
import { serverLogger, mcpLogger } from '../../utils/logger.js';
import { authMiddleware } from '../auth-middleware.js';

/**
 * MCP Routes
 * Handles MCP protocol endpoints
 */
export function createMCPRouter(supabase) {
    const router = express.Router();
    const remoteMcp = new RemoteMcp(supabase);



    // MCP endpoint (authenticated) - using SDK (supports both GET and POST)
    router.all('/mcp',
        authMiddleware.validate,
        (req, res) => remoteMcp.handleMCPMessageWithSDK(req, res)
    );

    // DEBUG: Test endpoint to trigger remote_echo (development only)
    router.get('/debug/test-remote', express.json(), async (req, res) => {
        if (process.env.NODE_ENV === 'production') {
            return res.status(404).json({ error: 'Not found' });
        }

        try {
            // Create a mock authenticated user for testing
            const mockUser = {
                id: 'a6766832-9b4e-4efd-bfec-a53734bff5a3', // Use the user ID from the agent logs
                email: 'debug@test.com'
            };

            const toolName = req.query.tool_name || 'list_directory';
            const toolArgs = req.query.tool_args || { path: ".", depth: 1 };

            serverLogger.info(`🧪 DEBUG: Test ${toolName} tool triggered`, {
                toolArgs,
                ip: req.ip
            });


            // Directly call the tool dispatcher
            const result = await remoteMcp.toolDispatcher.dispatchTool(mockUser.id, toolName, toolArgs);

            res.json({
                success: true,
                result,
                message: 'Tool dispatched successfully'
            });

        } catch (error) {
            serverLogger.error('🧪 DEBUG: Test endpoint failed', null, error);
            res.status(500).json({
                success: false,
                error: error.message,
                message: 'Tool dispatch failed'
            });
        }
    });

    return router;
}
