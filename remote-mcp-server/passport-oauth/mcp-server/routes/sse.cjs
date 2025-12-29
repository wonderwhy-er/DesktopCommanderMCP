/**
 * Server-Sent Events Routes for MCP OAuth Server
 */

const express = require('express');
const router = express.Router();
const { createSSEMiddleware, createSSEHandler } = require('../middleware/sse.cjs');
const { requireScope } = require('../middleware/oauth.cjs');

/**
 * SSE endpoint for MCP communication
 * GET /sse
 */
function setupSSERoutes(connectionManager) {
  // Main SSE endpoint
  router.get('/sse', 
    requireScope(['mcp:tools']),
    createSSEMiddleware(connectionManager),
    createSSEHandler()
  );

  // SSE status endpoint
  router.get('/sse/status', (req, res) => {
    const stats = connectionManager.getStats();
    
    res.json({
      service: 'sse',
      status: 'active',
      ...stats,
      timestamp: new Date().toISOString()
    });
  });

  // Send message to specific client (for testing)
  router.post('/sse/send/:clientId', 
    requireScope(['mcp:admin']),
    (req, res) => {
      const { clientId } = req.params;
      const { eventType, data } = req.body;
      
      if (!eventType) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'eventType is required'
        });
      }
      
      const sentCount = connectionManager.sendToClient(clientId, eventType, data || {});
      
      res.json({
        success: true,
        clientId,
        eventType,
        sentCount,
        timestamp: new Date().toISOString()
      });
    }
  );

  // Broadcast message to all clients (admin only)
  router.post('/sse/broadcast',
    requireScope(['mcp:admin']),
    (req, res) => {
      const { eventType, data } = req.body;
      
      if (!eventType) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'eventType is required'
        });
      }
      
      const sentCount = connectionManager.broadcast(eventType, data || {});
      
      res.json({
        success: true,
        eventType,
        sentCount,
        timestamp: new Date().toISOString()
      });
    }
  );

  // Get client connections info
  router.get('/sse/clients/:clientId/connections',
    requireScope(['mcp:admin']),
    (req, res) => {
      const { clientId } = req.params;
      const connections = connectionManager.getClientConnections(clientId);
      
      res.json({
        clientId,
        connections,
        count: connections.length,
        timestamp: new Date().toISOString()
      });
    }
  );

  // MCP request routing endpoint
  router.post('/sse/mcp/:clientId',
    requireScope(['mcp:tools']),
    (req, res) => {
      const { clientId } = req.params;
      const { requestId, request } = req.body;
      
      if (!requestId || !request) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'requestId and request are required'
        });
      }
      
      const sent = connectionManager.sendMCPRequest(clientId, requestId, request);
      
      if (!sent) {
        return res.status(404).json({
          error: 'client_not_connected',
          message: `No active connections for client ${clientId}`
        });
      }
      
      res.json({
        success: true,
        clientId,
        requestId,
        sent: true,
        timestamp: new Date().toISOString()
      });
    }
  );

  return router;
}

module.exports = { setupSSERoutes };