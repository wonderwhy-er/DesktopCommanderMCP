# Simple OAuth MCP Server for Claude Desktop

A simplified MCP server that demonstrates OAuth concepts and can be easily integrated into Claude Desktop via the standard `mcp_config.json` configuration.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the OAuth Authorization Server (Optional)

To see real OAuth server status:

```bash
npm start
# OAuth server will run on http://localhost:4449
```

### 3. Configure Claude Desktop

Add this to your `~/Library/Application Support/Claude/mcp_config.json`:

```json
{
  "mcpServers": {
    "simple-oauth-demo": {
      "command": "node",
      "args": [
        "/absolute/path/to/simple-mcp-server.js"
      ],
      "env": {
        "OAUTH_BASE_URL": "http://localhost:4449",
        "DEMO_MODE": "true",
        "PKCE_REQUIRED": "true",
        "DEFAULT_CLIENT_ID": "mcp-client",
        "DEFAULT_SCOPES": "openid email profile mcp:tools"
      }
    }
  }
}
```

**Replace `/absolute/path/to/` with your actual path!**

### 4. Test the Server

You can test the server standalone:

```bash
npm run simple
# Server will start in stdio mode, ready for MCP communication
```

## 🛠️ Available Tools

The server provides 4 tools for OAuth education and testing:

### 1. `oauth_status`
- **Description**: Check OAuth server status and configuration
- **Parameters**: None
- **Returns**: OAuth server health, endpoints, and configuration info

### 2. `test_tool` 
- **Description**: Test tool that simulates OAuth-protected functionality
- **Parameters**: 
  - `message` (string, required): Test message to process
- **Returns**: Processed message with OAuth context information

### 3. `server_info`
- **Description**: Get server information and capabilities  
- **Parameters**: None
- **Returns**: Server stats, memory usage, and runtime information

### 4. `oauth_demo`
- **Description**: Demonstrate OAuth flow information
- **Parameters**:
  - `action` (string, required): One of `status`, `config`, or `flow`
- **Returns**: OAuth documentation and flow explanations

## 📋 Environment Variables

- `OAUTH_BASE_URL`: OAuth authorization server URL (default: http://localhost:4449)
- `DEMO_MODE`: Enable demo mode features (default: false)  
- `PKCE_REQUIRED`: Require PKCE for OAuth flows (default: true)
- `DEFAULT_CLIENT_ID`: Default OAuth client ID (default: mcp-client)
- `DEFAULT_SCOPES`: Default OAuth scopes (default: openid email profile mcp:tools)

## 🔧 Architecture

```
Claude Desktop
    ↓ (stdio transport)
simple-mcp-server.js
    ↓ (HTTP requests)
OAuth Server (optional)
    ↓ (OAuth 2.1 + PKCE)
Authentication & Authorization
```

## 🔄 Comparison with HTTP Servers

| Feature | Simple Server | HTTP/SSE Server |
|---------|---------------|-----------------|
| Transport | stdio | HTTP + SSE |
| Claude Desktop | Native support | Requires connector setup |
| OAuth | Educational/Demo | Full implementation |
| Configuration | mcp_config.json | Environment + URLs |
| Complexity | Low | High |

## 🎯 Use Cases

1. **Learning OAuth**: Understand OAuth 2.1 + PKCE concepts
2. **MCP Development**: Test MCP tooling without complex setup
3. **Claude Desktop Integration**: Native stdio transport
4. **Prototyping**: Quick OAuth-aware tool development

## 🔒 Security Notes

- This is a **demo/educational** server
- For production OAuth, use the full `oauth-server` implementation
- Always validate tokens in production environments
- Use HTTPS in production deployments

## 📚 Related Files

- `simple-mcp-server.js`: Main stdio server
- `claude_config_example.json`: Example Claude Desktop configuration
- `oauth-server/`: Full OAuth 2.1 server implementation
- `mcp-server-oauth/`: HTTP-based MCP server with OAuth

## 🆘 Troubleshooting

### Server won't start
- Check Node.js version (requires >=18.0.0)
- Run `npm install` to install dependencies
- Verify file permissions: `chmod +x simple-mcp-server.js`

### Claude Desktop not seeing tools
- Check absolute path in `mcp_config.json`
- Restart Claude Desktop after configuration changes
- Check Claude Desktop logs for errors

### OAuth server connection issues
- Verify OAuth server is running on port 4449
- Check `OAUTH_BASE_URL` environment variable
- Server works without OAuth server (shows offline status)

## 🔗 Getting Started

1. Copy the example configuration to Claude Desktop
2. Update the absolute path to your server file  
3. Restart Claude Desktop
4. Try the tools in a conversation!

Example: "Use the oauth_status tool to check the OAuth server configuration."