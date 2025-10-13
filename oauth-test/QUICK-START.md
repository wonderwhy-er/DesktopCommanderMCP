# OAuth Quick Reference

## Commands

```bash
# Install
npm install

# Test everything (automated)
./test-flow.sh

# Or run servers manually:
npm run auth-server      # Terminal 1
npm run resource-server   # Terminal 2
npm run client           # Terminal 3
# Then: http://localhost:3000/start
```

## Credentials
- Username: `admin`
- Password: `password123`

## Endpoints

| Server | Port | Endpoint | Purpose |
|--------|------|----------|---------|
| Auth | 3001 | `/.well-known/oauth-authorization-server` | Metadata |
| Auth | 3001 | `GET /authorize` | Login page |
| Auth | 3001 | `POST /authorize` | Process login |
| Auth | 3001 | `POST /token` | Get token |
| Resource | 3002 | `/.well-known/oauth-protected-resource` | Metadata |
| Resource | 3002 | `POST /mcp/tools` | Protected endpoint |
| Client | 3000 | `GET /start` | Begin flow |
| Client | 3000 | `GET /callback` | Receive code |

## The Flow (5 Steps)

```
1. Client → Auth: "Where to login?"
2. User → Auth: Enters username/password  
3. Auth → Client: Returns authorization CODE
4. Client → Auth: Exchanges CODE for TOKEN
5. Client → Resource: Uses TOKEN to access data
```

## What's in Each File

### auth-server.js
- Users storage (Map)
- Authorization codes storage (Map)
- Tokens storage (Map)
- Login page HTML
- Token generation logic

### resource-server.js  
- Protected /mcp/tools endpoint
- Token validation via auth server
- Protected resource metadata

### client.js
- Start OAuth flow
- Handle callback redirect
- Exchange code for token
- Use token to call protected resource

## Key Concepts

**Authorization Code**: Temporary proof user logged in
- Lifetime: 1 minute
- Single use only
- Goes through browser

**Access Token**: The actual key to resources
- Lifetime: 1 hour  
- Multiple use
- Goes server-to-server

## Testing

### Test valid flow:
```bash
./test-flow.sh
```

### Test metadata:
```bash
curl http://localhost:3001/.well-known/oauth-authorization-server | jq
curl http://localhost:3002/.well-known/oauth-protected-resource | jq
```

### Test protected endpoint (need real token):
```bash
# Get token from browser flow first, then:
curl -X POST http://localhost:3002/mcp/tools \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool_name": "test"}'
```

### Test without token (should fail):
```bash
curl -X POST http://localhost:3002/mcp/tools \
  -H "Content-Type: application/json" \
  -d '{"tool_name": "test"}'
# Returns: {"error": "No token provided"}
```

## File Structure

```
oauth-test/
├── 📦 package.json         
├── 🔐 auth-server.js       (130 lines) Login & tokens
├── 🛠️  resource-server.js   (60 lines) Protected MCP
├── 🌐 client.js            (140 lines) OAuth client
├── 📖 README.md            Full guide
├── 📊 FLOW.md              Visual diagram
├── 🚀 start-all.sh         Launch script
└── 🧪 test-flow.sh         Automated test
```

## Troubleshooting

**Port already in use:**
```bash
# Find process
lsof -ti:3000 -ti:3001 -ti:3002

# Kill processes
kill $(lsof -ti:3000 -ti:3001 -ti:3002)
```

**Servers not starting:**
```bash
# Check Node version (need 18+)
node --version

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

**Browser not opening:**
```bash
# Manually open:
open http://localhost:3000/start  # macOS
```

## Next Steps

1. ✅ Run the minimal version
2. ✅ Understand the flow
3. 📖 Read about JWT (for production tokens)
4. 📖 Read about PKCE (for security)
5. 🔨 Add JWT to this codebase
6. 🔨 Add PKCE to this codebase
7. 🔨 Add SQLite storage
8. 🚀 Integrate into Desktop Commander

## Resources

- OAuth 2.1 Spec: https://oauth.net/2.1/
- MCP Authorization: https://modelcontextprotocol.io/specification/draft/basic/authorization
- JWT.io: https://jwt.io/
- Christian Posta's Guide: https://www.solo.io/blog/understanding-mcp-authorization-step-by-step-part-one
