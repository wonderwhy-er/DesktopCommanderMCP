# Passport OAuth MCP API Reference

Complete API documentation for the OAuth 2.1 authorization server and MCP OAuth server.

## 🔐 OAuth Authorization Server API

Base URL: `http://localhost:4449`

### Authentication & Authorization

All OAuth endpoints follow RFC 6749, RFC 7636 (PKCE), and RFC 7662 standards.

#### OAuth Server Metadata
**GET** `/.well-known/oauth-authorization-server`

Returns OAuth authorization server metadata (RFC 8414).

**Response:**
```json
{
  "issuer": "http://localhost:4449",
  "authorization_endpoint": "http://localhost:4449/authorize",
  "token_endpoint": "http://localhost:4449/token", 
  "registration_endpoint": "http://localhost:4449/register",
  "introspection_endpoint": "http://localhost:4449/introspect",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "email", "profile", "mcp:tools", "mcp:admin"]
}
```

#### Client Registration
**POST** `/register`

Register a new OAuth client (RFC 7591).

**Request:**
```json
{
  "client_name": "My MCP Client",
  "redirect_uris": ["http://localhost:8847/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid email profile mcp:tools"
}
```

**Response:**
```json
{
  "client_id": "uuid-generated-client-id",
  "client_secret": "secure-generated-secret",
  "client_name": "My MCP Client",
  "redirect_uris": ["http://localhost:8847/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid email profile mcp:tools",
  "token_endpoint_auth_method": "client_secret_post",
  "client_id_issued_at": 1640995200
}
```

#### Authorization Request
**GET** `/authorize`

Initiate OAuth authorization flow.

**Parameters:**
- `response_type` (required): Must be "code"
- `client_id` (required): Client identifier
- `redirect_uri` (required): Callback URI
- `scope` (optional): Requested scopes
- `state` (recommended): CSRF protection
- `code_challenge` (required): PKCE code challenge
- `code_challenge_method` (required): Must be "S256"

**Example:**
```
GET /authorize?response_type=code&client_id=abc123&redirect_uri=http://localhost:8847/callback&scope=mcp:tools&state=xyz789&code_challenge=abc&code_challenge_method=S256
```

**Response:**
- In demo mode: 302 redirect to callback URI with authorization code
- In production: HTML consent form

#### Token Exchange
**POST** `/token`

Exchange authorization code for access token.

**Request:**
```
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=auth_code_here&
redirect_uri=http://localhost:8847/callback&
client_id=client_id_here&
client_secret=client_secret_here&
code_verifier=pkce_code_verifier
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh_token_here",
  "scope": "openid email profile mcp:tools"
}
```

#### Token Refresh
**POST** `/token`

Refresh an access token using refresh token.

**Request:**
```
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
refresh_token=refresh_token_here&
client_id=client_id_here&
client_secret=client_secret_here
```

**Response:**
```json
{
  "access_token": "new_access_token_here",
  "token_type": "Bearer", 
  "expires_in": 3600,
  "refresh_token": "new_refresh_token_here",
  "scope": "openid email profile mcp:tools"
}
```

#### Token Introspection
**POST** `/introspect`

Introspect access token (RFC 7662).

**Request:**
```
Content-Type: application/x-www-form-urlencoded

token=access_token_here
```

**Response (Active Token):**
```json
{
  "active": true,
  "scope": "openid email profile mcp:tools",
  "client_id": "client_id_here",
  "username": "user_id_here",
  "token_type": "Bearer",
  "exp": 1640998800,
  "iat": 1640995200,
  "sub": "user_id_here",
  "aud": "client_id_here",
  "iss": "http://localhost:4449",
  "jti": "token_unique_id"
}
```

**Response (Inactive Token):**
```json
{
  "active": false
}
```

#### Token Revocation
**POST** `/revoke`

Revoke access or refresh token (RFC 7009).

**Request:**
```
Content-Type: application/x-www-form-urlencoded

token=token_to_revoke&
token_type_hint=access_token
```

**Response:**
```json
{
  "revoked": true
}
```

### Administrative Endpoints

#### Server Health
**GET** `/health`

Get OAuth server health status.

**Response:**
```json
{
  "status": "healthy",
  "server": "oauth-authorization-server",
  "version": "1.0.0",
  "uptime": 3600,
  "stats": {
    "clients": 5,
    "tokens": {
      "active_authorization_codes": 2,
      "active_access_tokens": 10, 
      "active_refresh_tokens": 8
    },
    "users": {
      "total_users": 3,
      "verified_users": 3
    }
  }
}
```

#### List Clients (Admin)
**GET** `/admin/clients`

List all registered OAuth clients (demo mode only).

**Response:**
```json
{
  "clients": [
    {
      "client_id": "client-1",
      "client_name": "Test Client",
      "redirect_uris": ["http://localhost:8847/callback"],
      "grant_types": ["authorization_code"],
      "scope": "mcp:tools",
      "created_at": "2024-01-01T00:00:00.000Z",
      "preregistered": false
    }
  ]
}
```

## 🎯 MCP OAuth Server API

Base URL: `http://localhost:3006`

All MCP endpoints require Bearer token authentication.

### Authentication

Include OAuth access token in Authorization header:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### MCP Protocol Endpoints

#### Server Information
**GET** `/`

Get MCP server information.

**Response:**
```json
{
  "service": "MCP OAuth Server",
  "version": "1.0.0",
  "protocol_version": "2024-11-05",
  "oauth_required": true,
  "oauth_server": "http://localhost:4449",
  "endpoints": {
    "sse": "/sse",
    "message": "/message",
    "tools": "/tools",
    "execute": "/execute",
    "health": "/health"
  },
  "capabilities": {
    "transport": ["sse", "http"],
    "authentication": ["oauth2_bearer"],
    "tools": true,
    "resources": false,
    "prompts": false,
    "logging": true
  }
}
```

#### MCP Metadata
**GET** `/.well-known/mcp-server`

Get MCP server metadata and capabilities.

**Response:**
```json
{
  "version": "2024-11-05",
  "server": {
    "name": "mcp-oauth-server",
    "version": "1.0.0"
  },
  "capabilities": {
    "tools": {},
    "logging": {}
  },
  "authentication": {
    "type": "oauth2",
    "authorization_server": "http://localhost:4449",
    "token_endpoint": "http://localhost:4449/token",
    "introspection_endpoint": "http://localhost:4449/introspect",
    "scopes_supported": ["mcp:tools", "mcp:admin"],
    "token_types_supported": ["Bearer"]
  },
  "transport": {
    "sse": {
      "endpoint": "/sse",
      "authentication_required": true
    },
    "http": {
      "endpoint": "/message", 
      "authentication_required": true
    }
  }
}
```

#### Tools List
**GET** `/tools`

Get list of available MCP tools.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "tools": [
    {
      "name": "echo",
      "description": "Echo back the input text",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Text to echo back"
          }
        },
        "required": ["text"]
      }
    },
    {
      "name": "oauth_info",
      "description": "Get OAuth token information",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }
  ]
}
```

#### MCP Message Handling
**POST** `/message`

Handle MCP JSON-RPC requests.

**Headers:**
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Request (Initialize):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "claude-desktop",
      "version": "1.0.0"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {},
      "logging": {}
    },
    "serverInfo": {
      "name": "mcp-oauth-server",
      "version": "1.0.0"
    }
  }
}
```

**Request (Tools List):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "echo",
        "description": "Echo back the input text",
        "inputSchema": {
          "type": "object",
          "properties": {
            "text": {"type": "string"}
          },
          "required": ["text"]
        }
      }
    ]
  }
}
```

**Request (Tool Call):**
```json
{
  "jsonrpc": "2.0", 
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "echo",
    "arguments": {
      "text": "Hello, MCP!"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Echo: Hello, MCP!"
      }
    ]
  }
}
```

#### Server-Sent Events
**GET** `/sse`

Establish SSE connection for real-time communication.

**Headers:**
```
Authorization: Bearer <access_token>
Accept: text/event-stream
```

**Response Stream:**
```
event: connected
data: {"connectionId": "sse-123", "clientId": "client-abc", "timestamp": "2024-01-01T00:00:00Z"}

event: heartbeat  
data: {"timestamp": "2024-01-01T00:01:00Z", "server_time": 1640995260000}

event: mcp_request
data: {"id": "req-1", "request": {"method": "tools/call", "params": {...}}, "timestamp": "2024-01-01T00:02:00Z"}
```

### Health & Monitoring

#### Health Check
**GET** `/health`

Get MCP server health status.

**Response:**
```json
{
  "status": "healthy",
  "service": "mcp-oauth-server",
  "version": "1.0.0",
  "uptime": {
    "seconds": 3600,
    "human": "1h"
  },
  "memory": {
    "used": 45,
    "total": 128,
    "rss": 67
  },
  "sse": {
    "total_connections": 3,
    "unique_clients": 2,
    "connections_by_client": {
      "client-1": 2,
      "client-2": 1
    }
  },
  "oauth": {
    "introspection_url": "http://localhost:4449/introspect",
    "cache_enabled": true
  }
}
```

#### Deep Health Check  
**GET** `/health/deep`

Comprehensive health check with dependency testing.

**Response:**
```json
{
  "status": "pass",
  "version": "1.0.0",
  "checks": {
    "oauth_metadata": {
      "status": "pass",
      "response_time_ms": 45,
      "url": "http://localhost:4449/.well-known/oauth-authorization-server"
    },
    "remote_server": {
      "status": "pass",
      "response_time_ms": 23,
      "url": "http://localhost:3002/health"
    },
    "sse": {
      "status": "pass",
      "total_connections": 3,
      "unique_clients": 2
    }
  }
}
```

#### SSE Status
**GET** `/sse/status`

Get SSE connection status.

**Response:**
```json
{
  "service": "sse",
  "status": "active",
  "total_connections": 5,
  "unique_clients": 3,
  "connections_by_client": {
    "client-1": 2,
    "client-2": 2,
    "client-3": 1
  }
}
```

### Administrative Endpoints (Requires `mcp:admin` scope)

#### Send Message to Client
**POST** `/sse/send/:clientId`

Send message to specific client via SSE.

**Headers:**
```
Authorization: Bearer <admin_access_token>
Content-Type: application/json
```

**Request:**
```json
{
  "eventType": "notification",
  "data": {
    "message": "Hello from admin",
    "priority": "high"
  }
}
```

**Response:**
```json
{
  "success": true,
  "clientId": "client-1", 
  "eventType": "notification",
  "sentCount": 2
}
```

#### Broadcast Message
**POST** `/sse/broadcast`

Broadcast message to all connected clients.

**Request:**
```json
{
  "eventType": "system_announcement",
  "data": {
    "message": "Server maintenance in 5 minutes",
    "type": "warning"
  }
}
```

**Response:**
```json
{
  "success": true,
  "eventType": "system_announcement", 
  "sentCount": 12
}
```

## 🔒 Security & Scopes

### Supported Scopes

| Scope | Description |
|-------|-------------|
| `openid` | OpenID Connect identity |
| `email` | User email address |
| `profile` | User profile information |
| `mcp:tools` | Execute MCP tools |
| `mcp:admin` | Administrative access |

### Error Responses

#### OAuth Errors (RFC 6749)

```json
{
  "error": "invalid_request",
  "error_description": "Missing required parameter: client_id"
}
```

**Common OAuth Error Codes:**
- `invalid_request` - Malformed request
- `invalid_client` - Client authentication failed
- `invalid_grant` - Invalid authorization code/refresh token
- `unauthorized_client` - Client not authorized for grant type
- `unsupported_grant_type` - Grant type not supported
- `invalid_scope` - Requested scope invalid

#### MCP Errors

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found",
    "data": "Unknown method: invalid/method"
  }
}
```

**MCP Error Codes:**
- `-32700` - Parse error
- `-32600` - Invalid request
- `-32601` - Method not found
- `-32602` - Invalid params
- `-32603` - Internal error

#### HTTP Error Responses

**401 Unauthorized:**
```json
{
  "error": "unauthorized",
  "error_description": "Bearer token required"
}
```

**403 Forbidden:**
```json
{
  "error": "insufficient_scope",
  "error_description": "Required scopes: mcp:admin"
}
```

**429 Too Many Requests:**
```json
{
  "error": "too_many_requests",
  "error_description": "Rate limit exceeded"
}
```

## 📊 Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/authorize` | 30 requests | 1 minute |
| `/token` | 100 requests | 1 minute |
| `/register` | 10 requests | 5 minutes |
| `/introspect` | 200 requests | 1 minute |
| `/message` | No limit | - |
| `/sse` | 5 connections | Per client |

## 🔧 Client Libraries

### JavaScript/Node.js Example

```javascript
const MCPOAuthClient = require('./oauth-client');

const client = new MCPOAuthClient({
  oauthServerUrl: 'http://localhost:4449',
  mcpServerUrl: 'http://localhost:3006'
});

// Authenticate
await client.authenticate();

// Get tools
const tools = await client.getTools();

// Call tool
const result = await client.callTool('echo', { text: 'Hello!' });
```

### cURL Examples

```bash
# Register client
curl -X POST http://localhost:4449/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test","redirect_uris":["http://localhost:8080/callback"]}'

# Get OAuth metadata
curl http://localhost:4449/.well-known/oauth-authorization-server

# Get MCP tools (with token)
curl -H "Authorization: Bearer <token>" \
  http://localhost:3006/tools

# Execute MCP tool
curl -X POST http://localhost:3006/message \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"test"}}}'
```

This API reference covers all available endpoints for both the OAuth authorization server and MCP OAuth server components.