# Supabase MCP OAuth Flow

This document explains how the OAuth authentication works with the Supabase MCP Server.

## How OAuth Works

The Supabase MCP Server uses OAuth for authentication, similar to the passport-oauth approach. When Claude Desktop connects, the following flow occurs:

### 1. Initial Connection Attempt

When you add the MCP server to Claude Desktop:

```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": ["src/client/sse-connector.js"],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3007"
      }
    }
  }
}
```

### 2. OAuth Flow Initiation

1. **No Access Token** → SSE Connector detects missing authentication
2. **Browser Opens** → Automatic redirect to `http://localhost:3007/authorize`
3. **OAuth Parameters** → Includes client_id, redirect_uri, scope, state
4. **Auth Page Loads** → Supabase authentication interface appears

### 3. User Authentication

1. **Sign In/Sign Up** → User enters Supabase credentials
2. **Supabase Auth** → Validates user with Supabase backend
3. **Token Generation** → Supabase generates access/refresh tokens
4. **Callback** → Redirects to `/auth/callback` with tokens

### 4. Session Storage

1. **Token Validation** → Server verifies token with Supabase
2. **Session Creation** → Stores session in `mcp_sessions` table
3. **Return to Client** → Redirects back to original application

### 5. MCP Connection

1. **Token Available** → SSE Connector now has access token
2. **Authenticated Connection** → Connects to `/sse` endpoint with Bearer token
3. **MCP Ready** → Tools and features become available

## Current Implementation Status

### ✅ **Working Components:**

- **MCP Server** with integrated OAuth endpoints (`/authorize`, `/auth/callback`)
- **Web Authentication** interface with Supabase integration
- **SSE Connector** with OAuth flow detection and browser opening
- **Database Schema** with sessions and tool call tracking

### 🚧 **Current Limitation:**

The OAuth flow currently requires manual completion:

1. **Browser Opens** → User must authenticate manually
2. **Manual Restart** → After auth, connector needs restart with token
3. **Token Required** → For now, must set `SUPABASE_ACCESS_TOKEN` env var

### 🔮 **Future Enhancement:**

The ideal flow would be:

1. **Automatic Callback** → Connector waits for OAuth callback
2. **Token Capture** → Automatically captures tokens from callback
3. **Seamless Connection** → No manual restart required

## Testing the OAuth Flow

### Manual Test:

```bash
# 1. Start MCP Server
npm start

# 2. Test OAuth (opens browser)
MCP_SERVER_URL=http://localhost:3007 node src/client/sse-connector.js

# 3. Complete authentication in browser
# 4. Copy access_token from success page
# 5. Test with token:
MCP_SERVER_URL=http://localhost:3007 SUPABASE_ACCESS_TOKEN=your_token node src/client/sse-connector.js
```

### Automated Test:

```bash
# Use the test connector
npm run test-oauth
```

## OAuth Endpoints

| Endpoint | Purpose | Parameters |
|----------|---------|------------|
| `/authorize` | Start OAuth flow | `response_type`, `client_id`, `redirect_uri`, `scope`, `state` |
| `/auth/callback` | Handle OAuth callback | `access_token`, `refresh_token`, `client_id`, `redirect_uri`, `state` |
| `/api/mcp-info` | Get server configuration | None |

## Security Features

- **Supabase JWT Validation** → All tokens verified with Supabase
- **Row Level Security** → Database access scoped to authenticated user
- **Session Management** → Automatic session cleanup and expiration
- **Rate Limiting** → 100 requests per minute per user
- **HTTPS Ready** → Production deployment with SSL support

The OAuth integration provides a secure, user-friendly authentication experience that matches the quality and ease-of-use of professional OAuth implementations.