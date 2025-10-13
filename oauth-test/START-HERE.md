# 🎯 QUICK START: Test with MCP Inspector

## What You Have

✅ **Working simple OAuth** - Tested with `./test-flow.sh`
🚧 **MCP-compliant OAuth** - Ready to test

## Next Step (5 minutes)

### 1. Start Servers

**Terminal 1:**
```bash
cd /Users/fiberta/work/DesktopCommanderMCP/oauth-test
npm run mcp-auth
```

**Terminal 2:**
```bash
npm run mcp-resource
```

Wait for both to show "Ready" messages.

### 2. Start MCP Inspector

**Terminal 3:**
```bash
npx @modelcontextprotocol/inspector
```

This will:
- Download Inspector (first time only)
- Open browser to http://localhost:6274

### 3. Connect

In the Inspector UI:

1. **Transport Type**: Select "Streamable HTTP"
2. **Server URL**: `http://localhost:3002/mcp`
3. Click **"Connect"**

### 4. Login

Browser will open to login page:
- **Username**: `admin`
- **Password**: `password123`
- Click **"Login & Authorize"**

### 5. Test Tools

Back in Inspector, you should see:
- Connection status: ✅ Connected
- Tools list:
  - `get_user_info`
  - `echo`

Try calling them:
- Click "get_user_info" → Execute
- Click "echo" → Enter message → Execute

## Expected Result

```json
// get_user_info response:
{
  "username": "admin",
  "client_id": "...",
  "scope": "mcp:tools",
  "message": "You are successfully authenticated with OAuth!"
}

// echo response:
"Echo from admin: Your message here"
```

## If It Works ✅

Congratulations! You have a **working MCP OAuth server** that:
- Implements OAuth 2.1
- Uses JWT tokens
- Supports PKCE
- Has dynamic client registration
- Works with real MCP clients

**Next:** Deploy with Cloudflare Tunnel to test with Claude.ai

## If It Doesn't Work ❌

### Check servers are running:
```bash
# Should see both running
lsof -i:3001 -i:3002
```

### Test metadata endpoints:
```bash
curl http://localhost:3001/.well-known/oauth-authorization-server | jq
curl http://localhost:3002/.well-known/oauth-protected-resource | jq
```

### Check logs:
```bash
# In Terminal 1 & 2, look for error messages
```

### Restart everything:
```bash
# Kill ports
lsof -ti:3001 -ti:3002 | xargs kill -9

# Start fresh
npm run mcp-auth        # Terminal 1
npm run mcp-resource    # Terminal 2
npx @modelcontextprotocol/inspector  # Terminal 3
```

## Files Overview

```
oauth-test/
├── mcp-auth-server.js       ← OAuth 2.1 + JWT server
├── mcp-resource-server.js   ← MCP tools server  
├── test-mcp-compliance.sh   ← Automated test (has timing issues)
├── TESTING-WITH-CLIENTS.md  ← Full documentation
└── README.md                ← Original simple version docs
```

## Key Difference from Simple Version

| Feature | Simple | MCP-Compliant |
|---------|--------|---------------|
| Tokens | Random strings | JWT (RS256) |
| Works with | Browser client | MCP Inspector, Claude |
| Registration | Hardcoded | Dynamic (RFC 7591) |
| PKCE | No | Yes |
| MCP Protocol | No | Yes |

## After Inspector Works

See `TESTING-WITH-CLIENTS.md` for:
- Deploying with Cloudflare Tunnel
- Testing with Claude.ai
- Integrating into Desktop Commander

## Quick Commands Reference

```bash
# Start OAuth server
npm run mcp-auth

# Start MCP server
npm run mcp-resource

# Start Inspector
npx @modelcontextprotocol/inspector

# Test simple version (already working)
./test-flow.sh

# Kill all servers
lsof -ti:3000 -ti:3001 -ti:3002 | xargs kill -9
```

## Login Credentials

- Username: `admin`
- Password: `password123`

(Change in `mcp-auth-server.js` line 15 if needed)

## Success!

If you see tools in Inspector and can call them successfully:

🎉 **You have a working MCP OAuth server!**

This is exactly what Claude.ai and other MCP clients expect.

The next step is deploying it to a public URL so Claude.ai can connect to it.
