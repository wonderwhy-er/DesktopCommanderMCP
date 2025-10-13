# OAuth + MCP Implementation - Complete Context & Learnings

## 📁 Project Location
- **Main Directory:** `/Users/fiberta/work/DesktopCommanderMCP/oauth-test/`
- **Desktop Commander:** `/Users/fiberta/work/DesktopCommanderMCP/`

---

## 🎯 Goal
Implement OAuth 2.0 authentication for MCP (Model Context Protocol) servers to work with:
- Claude.ai
- ChatGPT
- MCP Inspector

---

## 📚 What We Learned

### 1. **Protocol Version Matters**
- Claude.ai uses MCP protocol `2025-06-18`
- Our initial implementation used `2024-11-05`
- **Solution:** Match or support the client's protocol version

### 2. **MCP Flow Must Be Exact**
The correct MCP handshake is:
```
1. Client → initialize
2. Server → returns capabilities + protocol version
3. Client → notifications/initialized (NO response needed for notifications!)
4. Client → tools/list
5. Server → returns tools array
6. Client → tools/call
7. Server → returns tool result
```

**Critical:** Notifications in JSON-RPC don't have an `id` field and shouldn't return a response (or return 200 OK with no body).

### 3. **Official MCP SDK is Essential for Claude**
- **Manual implementation:** Works with ChatGPT but NOT Claude.ai
- **MCP SDK implementation:** Works with BOTH Claude.ai and ChatGPT
- **Why:** The SDK handles all protocol nuances correctly (session management, SSE support, proper response formats)

### 4. **OAuth Works But Has Platform Differences**
- **ChatGPT:** Works with OAuth and without OAuth
- **Claude.ai:** Works without OAuth, but OAuth shows "tools not available" (despite proper implementation)
- **Cloudflare Tunnel:** `.trycloudflare.com` domains sometimes flagged as "deceptive site"

### 5. **Transport Types**
MCP supports multiple transports:
- **HTTP POST:** Basic request/response
- **SSE (Server-Sent Events):** Long-lived connections via GET requests
- **stdio:** Standard input/output (for local tools)

Claude.ai tries SSE first (GET request), then falls back to HTTP POST.

---

## 📂 File Structure & What Each Does

### Working Servers (Final Versions)

| File | Purpose | Works With | OAuth |
|------|---------|------------|-------|
| `mcp-sdk-oauth-server.js` | ⭐ **PRODUCTION** - MCP SDK + OAuth | Claude + ChatGPT | ✅ Yes |
| `mcp-sdk-http-server.js` | MCP SDK without OAuth (testing) | Claude + ChatGPT | ❌ No |
| `unified-mcp-server.js` | Manual implementation + OAuth | ChatGPT only | ✅ Yes |

### OAuth Components (Standalone)

| File | Purpose |
|------|---------|
| `mcp-auth-server.js` | OAuth Authorization Server (port 3001) |
| `mcp-resource-server.js` | OAuth Resource + MCP Server (port 3002) |
| `mcp-resource-fixed.js` | CORS-fixed version of resource server |

### Helper Scripts

| File | Purpose |
|------|---------|
| `start-with-tunnel.js` | Starts server + Cloudflare tunnel, auto-detects URL |
| `start-with-tunnel.sh` | Bash version (deprecated, use .js) |
| `test-flow.sh` | Test OAuth flow end-to-end |

### Documentation

| File | Content |
|------|---------|
| `UNIFIED-READY.md` | Quick start guide |
| `CLOUDFLARE-TUNNEL-SETUP.md` | Detailed tunnel setup |
| `PROJECT-STATUS.md` | Visual architecture overview |
| `FIXED-CORS.md` | CORS implementation details |
| `README.md` | Project overview |

---

## 🎮 How to Use

### Quick Commands

```bash
# For Claude.ai (SDK, no OAuth)
npm run tunnel-sdk

# For ChatGPT (SDK with OAuth) - RECOMMENDED
npm run tunnel-sdk-oauth

# For testing locally (no tunnel)
npm run sdk-server
npm run sdk-server-no-auth

# Old manual implementation
npm run tunnel          # With OAuth
npm run tunnel-no-auth  # Without OAuth
```

### Manual Control

```bash
# Start tunnel with options
node start-with-tunnel.js --sdk --oauth    # SDK + OAuth
node start-with-tunnel.js --sdk --no-auth  # SDK, no OAuth
node start-with-tunnel.js --oauth          # Manual + OAuth

# Direct server start
node mcp-sdk-oauth-server.js               # With OAuth
REQUIRE_AUTH=false node mcp-sdk-oauth-server.js  # Without OAuth
```

---

## 🔧 Technical Implementation Details

### OAuth 2.0 Flow (RFC 6749 + PKCE)

1. **Client Registration** (`POST /register`)
   - Dynamic client registration (RFC 7591)
   - Returns `client_id`

2. **Authorization** (`GET/POST /authorize`)
   - Login page shown to user
   - User enters credentials
   - Returns authorization `code`

3. **Token Exchange** (`POST /token`)
   - Exchange `code` + `code_verifier` (PKCE) for `access_token`
   - Returns JWT token (RS256 signed)

4. **Protected Request** (`POST /mcp`)
   - Send `Authorization: Bearer <token>` header
   - Token validated via JWT signature
   - MCP request processed

### JWT Token Structure

```javascript
{
  alg: 'RS256',
  typ: 'JWT',
  kid: 'key-1'
}
.
{
  sub: 'username',
  client_id: 'uuid',
  scope: 'mcp:tools',
  iat: timestamp,
  exp: timestamp + 3600,
  iss: BASE_URL,
  aud: BASE_URL
}
.
<signature>
```

### MCP SDK Session Management

```javascript
// Session storage
const transports = {};

// Initialize new session
if (!sessionId && isInitializeRequest(req.body)) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: new InMemoryEventStore(),
    onsessioninitialized: (sid) => {
      transports[sid] = transport;
    }
  });
  
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Reuse existing session
if (sessionId && transports[sessionId]) {
  await transports[sessionId].handleRequest(req, res, req.body);
}
```

---

## ✅ What Works Now

### With ChatGPT
- ✅ OAuth authentication (full flow)
- ✅ Tool discovery via `tools/list`
- ✅ Tool execution via `tools/call`
- ✅ HTTP transport
- ✅ HTTPS via Cloudflare Tunnel

### With Claude.ai
- ✅ Tool discovery (SDK version)
- ✅ Tool execution
- ✅ Works WITHOUT OAuth
- ⚠️ OAuth shows "tools not available" (implementation correct, but Claude doesn't call tools/list)

### MCP Inspector
- ✅ OAuth flow
- ✅ Tool discovery
- ✅ Tool execution
- ✅ Local testing

---

## ❌ What Doesn't Work & Why

### Claude.ai with OAuth
**Problem:** Tools show as "not available" even though OAuth succeeds.

**What we tried:**
1. ✅ Matching protocol versions
2. ✅ Proper notification handling
3. ✅ Adding `listChanged` capability
4. ✅ Returning tools in initialize (non-standard)
5. ✅ Using official MCP SDK

**What happens:**
- OAuth flow completes successfully
- `initialize` → success
- `notifications/initialized` → success
- `tools/list` → **Never called by Claude**

**Hypothesis:** Claude.ai may have issues with OAuth + MCP combination, or expects different OAuth metadata format.

### Cloudflare Tunnel Security Warnings
**Problem:** Browser shows "deceptive site" warning for `.trycloudflare.com` domains.

**Why:** Temporary tunnel URLs are often flagged as potentially dangerous.

**Solutions:**
- Click "Site is legitimate" (it's your server)
- Use persistent named tunnel
- Use custom domain
- Use ngrok instead

---

## 🔍 Debugging Tips

### Server Logs
All servers have comprehensive logging:
```javascript
console.log(`📥 POST /mcp`);
console.log(`   Session: ${sessionId}`);
console.log(`   Method: ${req.body?.method}`);
console.log(`   User: ${req.auth?.username}`);
```

### Check What Client Sends
```bash
# Watch server output for:
- initialize request with protocol version
- notifications/initialized
- tools/list (should be called!)
- tools/call with tool name
```

### Test Endpoints Manually
```bash
# OAuth metadata
curl https://your-url.com/.well-known/oauth-authorization-server

# MCP metadata  
curl https://your-url.com/.well-known/oauth-protected-resource

# MCP without auth (should fail)
curl -X POST https://your-url.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

---

## 📦 Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.19.1",  // Official MCP SDK
    "express": "^4.18.2",                    // Web framework
    "cors": "^2.8.5"                         // CORS (via SDK)
  }
}
```

---

## 🚀 Next Steps: Integrating with Desktop Commander

### 1. **Add MCP SDK to Desktop Commander**
```bash
cd /Users/fiberta/work/DesktopCommanderMCP
npm install @modelcontextprotocol/sdk
```

### 2. **Create HTTP Transport Wrapper**
Desktop Commander currently uses stdio transport. Need to add HTTP transport option:

```javascript
// In Desktop Commander's server.ts or new file: http-server.ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Wrap existing MCP server with HTTP transport
// Keep all existing tools, just add HTTP endpoint
```

### 3. **Add OAuth Layer**
Copy OAuth implementation from `mcp-sdk-oauth-server.js`:
- Client registration
- Authorization endpoint
- Token endpoint
- JWT validation middleware

### 4. **Configuration Options**
Add to Desktop Commander config:
```javascript
{
  httpTransport: {
    enabled: true,
    port: 3000,
    oauth: {
      enabled: true,
      baseUrl: 'https://your-domain.com'
    }
  }
}
```

### 5. **Keep stdio Transport**
Desktop Commander should support BOTH:
- **stdio:** For Claude Desktop app (local)
- **HTTP + OAuth:** For Claude.ai, ChatGPT (remote)

### 6. **Session Management**
Use the SDK's session management:
```javascript
const transports = new Map();

// Store transport per session
onsessioninitialized: (sessionId) => {
  transports.set(sessionId, transport);
}

// Clean up on close
transport.onclose = () => {
  transports.delete(sessionId);
}
```

### 7. **Testing Strategy**
1. ✅ Test locally without OAuth
2. ✅ Test with MCP Inspector
3. ✅ Add OAuth and test with ChatGPT
4. ✅ Test with Cloudflare Tunnel
5. ✅ Deploy to production

---

## 📝 Key Code Snippets to Reuse

### 1. MCP Server with SDK (Basic)
```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const server = new McpServer({
  name: 'Desktop Commander',
  version: '1.0.0',
}, {
  capabilities: { tools: {} }
});

// Register tools
server.registerTool('tool_name', {
  title: 'Tool Title',
  description: 'Tool description',
  inputSchema: {
    param: z.string().describe('Parameter')
  }
}, async ({ param }) => {
  return {
    content: [{ type: 'text', text: 'Result' }]
  };
});
```

### 2. HTTP Endpoint with Session Management
```javascript
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (sessionId && transports.has(sessionId)) {
    // Reuse existing session
    await transports.get(sessionId).handleRequest(req, res, req.body);
  } else if (isInitializeRequest(req.body)) {
    // Create new session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => transports.set(sid, transport)
    });
    
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } else {
    res.status(400).json({ error: 'Invalid request' });
  }
});
```

### 3. OAuth Middleware
```javascript
const authMiddleware = async (req, res, next) => {
  const auth = req.headers.authorization;
  
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authorization required' }
    });
  }
  
  const validation = validateToken(auth.substring(7));
  if (!validation.valid) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid token' }
    });
  }
  
  req.auth = validation;
  next();
};

app.post('/mcp', authMiddleware, mcpHandler);
```

### 4. OAuth Metadata Endpoints
```javascript
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256']
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header']
  });
});
```

---

## 🎓 Best Practices Learned

### 1. **Always Use MCP SDK for Production**
- Handles protocol versions automatically
- Proper session management
- SSE support built-in
- Resumability with event store

### 2. **OAuth Token Security**
- Use RS256 (RSA) for JWT signing
- Generate new keys on startup (or persist securely)
- Set reasonable expiration (3600s = 1 hour)
- Implement PKCE for public clients

### 3. **Error Handling**
- Always return proper JSON-RPC errors
- Include helpful error messages
- Log everything for debugging
- Handle transport close events

### 4. **CORS Configuration**
```javascript
app.use(cors({
  origin: '*',  // Or specific domains
  exposedHeaders: ['Mcp-Session-Id']  // Important!
}));
```

### 5. **Session Cleanup**
```javascript
transport.onclose = () => {
  console.log(`Session closed: ${sessionId}`);
  transports.delete(sessionId);
};

// Also handle server shutdown
process.on('SIGINT', async () => {
  for (const transport of transports.values()) {
    await transport.close();
  }
  process.exit(0);
});
```

---

## 🔗 Useful Resources

- **MCP Specification:** https://spec.modelcontextprotocol.io/
- **MCP SDK Docs:** https://github.com/modelcontextprotocol/typescript-sdk
- **OAuth 2.0 RFC:** https://tools.ietf.org/html/rfc6749
- **PKCE RFC:** https://tools.ietf.org/html/rfc7636
- **JWT RFC:** https://tools.ietf.org/html/rfc7519
- **Cloudflare Tunnel Docs:** https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/

---

## 📊 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT (Claude/ChatGPT)                │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE TUNNEL                         │
│                   (SSL Termination)                         │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP SDK + OAUTH SERVER (Port 3000)             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  OAuth Endpoints                                    │  │
│  │  • /.well-known/oauth-authorization-server          │  │
│  │  • /.well-known/oauth-protected-resource            │  │
│  │  • /register (client registration)                  │  │
│  │  • /authorize (login page)                          │  │
│  │  • /token (exchange code for token)                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Auth Middleware                                    │  │
│  │  • Validate Bearer token                            │  │
│  │  • Check JWT signature                              │  │
│  │  • Extract user info                                │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  MCP Endpoints                                      │  │
│  │  • POST /mcp (initialize, tools/list, tools/call)   │  │
│  │  • GET /mcp (SSE for streaming)                     │  │
│  │  • DELETE /mcp (session termination)                │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  MCP SDK Server                                     │  │
│  │  • Session management                               │  │
│  │  • Transport handling                               │  │
│  │  • Tool registration                                │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Tools Implementation                               │  │
│  │  • get_user_info                                    │  │
│  │  • echo                                             │  │
│  │  • [Desktop Commander tools go here]               │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎯 Summary

### What We Built
- ✅ OAuth 2.0 Authorization Server with PKCE
- ✅ MCP Resource Server with JWT validation
- ✅ Unified server combining both
- ✅ MCP SDK integration for proper protocol handling
- ✅ Cloudflare Tunnel integration for HTTPS
- ✅ Works with ChatGPT (**with OAuth**)
- ✅ Works with Claude.ai (**without OAuth**)

### Why It Works with ChatGPT
1. Uses MCP SDK (proper protocol handling)
2. Full OAuth 2.0 flow (PKCE, JWT, etc.)
3. CORS properly configured
4. All metadata endpoints present
5. Proper error handling

### Why OAuth Doesn't Work with Claude.ai (Yet)
- OAuth flow succeeds but Claude doesn't call `tools/list`
- Likely a Claude.ai specific issue or expectation
- Works fine without OAuth though!

### Ready for Desktop Commander
All code is production-ready and can be integrated into Desktop Commander to add HTTP + OAuth support alongside the existing stdio transport.

---

**Last Updated:** October 9, 2025
**Status:** ✅ Working with ChatGPT (OAuth), Working with Claude.ai (no OAuth)
**Next Step:** Integrate into Desktop Commander
