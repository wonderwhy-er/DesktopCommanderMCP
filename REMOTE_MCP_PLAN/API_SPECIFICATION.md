# API Specification

## Overview

This document defines the API contracts, protocols, and data formats for all communication between components in the Remote MCP extension.

## MCP Protocol Extensions

### Extended MCP Request Format

```typescript
interface RemoteMCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
  
  // Remote MCP extensions
  remote?: {
    targetDevices?: string[] | "all" | "group:name";
    timeout?: number;           // milliseconds
    parallel?: boolean;         // execute on multiple devices simultaneously
    aggregation?: "merge" | "first" | "all";
    fallback?: {
      onError?: "continue" | "abort";
      onTimeout?: "partial" | "abort";
    };
  };
}
```

### Extended MCP Response Format

```typescript
interface RemoteMCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: MCPError;
  
  // Remote MCP extensions
  remote?: {
    sourceDevice?: string;
    executionTime?: number;
    aggregated?: boolean;
    partialResults?: boolean;
    deviceResults?: {
      [deviceId: string]: {
        result?: any;
        error?: MCPError;
        executionTime: number;
      };
    };
  };
}
```

## REST API Endpoints

### Authentication Endpoints

#### POST /auth/oauth/authorize
Initiate OAuth 2.0 authorization flow

**Request:**
```json
{
  "client_id": "claude-desktop",
  "response_type": "code",
  "scope": "mcp:execute mcp:read mcp:write",
  "redirect_uri": "https://claude.ai/mcp/callback",
  "state": "random-state-string"
}
```

**Response:**
```json
{
  "authorization_url": "https://auth.desktop.commander.app/oauth/authorize?...",
  "state": "random-state-string"
}
```

#### POST /auth/oauth/token
Exchange authorization code for access token

**Request:**
```json
{
  "grant_type": "authorization_code",
  "code": "authorization-code",
  "redirect_uri": "https://claude.ai/mcp/callback",
  "client_id": "claude-desktop",
  "client_secret": "client-secret"
}
```

**Response:**
```json
{
  "access_token": "jwt-access-token",
  "refresh_token": "jwt-refresh-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "mcp:execute mcp:read mcp:write"
}
```

### Device Management Endpoints

#### GET /api/v1/devices
List user's registered devices

**Headers:**
```
Authorization: Bearer {access_token}
```

**Response:**
```json
{
  "devices": [
    {
      "id": "device-uuid",
      "name": "MacBook Pro",
      "type": "desktop",
      "status": "online",
      "lastSeen": "2025-01-15T10:30:00Z",
      "capabilities": ["filesystem", "terminal", "search"],
      "location": "San Francisco, CA",
      "metadata": {
        "os": "macOS 14.0",
        "architecture": "arm64"
      }
    }
  ]
}
```

#### POST /api/v1/devices/register
Register a new device

**Request:**
```json
{
  "name": "My Server",
  "type": "server",
  "capabilities": ["filesystem", "terminal"]
}
```

**Response:**
```json
{
  "device": {
    "id": "new-device-uuid",
    "name": "My Server",
    "registrationUrl": "https://auth.desktop.commander.app/device/register?code=ABC123",
    "deviceCode": "ABC123",
    "expiresIn": 600
  }
}
```

#### PUT /api/v1/devices/{deviceId}/config
Update device configuration

**Request:**
```json
{
  "configuration": {
    "allowedDirectories": ["/home/user", "/workspace"],
    "blockedCommands": ["rm -rf", "sudo rm"],
    "resourceLimits": {
      "maxMemory": 1073741824,
      "maxCPU": 80,
      "maxDisk": 10737418240
    }
  }
}
```

#### DELETE /api/v1/devices/{deviceId}
Unregister a device

**Response:**
```json
{
  "message": "Device unregistered successfully"
}
```

### MCP Execution Endpoints

#### POST /api/v1/mcp/execute
Execute MCP request on remote devices

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "method": "read_file",
  "params": {
    "path": "/home/user/document.txt"
  },
  "remote": {
    "targetDevices": ["device-uuid-1"],
    "timeout": 30000
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "result": {
    "content": "file contents...",
    "metadata": {
      "size": 1234,
      "lastModified": "2025-01-15T10:30:00Z"
    }
  },
  "remote": {
    "sourceDevice": "device-uuid-1",
    "executionTime": 156
  }
}
```

#### POST /api/v1/mcp/batch
Execute multiple MCP requests

**Request:**
```json
{
  "requests": [
    {
      "jsonrpc": "2.0",
      "id": "1",
      "method": "list_directory",
      "params": { "path": "/home" },
      "remote": { "targetDevices": ["device-1"] }
    },
    {
      "jsonrpc": "2.0", 
      "id": "2",
      "method": "read_file",
      "params": { "path": "/etc/hosts" },
      "remote": { "targetDevices": ["device-2"] }
    }
  ]
}
```

## WebSocket Protocol (Agent Communication)

### Connection Establishment

**URL:** `wss://api.desktop.commander.app/agent/connect`

**Headers:**
```
Authorization: Bearer {device_token}
X-Device-ID: {device_uuid}
X-Agent-Version: 1.0.0
```

### Message Types

#### Heartbeat
```json
{
  "type": "heartbeat",
  "id": "msg-uuid",
  "timestamp": 1673884800000,
  "payload": {
    "status": "healthy",
    "uptime": 3600,
    "systemLoad": {
      "cpu": 25.5,
      "memory": 67.8,
      "disk": 45.2
    }
  }
}
```

#### MCP Request Forwarding
```json
{
  "type": "mcp_request",
  "id": "msg-uuid",
  "timestamp": 1673884800000,
  "payload": {
    "jsonrpc": "2.0",
    "id": "mcp-request-id",
    "method": "start_process",
    "params": {
      "command": "python3 -c 'print(\"Hello World\")'",
      "timeout_ms": 5000
    }
  },
  "signature": "hmac-sha256-signature"
}
```

#### MCP Response
```json
{
  "type": "mcp_response", 
  "id": "msg-uuid",
  "timestamp": 1673884800000,
  "payload": {
    "jsonrpc": "2.0",
    "id": "mcp-request-id",
    "result": {
      "pid": 12345,
      "output": "Hello World\n",
      "exitCode": 0
    }
  },
  "executionMeta": {
    "startTime": 1673884800000,
    "endTime": 1673884801000,
    "memoryUsed": 25165824,
    "cpuTime": 100
  }
}
```

#### Configuration Update
```json
{
  "type": "config_update",
  "id": "msg-uuid",
  "timestamp": 1673884800000,
  "payload": {
    "configuration": {
      "allowedDirectories": ["/home/user", "/tmp"],
      "blockedCommands": ["rm -rf /", "sudo rm -rf"],
      "logLevel": "info"
    }
  }
}
```

#### Error Messages
```json
{
  "type": "error",
  "id": "msg-uuid", 
  "timestamp": 1673884800000,
  "payload": {
    "code": "EXECUTION_FAILED",
    "message": "Failed to execute MCP request",
    "details": {
      "originalRequest": "mcp-request-id",
      "error": "File not found: /nonexistent/file.txt"
    }
  }
}
```

## Error Handling

### Standard Error Codes

```typescript
enum RemoteMCPErrorCode {
  // Authentication errors
  INVALID_TOKEN = -32001,
  TOKEN_EXPIRED = -32002,
  INSUFFICIENT_SCOPE = -32003,
  
  // Device errors  
  DEVICE_NOT_FOUND = -32010,
  DEVICE_OFFLINE = -32011,
  DEVICE_UNAUTHORIZED = -32012,
  DEVICE_OVERLOADED = -32013,
  
  // Execution errors
  EXECUTION_TIMEOUT = -32020,
  EXECUTION_FAILED = -32021,
  PARTIAL_EXECUTION = -32022,
  
  // System errors
  SERVICE_UNAVAILABLE = -32030,
  RATE_LIMITED = -32031,
  QUOTA_EXCEEDED = -32032
}

interface RemoteMCPError {
  code: RemoteMCPErrorCode;
  message: string;
  data?: {
    deviceId?: string;
    retryAfter?: number;
    partialResults?: any;
    failedDevices?: string[];
  };
}
```

### Error Response Examples

#### Device Offline
```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "error": {
    "code": -32011,
    "message": "Device is offline",
    "data": {
      "deviceId": "device-uuid",
      "lastSeen": "2025-01-15T09:30:00Z"
    }
  }
}
```

#### Partial Execution
```json
{
  "jsonrpc": "2.0", 
  "id": "request-id",
  "error": {
    "code": -32022,
    "message": "Partial execution completed",
    "data": {
      "partialResults": {
        "device-1": { "result": "success" },
        "device-2": { "error": "timeout" }
      },
      "failedDevices": ["device-2"]
    }
  }
}
```

## Rate Limiting

### Rate Limit Headers
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1673888400
X-RateLimit-Window: 3600
```

### Rate Limit Tiers
- **Free Tier**: 100 requests/hour
- **Pro Tier**: 1,000 requests/hour  
- **Enterprise**: 10,000 requests/hour
- **Burst**: 10x normal rate for 60 seconds

## Versioning Strategy

### API Versioning
- Version in URL path: `/api/v1/`
- Backward compatibility for 2 major versions
- Deprecation notices with 6-month transition period

### Protocol Versioning
- MCP protocol version in request headers
- Feature negotiation during connection
- Graceful degradation for unsupported features

This API specification ensures consistent, secure, and scalable communication across all Remote MCP components while maintaining compatibility with existing MCP clients.