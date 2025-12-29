# Passport OAuth MCP Setup Guide

Complete setup instructions for the MCP OAuth 2.1 implementation using Passport.js.

## 📋 Prerequisites

- **Node.js** v18.0.0 or higher
- **npm** or **yarn** package manager
- **PostgreSQL** (optional - uses in-memory storage by default)
- **Claude Desktop** application (for testing)

## 🚀 Quick Start

### 1. Installation

```bash
cd passport-oauth
npm install
```

### 2. Environment Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit configuration (optional for demo)
nano .env
```

### 3. Start Services

```bash
# Option A: Start all services together
npm run dev

# Option B: Start services separately
npm run start     # OAuth authorization server (port 4449)
npm run mcp       # MCP OAuth server (port 3006)
```

### 4. Test the Setup

```bash
# Run OAuth flow test
npm test

# Run MCP integration test
npm run test:mcp
```

### 5. Claude Desktop Integration

Update your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "passport-oauth-mcp": {
      "command": "node",
      "args": ["/path/to/passport-oauth/claude-connector/stdio-server.js"],
      "env": {
        "OAUTH_BASE_URL": "http://localhost:4449",
        "MCP_BASE_URL": "http://localhost:3006"
      }
    }
  }
}
```

## 🔧 Detailed Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OAUTH_PORT` | OAuth server port | `4449` | No |
| `MCP_PORT` | MCP server port | `3006` | No |
| `SESSION_SECRET` | Session encryption key | - | Yes |
| `JWT_SECRET` | JWT signing secret | - | Yes |
| `DEMO_MODE` | Enable demo mode | `true` | No |
| `DEMO_USER_EMAIL` | Demo user email | `test@example.com` | No |
| `DEMO_USER_PASSWORD` | Demo user password | `password123` | No |

### OAuth Configuration

```env
# OAuth Server
OAUTH_HOST=localhost
OAUTH_PORT=4449
OAUTH_BASE_URL=http://localhost:4449

# Client Defaults
DEFAULT_CLIENT_ID=mcp-client
DEFAULT_CLIENT_SECRET=mcp-secret-change-in-production
DEFAULT_REDIRECT_URI=http://localhost:8847/callback
DEFAULT_SCOPES=openid email profile mcp:tools

# Security
SESSION_SECRET=your-session-secret-change-in-production
JWT_SECRET=your-jwt-secret-change-in-production
DEMO_MODE=true
```

### MCP Server Configuration

```env
# MCP Server
MCP_HOST=localhost
MCP_PORT=3006
MCP_BASE_URL=http://localhost:3006

# Remote Integration (optional)
REMOTE_SERVER_URL=http://localhost:3002
REMOTE_SERVER_ENDPOINT=/api/mcp/execute
```

## 🏗 Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Claude        │    │   OAuth         │    │   MCP OAuth     │
│   Desktop       │    │   Server        │    │   Server        │
│                 │    │                 │    │                 │
│   Port: stdio   │    │   Port: 4449    │    │   Port: 3006    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         └───── OAuth Flow ──────┤                       │
                                 │                       │
                                 └── Token Validation ───┘

┌─────────────────┐    ┌─────────────────┐
│   Remote        │    │   Target        │
│   Server        │    │   Machine       │ 
│                 │    │                 │
│   Port: 3002    │    │   Desktop       │
│                 │    │   Commander     │
└─────────────────┘    └─────────────────┘
         │                       │
         └── MCP Execution ──────┘
```

## 🔐 Authentication Flow

### 1. Initial Setup

1. **Start OAuth Server** - Provides OAuth 2.1 authorization
2. **Start MCP Server** - Provides OAuth-protected MCP endpoints
3. **Configure Claude Desktop** - Points to stdio server

### 2. OAuth Flow

1. **Client Registration** - Stdio server registers with OAuth server
2. **Authorization Request** - Browser opens for user consent
3. **Authorization Grant** - User approves application access
4. **Token Exchange** - Authorization code exchanged for access token
5. **Token Storage** - Access token cached for MCP requests

### 3. MCP Communication

1. **Tool Requests** - Claude Desktop requests available tools
2. **Token Validation** - MCP server validates Bearer token via introspection
3. **Request Forwarding** - Authenticated requests forwarded to remote server
4. **Response Handling** - Results returned to Claude Desktop

## 📚 API Reference

### OAuth Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/oauth-authorization-server` | GET | OAuth metadata |
| `/authorize` | GET | Authorization endpoint |
| `/token` | POST | Token exchange endpoint |
| `/register` | POST | Client registration |
| `/introspect` | POST | Token introspection |
| `/revoke` | POST | Token revocation |

### MCP Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/sse` | GET | Server-sent events |
| `/message` | POST | MCP message handling |
| `/tools` | GET | Available tools |
| `/execute` | POST | Tool execution |

## 🧪 Testing

### Automated Tests

```bash
# OAuth flow test
npm test
# Expected: All OAuth 2.1 endpoints working

# MCP integration test  
npm run test:mcp
# Expected: End-to-end MCP + OAuth integration working

# Individual component tests
node test/oauth-flow-test.js
node test/mcp-integration-test.js
```

### Manual Testing

```bash
# Test OAuth server health
curl http://localhost:4449/health

# Test OAuth metadata
curl http://localhost:4449/.well-known/oauth-authorization-server

# Test MCP server health  
curl http://localhost:3006/health

# Test client registration
curl -X POST http://localhost:4449/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test Client",
    "redirect_uris": ["http://localhost:8080/callback"]
  }'
```

### Claude Desktop Testing

1. **Start Services**:
   ```bash
   npm run dev
   ```

2. **Update Claude Config** with stdio server path

3. **Restart Claude Desktop** completely

4. **Test Commands**:
   ```
   Please run the oauth_status tool
   Please authenticate using oauth_authenticate tool
   Please list available tools
   ```

## 🔧 Troubleshooting

### Common Issues

**❌ "EADDRINUSE" Errors**
```bash
# Check what's using the ports
lsof -i :4449
lsof -i :3006

# Kill conflicting processes
kill -9 <PID>
```

**❌ "Authentication Required" Errors**
- Ensure `DEMO_MODE=true` in `.env`
- Verify OAuth server is running
- Check token hasn't expired
- Run `oauth_authenticate` tool in Claude Desktop

**❌ "Token Validation Failed" Errors**
- Check OAuth server connectivity
- Verify JWT_SECRET is consistent
- Check token introspection endpoint
- Restart OAuth server

**❌ "SSE Connection Failed" Errors**
- Verify MCP server is running on correct port
- Check Bearer token in Authorization header
- Confirm required scopes (`mcp:tools`)
- Check CORS configuration

### Debug Mode

Enable debug logging:

```bash
export LOG_LEVEL=debug
export DEBUG_MODE=true
npm run dev
```

### Health Checks

```bash
# Comprehensive health check
curl http://localhost:3006/health/deep

# OAuth server status
curl http://localhost:4449/health

# SSE connection status
curl http://localhost:3006/sse/status
```

## 🚀 Production Deployment

### Environment Setup

1. **Disable Demo Mode**:
   ```env
   DEMO_MODE=false
   ```

2. **Secure Secrets**:
   ```env
   SESSION_SECRET=<256-bit-random-secret>
   JWT_SECRET=<256-bit-random-secret>
   DEFAULT_CLIENT_SECRET=<secure-client-secret>
   ```

3. **Configure Database**:
   ```env
   POSTGRES_URL=postgresql://user:pass@host:5432/db
   ```

4. **Enable HTTPS**:
   ```env
   OAUTH_BASE_URL=https://oauth.yourdomain.com
   MCP_BASE_URL=https://mcp.yourdomain.com
   ```

### Security Considerations

- **Use HTTPS** in production
- **Implement rate limiting** on OAuth endpoints
- **Enable audit logging** for security events
- **Use external database** instead of in-memory storage
- **Implement proper CORS** policies
- **Monitor token usage** and implement alerting
- **Regular security updates** for dependencies

### Monitoring

- **Health endpoints** for uptime monitoring
- **Metrics collection** for performance monitoring  
- **Log aggregation** for debugging and security
- **Token usage analytics** for optimization

## 📖 Additional Resources

- [OAuth 2.1 Specification](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1)
- [PKCE Specification (RFC 7636)](https://tools.ietf.org/html/rfc7636)
- [Token Introspection (RFC 7662)](https://tools.ietf.org/html/rfc7662)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Passport.js Documentation](http://www.passportjs.org/)

## 🆘 Support

For issues and questions:

1. **Check the troubleshooting section** above
2. **Review server logs** in `logs/` directory
3. **Run test suite** to identify specific problems
4. **Verify configuration** against this guide
5. **Check dependencies** are up to date