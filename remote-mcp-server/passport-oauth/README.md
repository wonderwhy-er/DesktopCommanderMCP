# Passport OAuth MCP Implementation

🔐 **Complete OAuth 2.1 + MCP implementation using Passport.js**

A simplified, production-ready OAuth authorization server with MCP (Model Context Protocol) integration, built with Express.js and Passport.js. No external dependencies like Ory - everything runs locally with simple configuration.

## ✨ Features

- **🔐 OAuth 2.1 Compliant** - Full OAuth 2.1 + PKCE implementation
- **🎯 MCP Integration** - Native MCP Authorization Specification support
- **🚀 Passport.js** - Simple, well-tested authentication framework
- **📡 Server-Sent Events** - Real-time MCP communication via SSE
- **🛡️ Bearer Token Auth** - Secure token-based authentication
- **🧪 Demo Mode** - Zero-configuration development setup
- **🔄 Auto Token Refresh** - Seamless token lifecycle management
- **📊 Health Monitoring** - Comprehensive health checks and metrics
- **🐳 Docker Ready** - Container deployment support
- **✅ Test Suite** - Complete automated testing

## 🏗️ Architecture

```mermaid
graph TB
    subgraph "Claude Desktop"
        CD[Claude Desktop]
        SC[Stdio Connector]
    end
    
    subgraph "OAuth Infrastructure"
        OS[OAuth Server<br/>Port 4449]
        MS[MCP Server<br/>Port 3006]
    end
    
    subgraph "Remote Integration"
        RS[Remote Server<br/>Port 3002]
        DC[Desktop Commander]
    end
    
    CD -->|stdio| SC
    SC -->|OAuth 2.1 Flow| OS
    SC -->|Bearer Token| MS
    MS -->|Token Validation| OS
    MS -->|Authenticated Requests| RS
    RS -->|MCP Commands| DC
```

## 🚀 Quick Start

### 1. Installation

```bash
cd passport-oauth
npm install
```

### 2. Configuration

```bash
# Copy environment template (optional - works with defaults)
cp .env.example .env
```

### 3. Start Services

```bash
# Start all services
npm run dev
```

This starts:
- **OAuth Server**: http://localhost:4449 
- **MCP Server**: http://localhost:3006
- Auto-configured demo user and OAuth client

### 4. Test Setup

```bash
# Test OAuth flow
npm test

# Test MCP integration  
npm run test:mcp
```

### 5. Claude Desktop Integration

Update your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "passport-oauth-mcp": {
      "command": "node", 
      "args": ["/absolute/path/to/passport-oauth/claude-connector/stdio-server.js"],
      "env": {
        "OAUTH_BASE_URL": "http://localhost:4449",
        "MCP_BASE_URL": "http://localhost:3006"
      }
    }
  }
}
```

**⚠️ Important:** Use the absolute path to the stdio-server.js file.

## 🎯 Usage with Claude Desktop

1. **Start the servers:**
   ```bash
   npm run dev
   ```

2. **Restart Claude Desktop** completely

3. **Authenticate** in Claude Desktop:
   ```
   Please run the oauth_authenticate tool
   ```

4. **Complete OAuth flow** in the browser that opens automatically

5. **Use MCP tools**:
   ```
   Please run the oauth_status tool
   Please list available tools
   Please execute the echo tool with text "Hello OAuth MCP!"
   ```

## 📁 Project Structure

```
passport-oauth/
├── oauth-server/           # OAuth 2.1 Authorization Server
│   ├── server.js          # Main OAuth server
│   ├── routes/            # OAuth endpoints (authorize, token, etc.)
│   ├── middleware/        # Auth, PKCE, CORS middleware  
│   ├── models/            # Client, token, user storage
│   └── config/            # Passport configuration
├── mcp-server/            # MCP OAuth-Compliant Server
│   ├── server.js          # Main MCP server
│   ├── routes/            # MCP endpoints (SSE, message, health)
│   └── middleware/        # OAuth validation, SSE handling
├── claude-connector/      # Claude Desktop Integration
│   ├── stdio-server.js    # MCP stdio server for Claude Desktop
│   └── oauth-client.js    # OAuth client implementation
├── test/                  # Test Suite
│   ├── oauth-flow-test.js # OAuth 2.1 flow testing
│   └── mcp-integration-test.js # MCP integration testing
└── docs/                  # Documentation
    ├── SETUP.md           # Setup instructions
    └── API.md             # Complete API reference
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OAUTH_PORT` | OAuth server port | `4449` |
| `MCP_PORT` | MCP server port | `3006` |
| `DEMO_MODE` | Enable auto-approval | `true` |
| `SESSION_SECRET` | Session encryption | auto-generated |
| `JWT_SECRET` | JWT signing secret | auto-generated |

### OAuth Client Configuration

```env
DEFAULT_CLIENT_ID=mcp-client
DEFAULT_CLIENT_SECRET=mcp-secret
DEFAULT_REDIRECT_URI=http://localhost:8847/callback
DEFAULT_SCOPES=openid email profile mcp:tools
```

### Demo User (Development)

```env
DEMO_USER_EMAIL=test@example.com
DEMO_USER_PASSWORD=password123
```

## 🧪 Testing

### Automated Tests

```bash
# OAuth 2.1 compliance test
npm test

# MCP integration test
npm run test:mcp

# Both tests
npm run test:all
```

### Manual Testing

```bash
# Check server health
curl http://localhost:4449/health
curl http://localhost:3006/health

# OAuth metadata
curl http://localhost:4449/.well-known/oauth-authorization-server

# Register OAuth client
curl -X POST http://localhost:4449/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test Client",
    "redirect_uris": ["http://localhost:8080/callback"]
  }'
```

## 🔐 Security Features

### OAuth 2.1 Security

- **PKCE (RFC 7636)** - Proof Key for Code Exchange
- **State Parameter** - CSRF protection
- **Short-lived tokens** - Access tokens expire in 1 hour
- **Token introspection** - RFC 7662 compliance
- **Secure token storage** - JWT with signed claims

### MCP Security

- **Bearer token authentication** - All MCP endpoints protected
- **Scope-based authorization** - Fine-grained permissions
- **Token validation** - Real-time introspection
- **Rate limiting** - Protection against abuse
- **CORS protection** - Cross-origin request security

### Production Security

- **HTTPS enforcement** - TLS in production
- **Secure headers** - XSS, CSRF, clickjacking protection
- **Input validation** - Request sanitization
- **Audit logging** - Security event tracking
- **Token rotation** - Automatic refresh token rotation

## 📊 Monitoring & Health

### Health Endpoints

```bash
# Basic health check
GET /health

# Deep health check with dependencies
GET /health/deep

# OAuth server statistics
GET /health

# SSE connection status
GET /sse/status
```

### Monitoring Features

- **Real-time metrics** - Connection counts, token usage
- **Health dependencies** - OAuth server, remote server checks  
- **Resource monitoring** - Memory, uptime, performance
- **Connection tracking** - SSE client management
- **Error tracking** - Failed authentications, expired tokens

## 🚀 Production Deployment

### Environment Setup

```bash
# Disable demo mode
DEMO_MODE=false

# Configure secure secrets
SESSION_SECRET=your-256-bit-secret-here
JWT_SECRET=your-256-bit-secret-here

# Enable HTTPS
OAUTH_BASE_URL=https://oauth.yourdomain.com
MCP_BASE_URL=https://mcp.yourdomain.com

# Configure production database
POSTGRES_URL=postgresql://user:pass@host:5432/db
```

### Docker Deployment

```bash
# Build image
docker build -t passport-oauth-mcp .

# Run services
docker-compose up -d

# Health check
docker-compose ps
```

### Production Checklist

- [ ] **HTTPS configured** for all endpoints
- [ ] **Secrets generated** with crypto.randomBytes(32)
- [ ] **Database configured** (PostgreSQL recommended)
- [ ] **Rate limiting enabled** for public endpoints
- [ ] **Logging configured** for audit trail
- [ ] **Monitoring setup** for uptime and performance
- [ ] **Backup strategy** for client and token data
- [ ] **Security headers** configured in reverse proxy

## 🆚 Comparison with Ory

| Feature | Passport OAuth MCP | Ory Hydra/Kratos |
|---------|-------------------|-------------------|
| **Setup Complexity** | ✅ Simple | ❌ Complex |
| **Dependencies** | ✅ Node.js only | ❌ Multiple services |
| **Resource Usage** | ✅ Lightweight | ❌ Heavy |
| **Customization** | ✅ Full control | ❌ Limited |
| **Development** | ✅ Fast iteration | ❌ Slow setup |
| **OAuth 2.1** | ✅ Compliant | ✅ Compliant |
| **MCP Integration** | ✅ Native | ❌ Custom |
| **Production Ready** | ✅ Yes | ✅ Yes |

## 📚 Documentation

- **[Setup Guide](docs/SETUP.md)** - Detailed installation and configuration
- **[API Reference](docs/API.md)** - Complete endpoint documentation  
- **[OAuth 2.1 Spec](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1)** - OAuth specification
- **[MCP Spec](https://spec.modelcontextprotocol.io/)** - Model Context Protocol
- **[PKCE RFC 7636](https://tools.ietf.org/html/rfc7636)** - Proof Key for Code Exchange

## 🛠️ Development

### Scripts

```bash
npm run start        # Start OAuth server only
npm run mcp          # Start MCP server only  
npm run dev          # Start both servers
npm run claude       # Start Claude Desktop stdio server
npm test             # Run OAuth flow tests
npm run test:mcp     # Run MCP integration tests
```

### Debug Mode

```bash
export LOG_LEVEL=debug
export DEBUG_MODE=true
npm run dev
```

## 🤝 Contributing

1. **Fork the repository**
2. **Create feature branch**: `git checkout -b feature/amazing-feature`
3. **Make changes** with tests
4. **Run test suite**: `npm test && npm run test:mcp`
5. **Commit changes**: `git commit -m 'Add amazing feature'`
6. **Push to branch**: `git push origin feature/amazing-feature`
7. **Open Pull Request**

### Development Guidelines

- **Follow OAuth 2.1** specification compliance
- **Add tests** for new features
- **Update documentation** for API changes
- **Security first** - validate all inputs
- **Performance matters** - optimize for low latency

## 📝 License

MIT License - see LICENSE file for details.

## 🆘 Support & Troubleshooting

### Common Issues

**❌ "EADDRINUSE" Port Conflicts**
```bash
lsof -i :4449 :3006
kill -9 <PID>
```

**❌ "Authentication Required" in Claude Desktop**
- Enable `DEMO_MODE=true` in `.env`
- Run `oauth_authenticate` tool in Claude Desktop
- Check OAuth server is running on port 4449

**❌ "SSE Connection Failed"**
- Verify MCP server running on port 3006
- Check Bearer token in logs
- Ensure `mcp:tools` scope in token

### Getting Help

1. **Check [Setup Guide](docs/SETUP.md)** for detailed instructions
2. **Review logs** in console output
3. **Run test suite** to isolate issues
4. **Check [API docs](docs/API.md)** for endpoint details

---

**🎉 Ready to use OAuth 2.1 + MCP with Claude Desktop!**

This implementation provides a complete, production-ready OAuth authorization server with native MCP support, built on the solid foundation of Passport.js and Express.js. Perfect for developers who want OAuth security without the complexity of external dependencies.