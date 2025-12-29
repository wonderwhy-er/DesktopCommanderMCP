# MCP Server with OAuth Authentication - Direct HTTP/SSE Connection

A production-ready MCP server that provides `/sse` endpoint with OAuth 2.1 authentication for **direct Claude Desktop connection**.

## 🎯 **Direct Connection Architecture**

```
Claude Desktop (Settings > Connectors)
     ↓ (Direct HTTPS/SSE)
MCP Server (localhost:3005/sse)
     ↓ (OAuth)
OAuth Server (localhost:4449)
```

## 🚀 **Quick Start - Localhost Setup**

### **1. Start the Servers**

**HTTP Only (Default):**
```bash
# Navigate to the passport-oauth directory
cd /Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server/passport-oauth

# Start OAuth server + MCP server together
npm run dev-oauth
```

**With HTTPS Support (Required for Claude Desktop):**
```bash
# Start with HTTPS enabled for MCP /sse endpoint
npm run dev-mcp-https
```

This will start:
- **OAuth Server** → `http://localhost:4449` (handles authentication)
- **MCP Server HTTPS** → `https://localhost:3006` (your HTTPS MCP endpoint)
- **MCP Server HTTP** → `http://localhost:3005` (HTTP fallback)

You should see output like:
```
🔐 OAuth 2.1 Authorization Server started
📡 Server: http://localhost:4449
🧪 Demo Mode: Enabled
🔒 PKCE Required: Yes
👤 Demo User: test@example.com

🚀 MCP Server with OAuth started
📡 Server: http://localhost:3005
🌊 SSE Endpoint: http://localhost:3005/sse
✅ MCP OAuth Server ready for Claude Desktop!
```

### **2. Configure Claude Desktop**

1. **Open Claude Desktop**
2. **Go to Settings** (⚙️ icon)
3. **Click "Connectors"** tab
4. **Click "Add Connector"** button
5. **Enter server details**:
   - **Name**: `Local MCP OAuth HTTPS`
   - **Server URL**: `https://localhost:3006/sse`
   - **Description**: `MCP server with OAuth authentication (HTTPS)`
6. **Click "Add"**

**Important**: Use `https://localhost:3006/sse` for Claude Desktop as it requires HTTPS for connector endpoints.

### **3. Test the Connection**

1. **Start a conversation** in Claude Desktop
2. **Claude will attempt to connect** to your MCP server
3. **OAuth flow will trigger** automatically:
   - Browser will open to `http://localhost:4449/authorize`
   - Login with demo credentials: `test@example.com` / `password123`
   - Authorization will complete automatically
4. **Tools will be available** in Claude Desktop

### **4. Available Tools**

After authentication, these tools will be available:

- **`oauth_status`** - Check authentication status and server info
- **`test_tool`** - Test tool that requires OAuth authentication  
- **`connection_stats`** - Get SSE connection statistics

## 🔍 **Troubleshooting & Debug Information**

### **Debug Endpoints**

The server provides comprehensive debug information for troubleshooting connection issues:

```bash
# Check server configuration and active connections
curl -k https://localhost:3006/debug

# Check server health
curl -k https://localhost:3006/health

# Check MCP metadata
curl -k https://localhost:3006/.well-known/mcp-server
```

### **Enhanced Logging**

The server provides detailed logging for all connection attempts:

**When Claude Desktop tries to connect, you'll see:**
```
[Server] 🌊 SSE endpoint accessed
[Server] 🔗 Client: [IP address]
[Server] 📱 User-Agent: [Claude Desktop user agent]
[Auth] 🔐 Authentication attempt for /sse from [IP]
[Auth] 🔍 Validating Bearer token: [token prefix]...
[Auth] ✅ Authentication successful for user: [user_id]
[SSE] 🔌 New connection attempt from [IP]
[SSE] ✅ Connection established: [connection_id]
```

**For authentication failures:**
```
[Auth] ❌ No Bearer token provided
[Auth] 🔄 Sending OAuth challenge: {...}
```

**For connection issues:**
```
[SSE] ❌ Connection error: [details]
[SSE] 🔌 Connection closed: [connection_id]
```

## 📡 **Server Endpoints**

### **MCP Server (port 3005):**
- **`GET /sse`** - SSE endpoint for Claude Desktop (requires Bearer token)
- **`POST /message`** - HTTP message endpoint (requires Bearer token)
- **`GET /.well-known/mcp-server`** - MCP metadata and capabilities
- **`GET /oauth/callback`** - OAuth callback handler
- **`GET /oauth/discovery`** - OAuth server configuration
- **`GET /health`** - Server health check

### **OAuth Server (port 4449):**
- **`GET /authorize`** - OAuth authorization endpoint
- **`POST /token`** - Token exchange endpoint
- **`POST /register`** - Dynamic client registration
- **`POST /introspect`** - Token introspection
- **`GET /health`** - OAuth server health

## 🔧 **Configuration**

### **Environment Variables (Optional)**

```bash
# MCP Server with OAuth
MCP_OAUTH_PORT=3005              # HTTP port
MCP_OAUTH_HTTPS_PORT=3006        # HTTPS port (for Claude Desktop)
MCP_OAUTH_HOST=localhost  
MCP_OAUTH_BASE_URL=http://localhost:3005   # Auto-detects HTTPS when enabled

# OAuth Server
OAUTH_BASE_URL=http://localhost:4449
OAUTH_PORT=4449
OAUTH_HOST=localhost

# HTTPS Support (required for Claude Desktop)
ENABLE_HTTPS=true

# Demo mode (enabled by default)
DEMO_MODE=true
DEMO_USER_EMAIL=test@example.com
DEMO_USER_PASSWORD=password123
```

### **HTTPS Support**

**Claude Desktop requires HTTPS for the MCP `/sse` endpoint.** The MCP server supports HTTPS:

```bash
# Enable HTTPS for MCP server
npm run dev-mcp-https
```

The server automatically uses certificates from `../certs/server.crt` and `../certs/server.key`. Both HTTP and HTTPS run simultaneously when enabled.

**URLs with HTTPS enabled:**
- MCP Server HTTPS: `https://localhost:3006/sse` ← **Use this for Claude Desktop**
- MCP Server HTTP: `http://localhost:3005/sse` (fallback)
- OAuth Server: `http://localhost:4449` (can remain HTTP)

### **Demo Mode**

Demo mode is enabled by default for easy testing:
- **Auto-login** with demo user credentials
- **Simplified OAuth flow** for development
- **Pre-configured client** registration

## 🧪 **Testing the Setup**

### **1. Verify Servers are Running**
```bash
# Check MCP server
curl http://localhost:3005/health
# Should return: {"status":"healthy","server":"mcp-server-oauth"...}

# Check OAuth server  
curl http://localhost:4449/health
# Should return: {"status":"healthy","server":"oauth-authorization-server"...}
```

### **2. Test MCP Metadata**
```bash
curl http://localhost:3005/.well-known/mcp-server
```

Should return MCP specification with OAuth configuration:
```json
{
  "version": "2024-11-05",
  "server": {"name": "mcp-server-oauth", "version": "1.0.0"},
  "transport": {
    "sse": {"endpoint": "/sse", "authentication_required": true}
  },
  "authentication": {
    "type": "oauth2",
    "authorization_server": "http://localhost:4449",
    "pkce_required": true
  }
}
```

### **3. Test OAuth Discovery**
```bash
curl http://localhost:3005/oauth/discovery
```

## 🔐 **OAuth Flow Details**

### **How Authentication Works:**

1. **Claude Desktop connects** to `http://localhost:3005/sse`
2. **No Bearer token** → Server returns 401 with OAuth challenge
3. **Claude Desktop triggers OAuth**:
   - Opens browser to `http://localhost:4449/authorize`
   - User sees login page (demo: `test@example.com` / `password123`)
   - OAuth server redirects back with authorization code
4. **Token exchange** → Claude Desktop gets access token
5. **Reconnection** → Claude Desktop reconnects with Bearer token
6. **Tools available** → All MCP tools now work

### **Browser OAuth Experience:**

1. Browser opens to OAuth server
2. Demo login page appears
3. Enter credentials: `test@example.com` / `password123`  
4. Automatic authorization and redirect
5. Browser shows success message
6. Claude Desktop connection completes

## 🛠️ **Troubleshooting**

### **Common Issues:**

**"Failed to connect to MCP server"**
- ✅ Check servers are running: `npm run dev-mcp-https` (for HTTPS) or `npm run dev-oauth` (HTTP only)
- ✅ Verify URL in Claude: `https://localhost:3006/sse` (HTTPS) or `http://localhost:3005/sse` (HTTP)
- ✅ Check firewall isn't blocking ports 3006 and 4449
- ✅ Check debug endpoint: `curl -k https://localhost:3006/debug`
- ✅ Look for connection attempts in server logs: `[Server] 🌊 SSE endpoint accessed`

**"OAuth authentication failed"**  
- ✅ Check OAuth server is running on port 4449
- ✅ Use demo credentials: `test@example.com` / `password123`
- ✅ Check browser console for errors
- ✅ Look for authentication logs: `[Auth] 🔐 Authentication attempt`
- ✅ Check token validation: `[Auth] 🔍 Validating Bearer token`

**"Browser doesn't open for OAuth"**
- ✅ Claude Desktop should handle browser opening automatically
- ✅ If needed, manually navigate to the OAuth URL shown in server logs
- ✅ Check the OAuth challenge response: `[Auth] 🔄 Sending OAuth challenge`

**"Tools not appearing"**
- ✅ Complete OAuth flow first
- ✅ Check server logs for authentication status: `[Auth] ✅ Authentication successful`
- ✅ Verify SSE connection is established: `[SSE] ✅ Connection established`
- ✅ Try removing and re-adding connector in Claude Desktop

**"Connection issues"**
- ✅ Monitor server logs for detailed connection information
- ✅ Check `/debug` endpoint for active connections and configuration
- ✅ Look for specific error messages: `[SSE] ❌ Connection error`
- ✅ Check connection duration: `[SSE] ⏰ Connection duration`

### **Enhanced Debug Logging:**

The server automatically provides comprehensive debug information:
```bash
# All requests are logged with full details
[Server] 🌊 SSE endpoint accessed
[Auth] 🔐 Authentication attempt for /sse from [IP]
[SSE] 🔌 New connection attempt from [IP]
[SSE] ✅ Connection established: [connection_id]
```

### **Reset OAuth State:**

If authentication gets stuck:
1. **Stop servers** (Ctrl+C)
2. **Restart servers** (`npm run dev-oauth`)  
3. **Remove and re-add connector** in Claude Desktop

## 🚀 **Production Deployment**

For production deployment to `app.com/sse` + `auth.app.com`:

### **1. Update Environment Variables:**
```bash
MCP_OAUTH_BASE_URL=https://app.com
OAUTH_BASE_URL=https://auth.app.com
DEMO_MODE=false
```

### **2. Configure HTTPS and CORS:**
- Set up SSL certificates
- Configure CORS for your domain
- Update OAuth redirect URLs

### **3. Add to Claude Desktop:**
- **Server URL**: `https://app.com/sse`
- **OAuth will redirect** to `https://auth.app.com`

## 📂 **File Structure**

```
mcp-server-oauth/
├── server.js           # Main MCP server with /sse + OAuth
├── oauth-provider.js   # OAuth adapter for passport-oauth server
└── README.md          # This documentation
```

## 🎯 **Key Features**

- ✅ **Direct SSE connection** - No stdio bridge needed
- ✅ **OAuth 2.1 + PKCE** - Production-ready security
- ✅ **Browser authentication** - Automatic OAuth flow
- ✅ **Token management** - Automatic refresh and validation
- ✅ **MCP compliance** - Follows MCP 2024-11-05 specification
- ✅ **Production ready** - HTTPS, CORS, error handling
- ✅ **Easy setup** - Works with Claude Desktop out of the box

**Your MCP server is ready for direct Claude Desktop connection!** 🚀