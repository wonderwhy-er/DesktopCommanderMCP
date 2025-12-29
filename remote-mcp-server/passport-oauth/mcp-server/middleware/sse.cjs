/**
 * Server-Sent Events (SSE) Middleware for MCP OAuth Server
 */

/**
 * SSE connection manager
 */
class SSEConnectionManager {
  constructor() {
    this.connections = new Map(); // clientId -> Set of connections
    this.connectionMetadata = new Map(); // connectionId -> metadata
    
    // Heartbeat every 30 seconds
    setInterval(() => this.sendHeartbeat(), 30000);
    
    // Cleanup stale connections every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Add a new SSE connection
   */
  addConnection(clientId, userId, connectionId, res) {
    // Initialize client connections set if not exists
    if (!this.connections.has(clientId)) {
      this.connections.set(clientId, new Set());
    }
    
    const clientConnections = this.connections.get(clientId);
    clientConnections.add(connectionId);
    
    // Store connection metadata
    this.connectionMetadata.set(connectionId, {
      clientId,
      userId,
      response: res,
      connectedAt: Date.now(),
      lastActivity: Date.now()
    });

    console.log(`[SSE] New connection: ${connectionId} for client ${clientId}, user ${userId}`);
    console.log(`[SSE] Total connections: ${this.connectionMetadata.size}`);
    
    // Send welcome message
    this.sendToConnection(connectionId, 'connected', {
      connectionId,
      clientId,
      userId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Remove SSE connection
   */
  removeConnection(connectionId) {
    const metadata = this.connectionMetadata.get(connectionId);
    if (!metadata) return;
    
    const { clientId } = metadata;
    
    // Remove from client connections
    const clientConnections = this.connections.get(clientId);
    if (clientConnections) {
      clientConnections.delete(connectionId);
      
      // Clean up empty client entry
      if (clientConnections.size === 0) {
        this.connections.delete(clientId);
      }
    }
    
    // Remove metadata
    this.connectionMetadata.delete(connectionId);
    
    console.log(`[SSE] Removed connection: ${connectionId}`);
  }

  /**
   * Send message to specific connection
   */
  sendToConnection(connectionId, eventType, data) {
    const metadata = this.connectionMetadata.get(connectionId);
    if (!metadata) {
      console.warn(`[SSE] Connection not found: ${connectionId}`);
      return false;
    }

    try {
      const { response } = metadata;
      const eventData = typeof data === 'string' ? data : JSON.stringify(data);
      
      response.write(`event: ${eventType}\n`);
      response.write(`data: ${eventData}\n\n`);
      
      // Update last activity
      metadata.lastActivity = Date.now();
      
      return true;
    } catch (error) {
      console.error(`[SSE] Failed to send to connection ${connectionId}:`, error);
      this.removeConnection(connectionId);
      return false;
    }
  }

  /**
   * Send message to all connections for a client
   */
  sendToClient(clientId, eventType, data) {
    const clientConnections = this.connections.get(clientId);
    if (!clientConnections || clientConnections.size === 0) {
      console.warn(`[SSE] No connections for client: ${clientId}`);
      return 0;
    }

    let sentCount = 0;
    for (const connectionId of clientConnections) {
      if (this.sendToConnection(connectionId, eventType, data)) {
        sentCount++;
      }
    }
    
    console.log(`[SSE] Sent ${eventType} to ${sentCount}/${clientConnections.size} connections for client ${clientId}`);
    return sentCount;
  }

  /**
   * Broadcast message to all connections
   */
  broadcast(eventType, data) {
    let sentCount = 0;
    for (const connectionId of this.connectionMetadata.keys()) {
      if (this.sendToConnection(connectionId, eventType, data)) {
        sentCount++;
      }
    }
    
    console.log(`[SSE] Broadcast ${eventType} to ${sentCount} connections`);
    return sentCount;
  }

  /**
   * Send heartbeat to all connections
   */
  sendHeartbeat() {
    const heartbeatData = {
      timestamp: new Date().toISOString(),
      server_time: Date.now()
    };
    
    this.broadcast('heartbeat', heartbeatData);
  }

  /**
   * Handle MCP request routing
   */
  sendMCPRequest(clientId, requestId, request) {
    const mcpRequestData = {
      id: requestId,
      request: request,
      timestamp: new Date().toISOString()
    };
    
    const sentCount = this.sendToClient(clientId, 'mcp_request', mcpRequestData);
    return sentCount > 0;
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const stats = {
      total_connections: this.connectionMetadata.size,
      unique_clients: this.connections.size,
      connections_by_client: {}
    };

    for (const [clientId, connections] of this.connections.entries()) {
      stats.connections_by_client[clientId] = connections.size;
    }

    return stats;
  }

  /**
   * Get active connections for a client
   */
  getClientConnections(clientId) {
    const clientConnections = this.connections.get(clientId);
    if (!clientConnections) return [];
    
    return Array.from(clientConnections).map(connectionId => {
      const metadata = this.connectionMetadata.get(connectionId);
      return {
        connectionId,
        connectedAt: metadata?.connectedAt,
        lastActivity: metadata?.lastActivity
      };
    });
  }

  /**
   * Cleanup stale connections
   */
  cleanup() {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    
    let cleanedCount = 0;
    
    for (const [connectionId, metadata] of this.connectionMetadata.entries()) {
      if (now - metadata.lastActivity > staleThreshold) {
        console.log(`[SSE] Cleaning up stale connection: ${connectionId}`);
        this.removeConnection(connectionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`[SSE] Cleaned up ${cleanedCount} stale connections`);
    }
  }
}

/**
 * Create SSE middleware
 */
function createSSEMiddleware(connectionManager) {
  return (req, res, next) => {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Generate unique connection ID
    const connectionId = `sse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Get OAuth data from previous middleware
    const { client_id, user_id } = req.oauth || {};
    
    if (!client_id) {
      res.write('event: error\n');
      res.write('data: {"error": "unauthorized", "message": "OAuth authentication required"}\n\n');
      res.end();
      return;
    }

    // Add connection to manager
    connectionManager.addConnection(client_id, user_id, connectionId, res);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`[SSE] Client disconnected: ${connectionId}`);
      connectionManager.removeConnection(connectionId);
    });

    req.on('error', (error) => {
      console.error(`[SSE] Connection error for ${connectionId}:`, error);
      connectionManager.removeConnection(connectionId);
    });

    // Store connection info for potential use in other handlers
    req.sseConnection = {
      id: connectionId,
      manager: connectionManager
    };

    next();
  };
}

/**
 * Create SSE route handler that keeps connection alive
 */
function createSSEHandler() {
  return (req, res) => {
    // Connection is managed by middleware, just keep it alive
    console.log(`[SSE] SSE connection established: ${req.sseConnection?.id}`);
    
    // The connection will stay open until client disconnects
    // All communication happens via the connection manager
  };
}

module.exports = {
  SSEConnectionManager,
  createSSEMiddleware,
  createSSEHandler
};