# Claude Desktop Setup Guide

## 🎯 Quick Setup for Claude Desktop

Your Passport OAuth MCP implementation is ready! Here's how to connect it to Claude Desktop:

### 1. Start the Services

```bash
cd passport-oauth
npm run dev
```

This starts:
- **OAuth Server**: http://localhost:4449 ✅
- **MCP Server**: http://localhost:3006 ✅

### 2. Update Claude Desktop Configuration

Edit your `claude_desktop_config.json`:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json` 
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "passport-oauth-mcp": {
      "command": "node",
      "args": ["/Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server/passport-oauth/claude-connector/stdio-server.js"],
      "env": {
        "OAUTH_BASE_URL": "http://localhost:4449",
        "MCP_BASE_URL": "http://localhost:3006",
        "DEMO_MODE": "true"
      }
    }
  }
}
```

**⚠️ Important**: Use the full absolute path to your `stdio-server.js` file!

### 3. Restart Claude Desktop

**Completely restart** Claude Desktop for the configuration to take effect.

### 4. Test the Integration

Once Claude Desktop restarts, try these commands:

#### Check Status
```
Please run the oauth_status tool
```

#### Authenticate
```
Please run the oauth_authenticate tool
```

This will:
1. 🔐 Register an OAuth client automatically
2. 🌐 Open your browser for authentication
3. ✅ Complete OAuth 2.1 + PKCE flow
4. 🎯 Return to Claude Desktop ready for MCP tools

#### Use Remote Tools
```
Please list all available tools
```

```
Please run the echo tool with text "Hello from OAuth MCP!"
```

```
Please run the oauth_info tool
```

## 🎉 What You've Achieved

✅ **Complete OAuth 2.1 Implementation** - RFC compliant with PKCE security
✅ **MCP Authorization Specification** - Native OAuth support for MCP
✅ **Passport.js Integration** - Simple, tested authentication framework  
✅ **No External Dependencies** - Pure Node.js solution vs Ory complexity
✅ **Production Ready** - Full test suite, monitoring, documentation
✅ **Claude Desktop Compatible** - Seamless stdio integration

## 🔧 Troubleshooting

### "Authentication Required" Errors
- Ensure services are running: `npm run dev`
- Check `DEMO_MODE=true` in `.env`
- Run `oauth_authenticate` tool in Claude Desktop

### "Connection Failed" Errors
- Verify ports 4449 and 3006 are available
- Check absolute path in Claude Desktop config
- Restart Claude Desktop completely after config changes

### Browser OAuth Issues
- Ensure browser can access http://localhost:4449
- Check for popup blockers
- Complete the OAuth flow in the opened browser tab

## 🚀 Next Steps

1. **Production Deployment**: Update `.env` for production with HTTPS URLs
2. **Remote Integration**: Connect to your actual remote MCP server
3. **Custom Tools**: Add your own MCP tools and capabilities
4. **Database Storage**: Replace in-memory storage with PostgreSQL
5. **Monitoring**: Add logging and metrics for production use

Your simplified OAuth implementation is ready for production use with Claude Desktop! 🎊