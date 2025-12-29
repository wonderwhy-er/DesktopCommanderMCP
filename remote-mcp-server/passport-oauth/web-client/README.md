# MCP Web Client - Direct SSE Connection

A modern web-based client for connecting directly to remote MCP (Model Context Protocol) servers via Server-Sent Events (SSE) with OAuth 2.1 authentication.

## Features

- 🔗 **Direct SSE Connection**: Connects directly to remote MCP servers via `/sse` endpoint
- 🔐 **OAuth 2.1 + PKCE**: Secure authentication with separate OAuth server
- 🌐 **Web-Based**: No installation required, runs in any modern browser
- 🛠️ **Tool Execution**: Interactive interface for calling MCP tools
- 📡 **Real-time Communication**: Live connection status and message logging
- 🎨 **Modern UI**: Clean, responsive interface with status indicators

## Architecture

```
┌─────────────────┐    OAuth Flow    ┌─────────────────┐
│   Web Client    │ ────────────────► │  OAuth Server   │
│ (localhost:8847)│                   │ (auth.app.com)  │
└─────────────────┘                   └─────────────────┘
         │                                       
         │ SSE Connection                        
         │ (with Bearer token)                   
         ▼                                       
┌─────────────────┐                             
│   MCP Server    │                             
│  (app.com/sse)  │                             
└─────────────────┘                             
```

## Quick Start

1. **Start all services**:
   ```bash
   npm run dev-full
   ```
   This starts:
   - OAuth server (localhost:4449)
   - MCP server (localhost:3006)
   - Web client server (localhost:8847)
   - Opens browser automatically

2. **Or manually**:
   ```bash
   # Terminal 1: OAuth Server
   npm run start
   
   # Terminal 2: MCP Server  
   npm run mcp
   
   # Terminal 3: Web Client Server
   npm run web
   ```

3. **Open browser**: http://localhost:8847

## Usage Flow

### 1. Configure Servers
- Set MCP Server URL (e.g., `https://app.com` or `http://localhost:3006`)
- Set OAuth Server URL (e.g., `https://auth.app.com` or `http://localhost:4449`)
- Click "Update Configuration"

### 2. Test Connectivity
- Click "Test Connectivity" to verify both servers are reachable
- Check the connection log for results

### 3. Authenticate
- Click "Authenticate" to start OAuth flow
- You'll be redirected to the OAuth server for login
- After successful authentication, you'll return to the web client

### 4. Connect via SSE
- Click "Connect" to establish SSE connection to MCP server
- Connection uses your OAuth Bearer token for authentication

### 5. Initialize MCP
- Click "Initialize" to set up the MCP protocol
- This performs the MCP handshake with the server

### 6. Use Tools
- Click "Get Tools" to load available tools from the MCP server
- Tools will appear as cards with descriptions
- Click "Execute" on any tool to run it
- View results in the response section

## Configuration

### Environment Variables

```bash
# Web client server
WEB_CLIENT_PORT=8847
WEB_CLIENT_HOST=localhost

# OAuth server (if running locally)
OAUTH_PORT=4449
OAUTH_HOST=localhost
OAUTH_BASE_URL=http://localhost:4449

# MCP server (if running locally)
MCP_PORT=3006
MCP_HOST=localhost
MCP_BASE_URL=http://localhost:3006

# Demo mode (auto-login)
DEMO_MODE=true
DEMO_USER_EMAIL=test@example.com
DEMO_USER_PASSWORD=password123
```

### Production Setup

For production deployment with separate domains:

1. **Update URLs in the web interface**:
   - MCP Server URL: `https://app.com`
   - OAuth Server URL: `https://auth.app.com`

2. **Configure CORS** on both servers to allow your web client domain

3. **HTTPS Required**: Both servers should use HTTPS in production

## Features Detail

### OAuth 2.1 + PKCE Flow
- Dynamic client registration
- PKCE (Proof Key for Code Exchange) for security
- Automatic token refresh (when supported)
- Secure token storage in localStorage

### SSE Connection Management
- Automatic reconnection on failure
- Bearer token authentication
- Real-time status indicators
- Connection heartbeat monitoring

### MCP Protocol Support
- Full MCP 2024-11-05 specification
- Tool discovery and execution
- JSON-RPC 2.0 message format
- Error handling and logging

### User Interface
- Modern, responsive design
- Real-time status indicators
- Connection logging
- Tool execution results
- Configuration management

## Security Considerations

- **HTTPS Only**: Use HTTPS in production
- **Token Storage**: Tokens stored in localStorage (consider secure alternatives for production)
- **CORS**: Configure CORS properly on servers
- **PKCE**: Uses PKCE for additional OAuth security
- **CSP**: Consider Content Security Policy headers

## Troubleshooting

### Common Issues

1. **CORS Errors**:
   - Ensure MCP and OAuth servers allow your web client domain
   - Check server CORS configuration

2. **Authentication Failures**:
   - Verify OAuth server is running and accessible
   - Check redirect URI configuration matches exactly

3. **SSE Connection Errors**:
   - Ensure Bearer token is valid and not expired
   - Check MCP server OAuth middleware configuration

4. **Tool Execution Failures**:
   - Verify MCP protocol is properly initialized
   - Check tool permissions and OAuth scopes

### Debug Mode

Open browser developer tools to see:
- Detailed console logging
- Network requests
- SSE message events
- Authentication flow details

## Example Servers

This client works with any MCP-compliant server that supports:
- SSE transport on `/sse` endpoint
- OAuth 2.1 Bearer token authentication
- MCP 2024-11-05 specification

The included passport-oauth implementation provides reference servers for testing.