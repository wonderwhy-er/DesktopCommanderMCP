import { Response } from 'express';
import { DeviceModel } from '../database/models';
import { verifyDeviceToken } from '../auth/middleware';
import { MCPRequest, MCPResponse } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface SSEConnection {
  res: Response;
  deviceId: string;
  userId: string;
  lastHeartbeat: Date;
  isActive: boolean;
}

interface PendingRequest {
  resolve: (value: MCPResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  timestamp: Date;
}

export class SSEManager {
  private connections = new Map<string, SSEConnection>();
  private pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    // Cleanup stale connections every 30 seconds
    setInterval(() => {
      this.cleanupStaleConnections();
    }, 30 * 1000);

    // Clean up expired pending requests every minute
    setInterval(() => {
      this.cleanupExpiredRequests();
    }, 60 * 1000);
  }

  async handleSSEConnection(res: Response, deviceToken: string): Promise<void> {
    try {
      // Verify device token
      const tokenData = verifyDeviceToken(deviceToken);
      if (!tokenData) {
        res.status(401).json({ error: 'Invalid device token' });
        return;
      }

      const { deviceId, userId } = tokenData;

      // Update device status in database
      await DeviceModel.updateStatus(deviceId, 'online');

      // Setup SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control',
      });

      // Store connection
      const connection: SSEConnection = {
        res,
        deviceId,
        userId,
        lastHeartbeat: new Date(),
        isActive: true
      };

      this.connections.set(deviceId, connection);

      console.log(`SSE connection established for device: ${deviceId}`);

      // Send initial connection event
      this.sendEvent(res, 'connected', {
        deviceId,
        message: 'SSE connection established',
        timestamp: new Date().toISOString()
      });

      // Handle client disconnect
      res.on('close', async () => {
        console.log(`SSE connection closed for device: ${deviceId}`);
        await this.handleDisconnection(deviceId);
      });

      res.on('error', async (error) => {
        console.error(`SSE connection error for device ${deviceId}:`, error);
        await this.handleDisconnection(deviceId);
      });

      // Start heartbeat
      this.startHeartbeat(deviceId);

    } catch (error) {
      console.error('SSE connection error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async sendMCPRequest(userId: string, request: MCPRequest): Promise<MCPResponse> {
    // Find device for user
    const device = await DeviceModel.findByUserId(userId);
    if (!device) {
      throw new Error('No device registered for user');
    }

    const connection = this.connections.get(device.id);
    if (!connection || !connection.isActive) {
      throw new Error('Device not connected via SSE');
    }

    return new Promise((resolve, reject) => {
      const requestId = uuidv4();
      
      // Set up timeout (30 seconds)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('MCP request timeout'));
      }, 30000);

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        timestamp: new Date()
      });

      // Send MCP request event
      this.sendEvent(connection.res, 'mcp_request', {
        id: requestId,
        request,
        timestamp: new Date().toISOString()
      });
    });
  }

  handleMCPResponse(deviceId: string, requestId: string, response: MCPResponse): void {
    const pendingRequest = this.pendingRequests.get(requestId);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timeout);
      this.pendingRequests.delete(requestId);
      pendingRequest.resolve(response);
    }
  }

  handleMCPError(deviceId: string, requestId: string, error: string): void {
    const pendingRequest = this.pendingRequests.get(requestId);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timeout);
      this.pendingRequests.delete(requestId);
      pendingRequest.reject(new Error(error));
    }
  }

  private sendEvent(res: Response, event: string, data: any): void {
    try {
      const eventString = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(eventString);
      console.log(`📡 SSE event sent: ${event} to device`);
    } catch (error) {
      console.error('Failed to send SSE event:', error);
    }
  }

  private startHeartbeat(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;

    const heartbeatInterval = setInterval(() => {
      const conn = this.connections.get(deviceId);
      if (!conn || !conn.isActive) {
        clearInterval(heartbeatInterval);
        return;
      }

      // Send heartbeat
      this.sendEvent(conn.res, 'heartbeat', {
        timestamp: new Date().toISOString()
      });

      // Update last heartbeat time
      conn.lastHeartbeat = new Date();
    }, 30000); // Every 30 seconds
  }

  private async handleDisconnection(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId);
    if (connection) {
      connection.isActive = false;
      this.connections.delete(deviceId);

      // Update device status in database
      try {
        await DeviceModel.updateStatus(deviceId, 'offline');
        console.log(`Device ${deviceId} marked as offline`);
      } catch (error) {
        console.error(`Failed to update device ${deviceId} status:`, error);
      }
    }

    // Reject any pending requests for this device
    for (const [requestId, pendingRequest] of this.pendingRequests.entries()) {
      // Note: We can't easily map requests to devices without additional tracking
      // For now, we'll let them timeout naturally
    }
  }

  private cleanupStaleConnections(): void {
    const now = new Date();
    const staleThreshold = 2 * 60 * 1000; // 2 minutes

    for (const [deviceId, connection] of this.connections.entries()) {
      const timeSinceHeartbeat = now.getTime() - connection.lastHeartbeat.getTime();
      
      if (timeSinceHeartbeat > staleThreshold) {
        console.log(`Cleaning up stale SSE connection for device: ${deviceId}`);
        this.handleDisconnection(deviceId);
      }
    }
  }

  private cleanupExpiredRequests(): void {
    const now = new Date();
    const expiredThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [requestId, request] of this.pendingRequests.entries()) {
      const age = now.getTime() - request.timestamp.getTime();
      
      if (age > expiredThreshold) {
        console.log(`Cleaning up expired request: ${requestId}`);
        clearTimeout(request.timeout);
        request.reject(new Error('Request expired'));
        this.pendingRequests.delete(requestId);
      }
    }
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  isDeviceConnected(deviceId: string): boolean {
    const connection = this.connections.get(deviceId);
    return connection?.isActive || false;
  }

  getConnectedDevices(): string[] {
    return Array.from(this.connections.keys());
  }
}