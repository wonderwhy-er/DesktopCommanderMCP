import WebSocket from 'ws';
import { DeviceModel } from '../database/models';
import { verifyDeviceToken } from '../auth/middleware';
import { DeviceMessage, MCPRequest, MCPResponse } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
  userId: string;
  lastHeartbeat: Date;
}

export class WebSocketManager {
  private connections = new Map<string, DeviceConnection>();
  private pendingRequests = new Map<string, {
    resolve: (value: MCPResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor() {
    // Cleanup disconnected devices every 5 minutes
    setInterval(() => {
      this.cleanupStaleConnections();
    }, 5 * 60 * 1000);

    // Clean up expired pending requests every minute
    setInterval(() => {
      this.cleanupExpiredRequests();
    }, 60 * 1000);
  }

  async handleConnection(ws: WebSocket, url: string): Promise<void> {
    console.log('New WebSocket connection attempt');

    // Wait for authentication message
    ws.on('message', async (data) => {
      try {
        const message: DeviceMessage = JSON.parse(data.toString());
        
        if (message.type === 'auth') {
          await this.authenticateDevice(ws, message);
        } else {
          await this.handleDeviceMessage(ws, message);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        this.sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      this.handleDisconnection(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.handleDisconnection(ws);
    });

    // Send initial auth request
    this.sendMessage(ws, {
      id: uuidv4(),
      type: 'auth',
      payload: { message: 'Please provide device token' },
      timestamp: Date.now()
    });
  }

  private async authenticateDevice(ws: WebSocket, message: DeviceMessage): Promise<void> {
    try {
      const { deviceToken } = message.payload;
      
      if (!deviceToken) {
        this.sendError(ws, 'Device token required');
        ws.close();
        return;
      }

      const { deviceId, userId } = verifyDeviceToken(deviceToken);
      
      // Verify device exists in database
      const device = await DeviceModel.findById(deviceId);
      if (!device || device.user_id !== userId) {
        this.sendError(ws, 'Invalid device token');
        ws.close();
        return;
      }

      // Remove any existing connection for this device
      this.removeDeviceConnection(deviceId);

      // Store new connection
      this.connections.set(deviceId, {
        ws,
        deviceId,
        userId,
        lastHeartbeat: new Date()
      });

      // Update device status in database
      await DeviceModel.updateStatus(deviceId, 'online', new Date());

      // Send auth success
      this.sendMessage(ws, {
        id: uuidv4(),
        type: 'auth',
        payload: { 
          success: true, 
          deviceId,
          message: 'Authentication successful' 
        },
        timestamp: Date.now()
      });

      console.log(`Device ${deviceId} authenticated and connected`);

    } catch (error) {
      console.error('Device authentication error:', error);
      this.sendError(ws, 'Authentication failed');
      ws.close();
    }
  }

  private async handleDeviceMessage(ws: WebSocket, message: DeviceMessage): Promise<void> {
    const connection = this.findConnectionByWs(ws);
    if (!connection) {
      this.sendError(ws, 'Device not authenticated');
      return;
    }

    switch (message.type) {
      case 'heartbeat':
        connection.lastHeartbeat = new Date();
        this.sendMessage(ws, {
          id: message.id,
          type: 'heartbeat',
          payload: { timestamp: Date.now() },
          timestamp: Date.now()
        });
        break;

      case 'mcp_response':
        this.handleMCPResponse(message);
        break;

      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  private handleMCPResponse(message: DeviceMessage): void {
    const pending = this.pendingRequests.get(message.id);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(message.payload as MCPResponse);
      this.pendingRequests.delete(message.id);
    } else {
      console.warn('Received MCP response for unknown request:', message.id);
    }
  }

  private handleDisconnection(ws: WebSocket): void {
    const connection = this.findConnectionByWs(ws);
    if (connection) {
      console.log(`Device ${connection.deviceId} disconnected`);
      
      // Update device status in database
      DeviceModel.updateStatus(connection.deviceId, 'offline', new Date())
        .catch(error => console.error('Error updating device status on disconnect:', error));
      
      this.connections.delete(connection.deviceId);
    }
  }

  async sendMCPRequest(userId: string, request: MCPRequest): Promise<MCPResponse> {
    // Find user's device
    const device = await DeviceModel.findByUserId(userId);
    if (!device) {
      throw new Error('No device registered for user');
    }

    const connection = this.connections.get(device.id);
    if (!connection) {
      throw new Error('Device not connected');
    }

    const requestId = uuidv4();
    const message: DeviceMessage = {
      id: requestId,
      type: 'mcp_request',
      payload: { ...request, id: requestId },
      timestamp: Date.now()
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('MCP request timeout'));
      }, 30000); // 30 second timeout

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.sendMessage(connection.ws, message);
    });
  }

  isDeviceOnline(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  private findConnectionByWs(ws: WebSocket): DeviceConnection | undefined {
    for (const connection of this.connections.values()) {
      if (connection.ws === ws) {
        return connection;
      }
    }
    return undefined;
  }

  private removeDeviceConnection(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (connection) {
      connection.ws.close();
      this.connections.delete(deviceId);
    }
  }

  private sendMessage(ws: WebSocket, message: DeviceMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    this.sendMessage(ws, {
      id: uuidv4(),
      type: 'error',
      payload: { error },
      timestamp: Date.now()
    });
  }

  private cleanupStaleConnections(): void {
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    for (const [deviceId, connection] of this.connections.entries()) {
      if (now - connection.lastHeartbeat.getTime() > staleThreshold) {
        console.log(`Removing stale connection for device ${deviceId}`);
        this.removeDeviceConnection(deviceId);
        
        // Update device status
        DeviceModel.updateStatus(deviceId, 'offline', new Date())
          .catch(error => console.error('Error updating device status:', error));
      }
    }
  }

  private cleanupExpiredRequests(): void {
    // This is handled by individual timeouts, but we could add additional cleanup here
    console.log(`Active connections: ${this.connections.size}, Pending requests: ${this.pendingRequests.size}`);
  }
}