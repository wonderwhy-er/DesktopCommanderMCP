# MCP OAuth Workflow Documentation

## 🎉 Success! Complete Working MCP OAuth Implementation

This document provides a comprehensive guide to implementing MCP (Model Context Protocol) with OAuth 2.1 authentication for Claude Desktop Remote MCP Connectors. After solving numerous challenges, this setup now works perfectly!

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Claude        │    │   Cloudflare    │    │   MCP Server    │    │   OAuth Server  │
│   Desktop       │    │   Tunnel        │    │   (Port 3006)   │    │   (Port 4449)   │
│                 │    │   (HTTPS)       │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │                       │
         │ 1. Discovery          │                       │                       │
         │ ────────────────────> │ ──────────────────> │                       │
         │                       │                       │                       │
         │ 2. OAuth Registration │                       │                       │
         │ ────────────────────> │ ──────────────────> │ ──────────────────> │
         │                       │                       │                       │
         │ 3. Authorization Flow │                       │                       │
         │ ────────────────────> │ ──────────────────> │ ──────────────────> │
         │                       │                       │                       │
         │ 4. Token Exchange     │                       │                       │
         │ ────────────────────> │ ──────────────────> │ ──────────────────> │
         │                       │                       │                       │
         │ 5. MCP Communication │                       │                       │
         │ ────────────────────> │ ──────────────────> │                       │
         │                       │                       │                       │
         │ 6. SSE Connection     │                       │                       │
         │ ────────────────────> │ ──────────────────> │                       │
```

## 🔄 Detailed Workflow

### Phase 1: Discovery & Setup

#### Step 1: Initial Discovery
```http
GET https://tunnel-url/
```

**Claude Desktop** calls the root endpoint to discover server capabilities:

```json
{
  "service": "MCP OAuth Server",
  "version": "1.0.0", 
  "protocol_version": "2024-11-05",
  "oauth_required": true,
  "oauth": {
    "authorization_endpoint": "https://tunnel-url/authorize",
    "token_endpoint": "https://tunnel-url/token",
    "registration_endpoint": "https://tunnel-url/register",
    "introspection_endpoint": "https://tunnel-url/introspect",
    "scopes": ["mcp:tools", "mcp:admin"],
    "methods": ["client_secret_post"],
    "pkce_required": true
  }
}
```

#### Step 2: OAuth Protected Resource Discovery
```http
GET https://tunnel-url/.well-known/oauth-protected-resource
```

Returns RFC 8705 metadata about the protected resource:

```json
{
  "resource": "https://tunnel-url",
  "authorization_servers": ["https://tunnel-url"],
  "scopes_supported": ["mcp:tools", "mcp:admin"],
  "bearer_methods_supported": ["header"],
  "mcp_specification_version": "2024-11-05"
}
```

#### Step 3: OAuth Authorization Server Discovery
```http
GET https://tunnel-url/.well-known/oauth-authorization-server
```

Returns OAuth server metadata (RFC 8414):

```json
{
  "issuer": "https://tunnel-url",
  "authorization_endpoint": "https://tunnel-url/authorize",
  "token_endpoint": "https://tunnel-url/token",
  "registration_endpoint": "https://tunnel-url/register",
  "introspection_endpoint": "https://tunnel-url/introspect",
  "scopes_supported": ["openid", "email", "profile", "mcp:tools"]
}
```

### Phase 2: OAuth Authentication

#### Step 4: Dynamic Client Registration
```http
POST https://tunnel-url/register
Content-Type: application/json

{
  "client_name": "Claude Desktop MCP Client",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "mcp:tools"
}
```

**Response:**
```json
{
  "client_id": "uuid-generated-client-id",
  "client_secret": "generated-secret",
  "client_name": "Claude Desktop MCP Client",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"]
}
```

#### Step 5: Authorization Code Flow with PKCE
```http
GET https://tunnel-url/authorize?
  response_type=code&
  client_id={client_id}&
  redirect_uri=https://claude.ai/api/mcp/auth_callback&
  scope=mcp:tools&
  state={random_state}&
  code_challenge={pkce_challenge}&
  code_challenge_method=S256
```

This redirects to the OAuth server's login page, then back to Claude Desktop with an authorization code.

#### Step 6: Token Exchange
```http
POST https://tunnel-url/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code={authorization_code}&
redirect_uri=https://claude.ai/api/mcp/auth_callback&
client_id={client_id}&
client_secret={client_secret}&
code_verifier={pkce_verifier}
```

**Response:**
```json
{
  "access_token": "jwt-access-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh-token",
  "scope": "mcp:tools"
}
```

### Phase 3: MCP Communication

#### Step 7: Authenticated MCP Initialization
```http
POST https://tunnel-url/
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": {
      "name": "Claude Desktop",
      "version": "1.0.0"
    }
  },
  "jsonrpc": "2.0",
  "id": 0
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": "2025-11-25",
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

#### Step 8: SSE Connection Establishment
```http
GET https://tunnel-url/sse
Authorization: Bearer {access_token}
Accept: text/event-stream
```

Establishes Server-Sent Events connection for real-time MCP communication.

#### Step 9: Tools Discovery
```http
POST https://tunnel-url/
Authorization: Bearer {access_token}

{
  "method": "tools/list",
  "jsonrpc": "2.0",
  "id": 1
}
```

#### Step 10: Tool Execution
```http
POST https://tunnel-url/
Authorization: Bearer {access_token}

{
  "method": "tools/call",
  "params": {
    "name": "echo",
    "arguments": {
      "text": "Hello World"
    }
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

## 🎯 Key Components

### MCP Server (Port 3006)
- **Role**: OAuth-protected MCP protocol server
- **Functions**:
  - Proxies OAuth requests to OAuth server
  - Handles MCP protocol messages
  - Validates Bearer tokens via OAuth introspection
  - Manages SSE connections

### OAuth Server (Port 4449)
- **Role**: RFC 6749/8414 compliant OAuth 2.1 authorization server
- **Functions**:
  - Dynamic client registration
  - Authorization code flow with PKCE
  - JWT token issuance and validation
  - Token introspection (RFC 7662)

### Cloudflare Tunnel
- **Role**: HTTPS proxy for local services
- **Functions**:
  - Provides HTTPS endpoints required by Claude Desktop
  - Routes traffic to local MCP server
  - Enables public access to local development setup

## 🚨 Problems Encountered & Solutions

### Problem 1: HTTPS Requirement
**Issue**: Claude Desktop requires HTTPS for SSE connections
```
SSE error: Connection failed - HTTPS required
```

**Solution**: Use Cloudflare tunnel to provide HTTPS:
```bash
cloudflared tunnel --url http://localhost:3006
```

### Problem 2: OAuth Callback URL Mismatch
**Issue**: Claude Desktop uses `https://claude.ai/api/mcp/auth_callback` but server expected localhost
```
OAuth error: redirect_uri_mismatch
```

**Solution**: Updated OAuth server allowlist:
```javascript
const allowedCallbackPatterns = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  /^http:\/\/localhost:\d+\/.*$/
];
```

### Problem 3: SSE Content-Type Issues
**Issue**: OAuth middleware returned JSON responses for SSE requests
```
SSE error: Invalid content type, expected 'text/event-stream'
```

**Solution**: Added SSE-aware error responses:
```javascript
function sendErrorResponse(req, res, statusCode, error, description) {
  const acceptsSSE = req.headers.accept?.includes('text/event-stream');
  if (acceptsSSE) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    res.write(`event: error\ndata: ${JSON.stringify({error})}\n\n`);
    res.end();
  }
}
```

### Problem 4: Token Validation Mismatch
**Issue**: MCP server used local token storage instead of OAuth server validation
```
[OAuth Provider] ❌ Invalid token - token not found in local storage
```

**Solution**: Updated to use OAuth introspection:
```javascript
async validateToken(accessToken) {
  const response = await fetch(`${this.oauthServerUrl}/introspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(accessToken)}`
  });
  
  const result = await response.json();
  return result.active ? result : null;
}
```

### Problem 5: Refresh Token Rotation
**Issue**: OAuth server rotated refresh tokens causing "Invalid refresh token" errors
```
[OAuth] Refresh token grant error: Error: Invalid refresh token
```

**Solution**: Made token rotation configurable:
```javascript
const enableTokenRotation = process.env.ENABLE_REFRESH_TOKEN_ROTATION === 'true';
if (!enableTokenRotation) {
  return { ...accessTokenData, refresh_token: refreshToken }; // Reuse token
}
```

### Problem 6: MCP Endpoint Mismatch
**Issue**: Claude Desktop sent MCP messages to `POST /` but server expected `POST /message`
```
Endpoint POST / not found - available: /message, /tools, /sse
```

**Solution**: Added MCP handler at root endpoint:
```javascript
this.app.post('/', this.tokenValidator, async (req, res) => {
  const response = await this.handleMCPRequestLocally(req.body, req.oauth);
  res.json(response);
});
```

### Problem 7: OAuth Proxy Configuration
**Issue**: Tunnel pointed to MCP server but Claude needed OAuth endpoints
```
{"error":"not_found","message":"Endpoint GET /authorize not found"}
```

**Solution**: Added OAuth proxy endpoints to MCP server:
```javascript
// Proxy OAuth endpoints through MCP server
this.app.get('/authorize', (req, res) => {
  const oauthUrl = new URL(`${this.oauthServerUrl}/authorize`);
  Object.entries(req.query).forEach(([key, value]) => {
    oauthUrl.searchParams.set(key, value);
  });
  res.redirect(oauthUrl.toString());
});

this.app.post('/token', async (req, res) => {
  const formData = new URLSearchParams();
  Object.entries(req.body).forEach(([key, value]) => {
    formData.append(key, value);
  });
  
  const response = await fetch(`${this.oauthServerUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData
  });
  
  const result = await response.json();
  res.status(response.status).json(result);
});
```

### Problem 8: Protocol Version Compatibility
**Issue**: Claude Desktop sent newer protocol versions but server only supported 2024-11-05
```
protocolVersion: "2025-11-25" vs server: "2024-11-05"
```

**Solution**: Added protocol version negotiation:
```javascript
case 'initialize':
  const clientVersion = request.params?.protocolVersion || '2024-11-05';
  const supportedVersions = ['2024-11-05', '2025-06-18', '2025-11-25'];
  const protocolVersion = supportedVersions.includes(clientVersion) 
    ? clientVersion : '2024-11-05';
  
  return {
    jsonrpc: '2.0',
    id: id,
    result: {
      protocolVersion: protocolVersion,
      capabilities: { tools: {}, logging: {} },
      serverInfo: { name: 'mcp-oauth-server', version: '1.0.0' }
    }
  };
```

### Problem 9: Form Data vs JSON Encoding
**Issue**: OAuth endpoints expected form-encoded data but received JSON
```
Token proxy error: invalid json response body - "<!DOCTYPE html>"
```

**Solution**: Fixed request encoding for OAuth endpoints:
```javascript
// Before (incorrect)
body: JSON.stringify(req.body)

// After (correct)
const formData = new URLSearchParams();
Object.entries(req.body).forEach(([key, value]) => {
  formData.append(key, value);
});
headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
body: formData
```

## 🗃️ File Structure

```
passport-oauth/
├── oauth-server/               # OAuth 2.1 Authorization Server
│   ├── server.js              # Main OAuth server
│   ├── models/
│   │   ├── client.cjs         # Client management & allowlist
│   │   ├── token.cjs          # Token generation & validation
│   │   └── user.cjs           # User authentication
│   └── middleware/
│       └── auth.cjs           # OAuth middleware
├── mcp-server/                # OAuth-Protected MCP Server  
│   ├── server.js              # Main MCP server with OAuth proxy
│   ├── middleware/
│   │   ├── oauth.cjs          # Bearer token validation
│   │   └── sse.cjs            # Server-Sent Events management
│   └── routes/
│       ├── message.cjs        # MCP protocol message handling
│       ├── sse.cjs            # SSE endpoint
│       └── health.cjs         # Health check
├── mcp-server-oauth/          # MCP SDK OAuth Provider
│   ├── server.js              # MCP SDK server with OAuth
│   └── oauth-provider.js      # OAuth provider for MCP SDK
└── simple-mcp-server.js       # Standalone OAuth client example
```

## 🚀 Running the Setup

### 1. Start OAuth Server
```bash
cd oauth-server
npm install
DEMO_MODE=true npm start
```

### 2. Start MCP Server
```bash
cd mcp-server  
npm install
OAUTH_BASE_URL=https://oauth-tunnel-url npm run mcp
```

### 3. Create Tunnel
```bash
# For MCP Server (main tunnel)
cloudflared tunnel --url http://localhost:3006

# For OAuth Server (if needed separately)  
cloudflared tunnel --url http://localhost:4449
```

### 4. Configure Claude Desktop
Add to Claude Desktop MCP configuration:
```json
{
  "mcpServers": {
    "oauth-mcp": {
      "command": "node",
      "args": ["connector.js"],
      "env": {
        "MCP_SERVER_URL": "https://tunnel-url"
      }
    }
  }
}
```

## 🔐 Security Features

### OAuth 2.1 Compliance
- ✅ PKCE required for all authorization flows
- ✅ Dynamic client registration (RFC 7591)
- ✅ Token introspection (RFC 7662)  
- ✅ JWT access tokens with proper validation
- ✅ Secure refresh token handling

### MCP Security
- ✅ Bearer token authentication required
- ✅ Scope-based authorization (`mcp:tools`, `mcp:admin`)
- ✅ Token validation on every request
- ✅ Secure SSE connection management
- ✅ Rate limiting and request validation

### Network Security
- ✅ HTTPS-only communication
- ✅ CORS configuration
- ✅ Security headers (CSP, HSTS, etc.)
- ✅ Input validation and sanitization

## 🧪 Testing & Debugging

### Test OAuth Flow
```bash
# 1. Register client
curl -X POST "https://tunnel-url/register" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test Client","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}'

# 2. Get authorization URL
echo "https://tunnel-url/authorize?response_type=code&client_id={client_id}&redirect_uri=https://claude.ai/api/mcp/auth_callback&scope=mcp:tools&state=test&code_challenge={challenge}&code_challenge_method=S256"

# 3. Exchange code for token  
curl -X POST "https://tunnel-url/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code={code}&client_id={client_id}&client_secret={secret}&code_verifier={verifier}"

# 4. Test MCP with token
curl -X POST "https://tunnel-url/" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"method":"initialize","params":{"protocolVersion":"2024-11-05"},"jsonrpc":"2.0","id":0}'
```

### Debug Logs
The implementation includes comprehensive logging:
```javascript
// Request/Response logging
console.log(`🔵 [${timestamp}] INCOMING REQUEST [${requestId}]`);
console.log(`📍 ${req.method} ${req.url}`);
console.log(`🔐 OAuth Server: ${this.oauthServerUrl}`);
console.log(`✅ Token validated for client: ${client_id}`);
```

## 📊 Monitoring

### Health Checks
- `GET /health` - Server health status
- `GET /oauth/stats` - OAuth server statistics  
- SSE connection count monitoring

### Metrics
- Active SSE connections
- Token validation success/failure rates
- OAuth flow completion rates
- MCP request/response timing

## 🎯 Success Indicators

When everything is working correctly, you should see:

1. **✅ OAuth Discovery**: Claude Desktop fetches `.well-known` endpoints
2. **✅ Client Registration**: Successful dynamic client registration
3. **✅ Authorization Flow**: Browser redirects to OAuth server login
4. **✅ Token Exchange**: Successful token exchange with valid JWT
5. **✅ MCP Initialization**: Successful MCP handshake with Bearer token
6. **✅ SSE Connection**: Active Server-Sent Events connection established
7. **✅ Tool Discovery**: Claude Desktop can list and execute MCP tools
8. **✅ Configure Button**: "Configure" button appears in Claude Desktop

### Final Log Output
```
🚀 MCP OAuth Server started
🔐 OAuth Server: https://oauth-server-tunnel
📊 Active SSE Connections: 1
✅ Token validated for client: claude-desktop-client
🔵 MCP message: {"method":"tools/list","id":1}
✅ MCP OAuth Server ready!
```

## 📚 References

- [RFC 6749: OAuth 2.0 Authorization Framework](https://tools.ietf.org/html/rfc6749)
- [RFC 7636: PKCE](https://tools.ietf.org/html/rfc7636)
- [RFC 7662: Token Introspection](https://tools.ietf.org/html/rfc7662)
- [RFC 8414: OAuth Authorization Server Metadata](https://tools.ietf.org/html/rfc8414)
- [RFC 8705: OAuth Protected Resource Metadata](https://tools.ietf.org/html/rfc8705)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Claude Desktop MCP Documentation](https://docs.anthropic.com/en/docs/build-with-claude/computer-use)

---

**🎉 Congratulations!** You now have a fully functional MCP OAuth implementation that works with Claude Desktop Remote MCP Connectors!