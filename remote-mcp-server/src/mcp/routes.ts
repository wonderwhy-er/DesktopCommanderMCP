import { Router, Response } from 'express';
import { authenticateDeviceToken, authenticateToken, AuthenticatedRequest } from '../auth/middleware';
import { WebSocketManager } from '../websocket/manager';
import { SSEManager } from '../sse/manager';
import { MCPRequest } from '../types';

export function createMCPRouter(wsManager: WebSocketManager, sseManager: SSEManager): Router {
  const router = Router();

  // Execute MCP request
  router.post('/execute', authenticateDeviceToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const mcpRequest: MCPRequest = req.body;

      // Validate MCP request format
      if (!mcpRequest.jsonrpc || mcpRequest.jsonrpc !== '2.0') {
        return res.status(400).json({ 
          error: 'Invalid MCP request format - jsonrpc must be "2.0"' 
        });
      }

      if (!mcpRequest.method) {
        return res.status(400).json({ 
          error: 'Invalid MCP request format - method is required' 
        });
      }

      if (mcpRequest.id === undefined) {
        return res.status(400).json({ 
          error: 'Invalid MCP request format - id is required' 
        });
      }

      console.log(`Executing MCP request for user ${userId}:`, {
        method: mcpRequest.method,
        id: mcpRequest.id
      });

      // Try SSE first, fallback to WebSocket
      let response;
      try {
        response = await sseManager.sendMCPRequest(userId, mcpRequest);
      } catch (sseError) {
        console.log('SSE request failed, trying WebSocket:', sseError instanceof Error ? sseError.message : String(sseError));
        response = await wsManager.sendMCPRequest(userId, mcpRequest);
      }
      
      console.log(`MCP request completed:`, {
        method: mcpRequest.method,
        id: mcpRequest.id,
        success: !response.error
      });

      res.json(response);

    } catch (error) {
      console.error('MCP execution error:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('No device registered')) {
          return res.status(400).json({ 
            jsonrpc: '2.0',
            id: req.body.id || null,
            error: {
              code: -32000,
              message: 'No device registered for this user'
            }
          });
        }
        
        if (error.message.includes('Device not connected')) {
          return res.status(400).json({ 
            jsonrpc: '2.0',
            id: req.body.id || null,
            error: {
              code: -32001,
              message: 'Device is offline or not connected'
            }
          });
        }
        
        if (error.message.includes('timeout')) {
          return res.status(408).json({ 
            jsonrpc: '2.0',
            id: req.body.id || null,
            error: {
              code: -32002,
              message: 'Request timeout - device did not respond'
            }
          });
        }
      }

      res.status(500).json({ 
        jsonrpc: '2.0',
        id: req.body.id || null,
        error: {
          code: -32603,
          message: 'Internal server error'
        }
      });
    }
  });

  // Get MCP server status
  router.get('/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      
      // This could be enhanced to get actual device capabilities
      res.json({
        status: 'ok',
        connectionCount: wsManager.getConnectionCount(),
        sseConnectionCount: sseManager.getConnectionCount(),
        supportedMethods: [
          'read_file',
          'write_file', 
          'list_directory',
          'create_directory',
          'move_file',
          'get_file_info',
          'start_process',
          'interact_with_process',
          'read_process_output',
          'force_terminate',
          'list_sessions',
          'start_search',
          'get_more_search_results',
          'stop_search',
          'edit_block'
        ]
      });
    } catch (error) {
      console.error('MCP status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}