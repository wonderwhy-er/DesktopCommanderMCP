import { Router, Request, Response } from 'express';
import { SSEManager } from './manager';

export function createSSERouter(sseManager: SSEManager): Router {
  const router = Router();

  // SSE connection endpoint
  router.get('/sse', async (req: Request, res: Response) => {
    try {
      const deviceToken = req.query.deviceToken as string;
      
      if (!deviceToken) {
        res.status(400).json({ error: 'Device token required as query parameter' });
        return;
      }

      await sseManager.handleSSEConnection(res, deviceToken);
    } catch (error) {
      console.error('SSE endpoint error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Endpoint for local agents to send MCP responses
  router.post('/sse/response', async (req: Request, res: Response) => {
    try {
      const { deviceToken, requestId, response } = req.body;

      if (!deviceToken || !requestId || !response) {
        res.status(400).json({ error: 'Missing required fields: deviceToken, requestId, response' });
        return;
      }

      // Verify device token (basic verification)
      const tokenData = require('../auth/middleware').verifyDeviceToken(deviceToken);
      if (!tokenData) {
        res.status(401).json({ error: 'Invalid device token' });
        return;
      }

      const { deviceId } = tokenData;

      // Handle the MCP response
      sseManager.handleMCPResponse(deviceId, requestId, response);

      res.json({ success: true, message: 'Response processed' });
    } catch (error) {
      console.error('SSE response endpoint error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Endpoint for local agents to send errors
  router.post('/sse/error', async (req: Request, res: Response) => {
    try {
      const { deviceToken, requestId, error } = req.body;

      if (!deviceToken || !requestId || !error) {
        res.status(400).json({ error: 'Missing required fields: deviceToken, requestId, error' });
        return;
      }

      // Verify device token
      const tokenData = require('../auth/middleware').verifyDeviceToken(deviceToken);
      if (!tokenData) {
        res.status(401).json({ error: 'Invalid device token' });
        return;
      }

      const { deviceId } = tokenData;

      // Handle the MCP error
      sseManager.handleMCPError(deviceId, requestId, error);

      res.json({ success: true, message: 'Error processed' });
    } catch (error) {
      console.error('SSE error endpoint error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // SSE status endpoint
  router.get('/sse/status', (req: Request, res: Response) => {
    try {
      const connectionCount = sseManager.getConnectionCount();
      const connectedDevices = sseManager.getConnectedDevices();

      res.json({
        connectionCount,
        connectedDevices,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('SSE status endpoint error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}