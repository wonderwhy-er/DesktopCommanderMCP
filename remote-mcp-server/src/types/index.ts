export interface User {
  id: string;
  email: string;
  name: string;
  provider?: string;
  provider_id?: string;
  created_at: Date;
}

export interface Device {
  id: string;
  user_id: string;
  name: string;
  status: 'online' | 'offline';
  last_seen?: Date;
  created_at: Date;
}

export interface Session {
  id: string;
  user_id: string;
  device_id?: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface DeviceMessage {
  id: string;
  type: 'mcp_request' | 'mcp_response' | 'heartbeat' | 'auth' | 'error';
  payload?: any;
  timestamp: number;
}

export interface AuthenticatedRequest extends Express.Request {
  user?: User;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}