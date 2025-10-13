# 🌐 Cloudflare Tunnel Setup for Unified MCP OAuth Server

## ✅ What You Already Have

- **unified-mcp-server.js** - Single server handling both OAuth and MCP
- Runs on port 3000 by default
- CORS enabled for web clients
- Ready for HTTPS deployment

## 🎯 Goal

Expose the unified server via Cloudflare Tunnel to get HTTPS for testing with Claude.ai and ChatGPT.

---

## 📋 Prerequisites

1. **Cloudflare account** (free tier works)
2. **Domain** (or use Cloudflare's free subdomain)
3. **cloudflared CLI** installed

---

## 🚀 Quick Setup (3 Steps)

### Step 1: Install cloudflared

**macOS:**
```bash
brew install cloudflare/cloudflare/cloudflared
```

**Or download directly:**
```bash
curl -L --output cloudflared.pkg https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.pkg
sudo installer -pkg cloudflared.pkg -target /
```

### Step 2: Authenticate
```bash
cloudflared tunnel login
```
This opens a browser - select your domain/zone.

### Step 3: Create and Run Tunnel

**Quick start (temporary tunnel):**
```bash
# Start your server first
cd /Users/fiberta/work/DesktopCommanderMCP/oauth-test
node unified-mcp-server.js

# In another terminal, start tunnel
cloudflared tunnel --url http://localhost:3000
```

This gives you a temporary HTTPS URL like: `https://random-name.trycloudflare.com`

---

## 🎯 Production Setup (Persistent Tunnel)

### 1. Create Named Tunnel
```bash
cloudflared tunnel create desktop-commander-oauth
```

Note the **Tunnel ID** from output.

### 2. Create config file

Create `~/.cloudflared/config.yml`:
```yaml
tunnel: <YOUR-TUNNEL-ID>
credentials-file: /Users/fiberta/.cloudflared/<YOUR-TUNNEL-ID>.json

ingress:
  - hostname: mcp-oauth.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

### 3. Configure DNS
```bash
cloudflared tunnel route dns desktop-commander-oauth mcp-oauth.yourdomain.com
```

### 4. Run Tunnel
```bash
cloudflared tunnel run desktop-commander-oauth
```

---

## 🔧 Update Server for Production

When using Cloudflare Tunnel, update `BASE_URL`:

```bash
# Set environment variable
export BASE_URL=https://mcp-oauth.yourdomain.com

# Start server
node unified-mcp-server.js
```

Or modify the server directly:
```javascript
const BASE_URL = process.env.BASE_URL || 'https://mcp-oauth.yourdomain.com';
```

---

## ✅ Testing the Setup

### 1. Start Server
```bash
cd /Users/fiberta/work/DesktopCommanderMCP/oauth-test
BASE_URL=https://your-tunnel-url.com node unified-mcp-server.js
```

### 2. Start Tunnel
```bash
# Quick tunnel:
cloudflared tunnel --url http://localhost:3000

# Or persistent:
cloudflared tunnel run desktop-commander-oauth
```

### 3. Test Endpoints

```bash
# Test OAuth metadata
curl https://your-tunnel-url.com/.well-known/oauth-authorization-server

# Test MCP metadata  
curl https://your-tunnel-url.com/.well-known/oauth-protected-resource

# Test unauthenticated MCP call (should get 401)
curl -X POST https://your-tunnel-url.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

All should return JSON (no CORS errors).

---

## 📱 Testing with Claude.ai

1. Go to Claude.ai → Settings → MCP Servers
2. Add server:
   - **Transport:** Streamable HTTP
   - **URL:** `https://your-tunnel-url.com/mcp`
3. Connect → Should redirect to login page
4. Login: `admin` / `password123`
5. ✅ Should see tools available!

---

## 📱 Testing with ChatGPT

1. Go to ChatGPT → Settings → Third-party Actions
2. Add action:
   - **Endpoint:** `https://your-tunnel-url.com/mcp`
   - **Auth:** OAuth 2.0
   - **Authorization URL:** `https://your-tunnel-url.com/authorize`
   - **Token URL:** `https://your-tunnel-url.com/token`
3. Authorize → Login
4. ✅ Should work!

---

## 🎛️ Running Both (Automated)

Create `start-tunnel.sh`:
```bash
#!/bin/bash

# Start server in background
BASE_URL=https://your-tunnel-url.com node unified-mcp-server.js &
SERVER_PID=$!

# Wait for server to start
sleep 2

# Start tunnel
cloudflared tunnel --url http://localhost:3000

# Cleanup on exit
trap "kill $SERVER_PID" EXIT
```

Make executable:
```bash
chmod +x start-tunnel.sh
./start-tunnel.sh
```

---

## 🐛 Troubleshooting

### "Connection refused"
- Make sure server is running on port 3000
- Check `lsof -i :3000`

### "SSL certificate error"
- Cloudflare handles SSL automatically
- Your local server stays HTTP

### "CORS errors"
- Already handled in unified-mcp-server.js
- Cloudflare preserves CORS headers

### "Tunnel not connecting"
- Check cloudflared is running: `ps aux | grep cloudflared`
- Check logs: `cloudflared tunnel info <tunnel-name>`

---

## 📊 What's Next

Once tunnel is working:

1. ✅ Test with MCP Inspector (already works locally)
2. ✅ Test with Claude.ai via HTTPS tunnel
3. ✅ Test with ChatGPT via HTTPS tunnel
4. Integrate real Desktop Commander tools
5. Deploy to production

---

## 🎯 Quick Commands Reference

```bash
# Quick temporary tunnel (easiest way to start)
cloudflared tunnel --url http://localhost:3000

# Install
brew install cloudflare/cloudflare/cloudflared

# Login
cloudflared tunnel login

# Create named tunnel
cloudflared tunnel create my-tunnel

# Run named tunnel
cloudflared tunnel run my-tunnel

# List tunnels
cloudflared tunnel list

# Delete tunnel
cloudflared tunnel delete my-tunnel
```

---

## 💡 Pro Tips

1. **Use quick tunnel first** - easiest way to test
2. **BASE_URL must match tunnel URL** - very important!
3. **Server runs on HTTP locally** - Cloudflare adds HTTPS
4. **Free tier has rate limits** - but plenty for testing
5. **Tunnel URL changes** with quick tunnels - use persistent for production

---

## 🎉 Success Looks Like

✅ Server starts on port 3000  
✅ Tunnel connects and shows HTTPS URL  
✅ Metadata endpoints return JSON  
✅ Login page loads in browser  
✅ Claude.ai/ChatGPT can connect  
✅ OAuth flow completes  
✅ Tools are accessible  

Ready to go! 🚀
