# API Reference

This document provides comprehensive API documentation for the Desktop Commander Remote Server, including REST endpoints, MCP tools, and WebSocket communication.

## 📡 Server Endpoints

### Base URL
- **Development**: `http://localhost:3007`
- **Production**: `https://your-domain.com`

### Public Endpoints

#### `GET /`
Server information and capabilities.

**Response:**
```json
{
  "service": "Desktop Commander Remote Server",
  "version": "1.0.0",
  "protocol_version": "2024-11-05",
  "transport": "http",
  "authentication": "oauth2",
  "endpoints": {
    "mcp": "/mcp",
    "authorize": "/authorize",
    "token": "/token",
    "register": "/register"
  },
  "features": [
    "HTTP transport",
    "OAuth 2.0 with PKCE",
    "Supabase authentication",
    "User-scoped tool execution",
    "Session management",
    "Tool call logging"
  ],
  "timestamp": "2024-01-15T10:30:00Z"
}
```



### OAuth 2.0 Endpoints

#### `GET /.well-known/oauth-authorization-server`
OAuth 2.0 discovery document.

**Response:**
```json
{
  "issuer": "http://localhost:3007",
  "authorization_endpoint": "http://localhost:3007/authorize",
  "token_endpoint": "http://localhost:3007/token",
  "registration_endpoint": "http://localhost:3007/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp:tools"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
  "resource_indicators_supported": true
}
```

#### `GET /authorize`
OAuth 2.0 authorization endpoint.

**Query Parameters:**
- `client_id` (required): Client identifier
- `redirect_uri` (required): Callback URL
- `code_challenge` (required): PKCE code challenge
- `code_challenge_method` (required): Must be "S256"
- `scope` (optional): Requested scope (default: "mcp:tools")
- `state` (optional): Client state parameter

**Example:**
```
GET /authorize?client_id=mcp-agent&redirect_uri=http://localhost:8080/callback&code_challenge=CHALLENGE&code_challenge_method=S256&scope=mcp:tools
```

#### `POST /token`
OAuth 2.0 token endpoint.

**Request Body:**
```json
{
  "grant_type": "authorization_code",
  "client_id": "mcp-agent",
  "redirect_uri": "http://localhost:8080/callback",
  "code": "auth_code_here",
  "code_verifier": "code_verifier_here"
}
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "mcp:tools",
  "resource": "http://localhost:3007"
}
```

#### `POST /register`
OAuth 2.0 client registration endpoint.

**Request Body:**
```json
{
  "client_name": "MCP Agent",
  "redirect_uris": ["http://localhost:8080/callback"],
  "scope": "mcp:tools"
}
```

### Authenticated Endpoints

All endpoints below require authentication via `Authorization: Bearer <token>` header.

#### `GET|POST /mcp`
MCP protocol message handling.

**Headers:**
- `Authorization: Bearer <access_token>` (required)
- `Content-Type: application/json`
- `mcp-session-id: <session_id>` (optional)

**Request Body (POST):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "remote_echo",
    "arguments": {
      "text": "Hello from remote agent!"
    }
  }
}
```

#### `GET /tools`
List available MCP tools.

**Response:**
```json
{
  "tools": [
    {
      "name": "remote_echo",
      "description": "Echo text via remote agent",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Text to echo"
          }
        },
        "required": ["text"]
      }
    },
    {
      "name": "agent_status",
      "description": "Get status of connected agents",
      "inputSchema": {
        "type": "object"
      }
    }
  ],
  "count": 2,
  "user_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Configuration Endpoints

#### `GET /api/mcp-info`
MCP client configuration information.

**Headers:**
- `Authorization: Bearer <access_token>` (required)

**Response:**
```json
{
  "mcpServerUrl": "http://localhost:3007",
  "supabaseUrl": "https://project.supabase.co",
  "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIs...",
  "redirectUrl": "http://localhost:3007/auth/callback",
  "authorizationEndpoint": "http://localhost:3007/authorize",
  "tokenEndpoint": "http://localhost:3007/token",
  "discoveryEndpoint": "http://localhost:3007/.well-known/oauth-authorization-server"
}
```

### Callback Endpoints

#### `GET /auth/callback`
OAuth callback handler for authentication flow.

**Query Parameters:**
- `access_token` (optional): Supabase access token
- `refresh_token` (optional): Supabase refresh token
- `error` (optional): Error code
- `error_description` (optional): Error description
- `state` (optional): Client state parameter

## 🔧 MCP Tools

### Core Tools

#### `remote_echo`
Test tool for remote agent connectivity.

**Purpose:** Verify end-to-end communication between server and remote agents.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "description": "Text to echo back"
    }
  },
  "required": ["text"]
}
```

**Example Usage:**
```json
{
  "name": "remote_echo",
  "arguments": {
    "text": "Hello from Claude Desktop!"
  }
}
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Hello from Claude Desktop!"
    }
  ]
}
```

**Error Cases:**
- `No agents available`: No connected agents for the user
- `Tool call timeout`: Agent didn't respond within 30 seconds

#### `agent_status`
Get information about connected agents.

**Purpose:** Monitor agent connectivity and capabilities.

**Input Schema:**
```json
{
  "type": "object"
}
```

**Example Usage:**
```json
{
  "name": "agent_status",
  "arguments": {}
}
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"agents\": [\n    {\n      \"name\": \"Agent-MacBook-Pro\",\n      \"status\": \"online\",\n      \"last_seen\": \"2024-01-15T10:29:45Z\"\n    },\n    {\n      \"name\": \"Agent-Ubuntu-Server\",\n      \"status\": \"offline\",\n      \"last_seen\": \"2024-01-15T09:15:30Z\"\n    }\n  ]\n}"
    }
  ]
}
```

### Database Tools

#### `supabase_query`
Execute read-only database queries on user-scoped tables.

**Purpose:** Query tool call history and agent data.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "table": {
      "type": "string",
      "enum": ["mcp_agents", "mcp_remote_calls"],
      "description": "Table to query"
    },
    "columns": {
      "type": "string",
      "description": "Columns to select",
      "default": "*"
    },
    "filters": {
      "type": "object",
      "description": "Filter conditions"
    },
    "order_by": {
      "type": "string",
      "description": "Order by column"
    },
    "limit": {
      "type": "integer",
      "description": "Limit results",
      "maximum": 100
    }
  },
  "required": ["table"]
}
```

**Example Usage:**
```json
{
  "service": "desktop-commander-remote-server",
  "arguments": {
    "table": "mcp_remote_calls",
    "columns": "tool_name, status, created_at",
    "filters": {
      "status": "completed"
    },
    "order_by": "created_at",
    "limit": 10
  }
}
```

#### `user_info`
Get current user information and session details.

**Purpose:** Display user context and authentication status.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "include_metadata": {
      "type": "boolean",
      "description": "Include user metadata",
      "default": false
    }
  }
}
```

**Example Usage:**
```json
{
  "name": "user_info",
  "arguments": {
    "include_metadata": true
  }
}
```

## 📨 Real-time Communication

### Supabase Channels

The system uses Supabase real-time channels for communication between the server and remote agents.

#### Channel Naming
- **Pattern**: `mcp_user_{user_id}`
- **Scope**: User-specific channels ensure isolation
- **Security**: Only authenticated users can access their channels

#### Channel Events

##### `tool_call` (Server → Agent)
Broadcast when a tool call needs to be executed.

**Payload:**
```json
{
  "call_id": "550e8400-e29b-41d4-a716-446655440000",
  "tool_name": "echo",
  "args": {
    "text": "Hello World"
  }
}
```

##### `tool_result` (Agent → Server)
Broadcast when a tool call completes or fails.

**Success Payload:**
```json
{
  "call_id": "550e8400-e29b-41d4-a716-446655440000",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Hello World"
      }
    ]
  }
}
```

**Error Payload:**
```json
{
  "call_id": "550e8400-e29b-41d4-a716-446655440000",
  "error": "Tool execution failed: command not found"
}
```

#### Presence Tracking

Agents track their presence on channels to indicate availability.

**Presence Data:**
```json
{
  "agent_id": "agent_123",
  "device_id": "MacBook-Pro-abc123",
  "status": "online",
  "hostname": "MacBook-Pro.local"
}
```

## 🔒 Authentication & Authorization

### Token-Based Authentication

All authenticated endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Rate Limiting

**Default Limits:**
- 100 requests per minute per user
- 5 MCP connections per user
- 30-second timeout per tool call

**Headers:**
- `X-RateLimit-Limit`: Request limit
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Reset timestamp

### CORS Configuration

**Allowed Origins:**
- `http://localhost:*` (development)
- Configured production domains

**Allowed Methods:**
- GET, POST, PUT, DELETE, OPTIONS

**Allowed Headers:**
- Origin, X-Requested-With, Content-Type, Accept, Authorization

## 📊 Error Handling

### HTTP Status Codes

- `200 OK`: Successful request
- `201 Created`: Resource created
- `400 Bad Request`: Invalid request parameters
- `401 Unauthorized`: Missing or invalid authentication
- `403 Forbidden`: Insufficient permissions
- `404 Not Found`: Resource not found
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

### Error Response Format

```json
{
  "error": "invalid_request",
  "error_description": "Missing required parameter: code_challenge",
  "request_id": "req_123456"
}
```

### MCP Error Codes

Following JSON-RPC 2.0 error codes:

- `-32700`: Parse error
- `-32600`: Invalid Request
- `-32601`: Method not found
- `-32602`: Invalid params
- `-32603`: Internal error
- `-32001`: Authentication required

### Common Error Scenarios

#### Tool Call Failures

**No Agents Available:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "No agents available - please connect an agent to use remote tools"
  }
}
```

**Tool Call Timeout:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Tool call timeout - agent did not respond"
  }
}
```

#### Authentication Failures

**Invalid Token:**
```json
{
  "error": "invalid_token",
  "error_description": "The access token provided is invalid, expired, or revoked"
}
```

**Missing Authorization:**
```json
{
  "error": "access_denied",
  "error_description": "Authorization header is required"
}
```

## 📈 Monitoring & Analytics

### Server Metrics

Available via the `/` endpoint (server info) or `/stats` (authenticated):

- Server version and capabilities
- Platform information

### Tool Usage Analytics

Track tool usage patterns:

- Most used tools by user
- Success/failure rates
- Average execution time
- Agent connectivity patterns

### Database Monitoring

Monitor database performance:

- Query execution time
- Connection pool usage
- Row-level security policy performance
- Real-time subscription counts

## 🔌 Client Integration

### Claude Desktop Configuration

```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": ["/path/to/your/connector-script.js"],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3007"
      }
    }
  }
}
```

### Custom Client Implementation

Basic HTTP client example:

```javascript
class MCPClient {
  constructor(serverUrl, accessToken) {
    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
  }

  async callTool(toolName, args) {
    const response = await fetch(`${this.serverUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      })
    });

    return response.json();
  }
}
```

### WebSocket Integration

For real-time updates (agents only):

```javascript
const supabase = createClient(url, key, {
  global: { headers: { Authorization: `Bearer ${token}` } }
});

const channel = supabase.channel(`mcp_user_${userId}`)
  .on('broadcast', { event: 'tool_call' }, handleToolCall)
  .subscribe();
```

---

This API reference provides complete documentation for integrating with and extending the Desktop Commander Remote Server.