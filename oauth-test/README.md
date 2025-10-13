# 🚀 Unified MCP OAuth Server

A complete OAuth 2.0 + MCP (Model Context Protocol) server implementation in a single Express.js application. Perfect for testing Claude.ai, ChatGPT, and other MCP clients with OAuth authentication.

## ⚡ Quick Start

```bash
# Install dependencies (if needed)
npm install

# Start server with Cloudflare Tunnel (HTTPS)
npm run tunnel

# Or just the server (HTTP only)
npm run unified
```

## 🎯 What's This?

This is a **unified server** that combines:
- **OAuth Authorization Server** - User login and token issuance
- **OAuth Resource Server** - Token validation
- **MCP Server** - Model Context Protocol implementation

All running on **one port (3000)** with **one URL**.

## ✅ Features

- ✅ **OAuth 2.0** with PKCE support
- ✅ **JWT tokens** with RSA signatures
- ✅ **MCP 2024-11-05** protocol
- ✅ **CORS enabled** for web clients
- ✅ **Cloudflare Tunnel** ready for HTTPS
- ✅ **Dynamic client registration** (RFC 7591)
- ✅ **Auto-discovery** via metadata endpoints

## 📁 Key Files

| File | Purpose |
|------|---------|
| `unified-mcp-server.js` | ⭐ Main server (everything in one) |
| `start-with-tunnel.sh` | Helper script to start with tunnel |
| `package.json` | npm scripts |

## 🎮 Testing

### With MCP Inspector (Local)
```bash
npm run unified

# In another terminal
npx @modelcontextprotocol/inspector
```
Connect to: `http://localhost:3000/mcp`

### With Claude.ai or ChatGPT (HTTPS)
```bash
npm run tunnel
```
Copy the HTTPS URL and use it with:
- **Claude.ai:** Settings → MCP Servers → Add server
- **ChatGPT:** Settings → Third-party Actions → Add action

Login credentials: `admin` / `password123`

## 🔧 Configuration

Environment variables:
```bash
PORT=3000                              # Server port
BASE_URL=https://your-tunnel-url.com   # Public URL (for OAuth)
```

## 📖 Documentation

- **[UNIFIED-READY.md](UNIFIED-READY.md)** - Quick start guide
- **[CLOUDFLARE-TUNNEL-SETUP.md](CLOUDFLARE-TUNNEL-SETUP.md)** - Tunnel setup guide
- **[PROJECT-STATUS.md](PROJECT-STATUS.md)** - Visual overview
- **[FIXED-CORS.md](FIXED-CORS.md)** - CORS configuration details

## 🛠️ Available Tools

Demo tools for testing:
- `get_user_info` - Returns authenticated user info
- `echo` - Echoes back a message

## 📊 Architecture

```
┌─────────────┐
│   Client    │ (Claude.ai, ChatGPT, etc.)
└──────┬──────┘
       │ HTTPS
       ▼
┌─────────────┐
│  Cloudflare │
│   Tunnel    │
└──────┬──────┘
       │ HTTP
       ▼
┌─────────────────────────────────────┐
│     Unified Server (Port 3000)      │
│                                     │
│  • OAuth endpoints                  │
│  • Token validation                 │
│  • MCP implementation               │
└─────────────────────────────────────┘
```

## 🎯 Endpoints

### OAuth:
- `GET /.well-known/oauth-authorization-server` - OAuth metadata
- `GET /authorize` - Login page
- `POST /authorize` - Process login
- `POST /token` - Exchange code for token
- `POST /register` - Register client

### MCP:
- `GET /.well-known/oauth-protected-resource` - MCP metadata
- `POST /mcp` - MCP endpoint (requires authentication)

## 🐛 Troubleshooting

### Port already in use:
```bash
lsof -ti:3000 | xargs kill -9
```

### Cloudflared not found:
```bash
brew install cloudflare/cloudflare/cloudflared
```

### CORS errors:
Should not happen - fully configured in the server.

## 📝 License

MIT

## 🤝 Contributing

This is a demo/test server. Feel free to fork and modify for your needs!

## 🎉 Credits

Built for testing OAuth + MCP integration with Desktop Commander.

---

**Ready to test?** Run `npm run tunnel` and start connecting! 🚀
