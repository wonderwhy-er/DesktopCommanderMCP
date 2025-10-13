# ⚡ FIXED: Testing with MCP Inspector

## The Problem
- CORS errors → Fixed by adding CORS headers
- 404 on metadata → Fixed endpoint paths

## Quick Start (3 steps)

### Step 1: Start Servers

**Terminal 1:**
```bash
cd /Users/fiberta/work/DesktopCommanderMCP/oauth-test
npm run mcp-auth
```

**Terminal 2:**
```bash
npm run mcp-resource
```

### Step 2: Test Metadata (verify CORS works)

```bash
# Should return JSON without errors
curl http://localhost:3002/.well-known/oauth-protected-resource
curl http://localhost:3001/.well-known/oauth-authorization-server
```

### Step 3: Connect with MCP Inspector

**Terminal 3:**
```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI:
1. Transport: **Streamable HTTP**
2. URL: **`http://localhost:3002/mcp`**
3. Click **Connect**
4. Browser opens → Login: **admin / password123**
5. ✅ Should work now!

## What Was Fixed

### CORS Headers Added
```javascript
res.header('Access-Control-Allow-Origin', '*');
res.header('Access-Control-Allow-Methods', '*');
res.header('Access-Control-Allow-Headers', '*');
```

### Simplified Code
- Removed complex error handling
- Streamlined MCP responses
- Cleaner token validation

## If Still Getting Errors

### Kill old processes:
```bash
lsof -ti:3001 -ti:3002 | xargs kill -9
```

### Restart servers:
```bash
# Terminal 1
npm run mcp-auth

# Terminal 2  
npm run mcp-resource
```

### Check endpoints work:
```bash
# Test 1: Metadata (should return JSON)
curl http://localhost:3002/.well-known/oauth-protected-resource

# Test 2: Auth without token (should return 401)
curl -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Success Looks Like

In Inspector, you should see:
- ✅ Connected status
- ✅ 1 tool: `echo`
- ✅ Can call echo with a message
- ✅ Returns: `admin: your message`

## Next Steps After It Works

1. ✅ Verify with Inspector
2. Deploy with Cloudflare Tunnel
3. Test with Claude.ai
4. Integrate into Desktop Commander

## Credentials

- Username: `admin`
- Password: `password123`
